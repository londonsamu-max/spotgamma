#!/usr/bin/env python3
"""
Multi-Head PPO Training on Apple Metal GPU
-------------------------------------------
Trains the multi-head PPO agent using TensorFlow with Metal GPU acceleration.
Reads training data from the Node.js server, trains the model on GPU,
and exports weights in JSON format for TensorFlow.js to load.

Usage:
  python3 scripts/gpu-train-multihead.py [--passes 5000] [--lr 0.0008] [--export]

The script:
  1. Reads episode data from data/training-episodes.json (exported by Node.js)
  2. Builds the same multi-head architecture (5 heads: direction, risk, entry, sizing, session)
  3. Trains using PPO on Metal GPU (~10x faster than CPU)
  4. Exports weights to data/ppo-multihead-model/ for Node.js to load
"""

import json
import os
import sys
import time
import argparse
import numpy as np

os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'  # Suppress TF warnings

import tensorflow as tf
from tensorflow import keras

# ── Config ──────────────────────────────────────────────────────────────────

STATE_SIZE = 42
HEAD_CONFIGS = {
    "direction": {"size": 3, "labels": ["SKIP", "LONG", "SHORT"]},
    "risk":      {"size": 3, "labels": ["tight", "normal", "wide"]},
    "entry":     {"size": 3, "labels": ["at_market", "at_level", "at_wall"]},
    "sizing":    {"size": 3, "labels": ["small", "medium", "full"]},
    "session":   {"size": 2, "labels": ["trade_now", "wait"]},
}
HEAD_NAMES = list(HEAD_CONFIGS.keys())
TOTAL_OUTPUTS = sum(h["size"] for h in HEAD_CONFIGS.values())  # 14

# Rewards by risk level
REWARDS = {
    "tight":  {"tp3": 5.0, "tp2": 3.0, "tp1": 1.5, "sl": -1.5, "cancelled": 0.0},
    "normal": {"tp3": 4.0, "tp2": 2.5, "tp1": 1.0, "sl": -2.0, "cancelled": 0.0},
    "wide":   {"tp3": 3.5, "tp2": 2.0, "tp1": 0.8, "sl": -2.5, "cancelled": 0.0},
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
DATA_DIR = os.path.join(PROJECT_DIR, "data")
MODEL_DIR = os.path.join(DATA_DIR, "ppo-multihead-model")
EPISODES_FILE = os.path.join(DATA_DIR, "training-episodes.json")
STATE_FILE = os.path.join(DATA_DIR, "ppo-multihead-state.json")


# ── State Normalization (must match Node.js exactly) ────────────────────────

def normalize_state(ep):
    """Convert episode dict to normalized 42-element feature vector."""
    clamp = lambda v, lo, hi: max(lo, min(hi, v))

    s = [
        clamp(ep.get("gammaTilt", 0) * 10, -2, 2),
        clamp(ep.get("deltaTilt", 0) * 10, -2, 2),
        ep.get("gammaRatioNorm", 0.5) * 2 - 1,
        ep.get("deltaRatioNorm", 0.5) * 2 - 1,
        ep.get("ivRank", 0.5) * 2 - 1,
        clamp(ep.get("neSkew", 0) * 10, -2, 2),
        clamp(ep.get("vrp", 0) * 10, -2, 2),
        clamp(ep.get("momentum5d", 0) / 2, -3, 3),
        clamp(ep.get("momentum20d", 0) / 5, -3, 3),
        (ep.get("rsi14", 50) - 50) / 50,
        (ep.get("squeezeSig", 50) - 50) / 50,
        ep.get("positionFactor", 0),
        clamp((ep.get("putCallRatio", 1) - 1) * 2, -2, 2),
        clamp(ep.get("volumeRatio", 1) - 1, -2, 2),
        clamp((ep.get("atrPct", 1) - 1) / 0.5, -2, 2),
        clamp(ep.get("priceVsCallWall", 0) / 2, -2, 2),
        clamp(ep.get("priceVsPutWall", 0) / 2, -2, 2),
        ep.get("timeNorm", 0.5) * 2 - 1,
        ep.get("isOPEX", 0) * 2 - 1,
        ep.get("cfdIdx", 1) - 1,
        # Phase 1 features
        clamp(ep.get("gammaWallDist", 0) / 2, -3, 3),
        ep.get("gammaConcentration", 0) * 2 - 1,
        ep.get("callGammaRatio", 0.5) * 2 - 1,
        clamp(ep.get("nextExpGamma", 0) * 10, -2, 2),
        clamp(ep.get("nextExpDelta", 0) * 10, -2, 2),
        ep.get("tapeBullishPct", 0.5) * 2 - 1,
        ep.get("tapePremiumRatio", 0.5) * 2 - 1,
        ep.get("tapeGammaSkew", 0),
        # Phase 2 features
        ep.get("candleBodyRatio", 0.5) * 2 - 1,
        ep.get("candleTrend", 0),
        clamp(ep.get("candleVolSpike", 1) - 1, -2, 2),
        clamp((ep.get("impliedMovePct", 1) - 1) / 0.5, -2, 2),
        clamp(ep.get("impliedMoveUsage", 1) - 1, -2, 2),
        clamp(ep.get("comboLevelDist", 0) / 2, -3, 3),
        ep.get("comboLevelSide", 0),
        clamp(ep.get("absGammaPeakDist", 0) / 2, -3, 3),
        ep.get("absGammaSkew", 0),
        ep.get("hiroNorm", 0),
        clamp(ep.get("hiroAccel", 0), -2, 2),
        clamp(ep.get("volumeProfilePOC", 0) / 2, -3, 3),
        ep.get("volumeImbalance", 0.5) * 2 - 1,
        ep.get("dayOfWeek", 0),
    ]
    assert len(s) == STATE_SIZE, f"Expected {STATE_SIZE} features, got {len(s)}"
    return s


# ── Multi-Head Actor Model ──────────────────────────────────────────────────

def create_actor():
    """Create multi-head actor with shared backbone + 5 independent heads."""
    inp = keras.Input(shape=(STATE_SIZE,))

    # Shared backbone (wider for 42 features)
    x = keras.layers.Dense(192, activation="relu", kernel_initializer="he_normal")(inp)
    x = keras.layers.Dense(96, activation="relu", kernel_initializer="he_normal")(x)
    shared = keras.layers.Dense(64, activation="relu", kernel_initializer="he_normal")(x)

    # Independent heads
    outputs = []
    for name in HEAD_NAMES:
        size = HEAD_CONFIGS[name]["size"]
        h = keras.layers.Dense(24, activation="relu", kernel_initializer="he_normal", name=f"{name}_hidden")(shared)
        out = keras.layers.Dense(size, activation="softmax", kernel_initializer="glorot_normal", name=f"{name}_out")(h)
        outputs.append(out)

    # Concatenate all heads → [batch, 14]
    concat = keras.layers.Concatenate(name="all_heads")(outputs) if len(outputs) > 1 else outputs[0]

    return keras.Model(inputs=inp, outputs=concat)


def create_critic():
    """Create critic network."""
    model = keras.Sequential([
        keras.layers.Dense(192, activation="relu", kernel_initializer="he_normal", input_shape=(STATE_SIZE,)),
        keras.layers.Dense(96, activation="relu", kernel_initializer="he_normal"),
        keras.layers.Dense(48, activation="relu", kernel_initializer="he_normal"),
        keras.layers.Dense(1, kernel_initializer="glorot_normal"),
    ])
    return model


# ── Split head probabilities ────────────────────────────────────────────────

def split_head_probs(flat_probs):
    """Split concatenated [14] vector into per-head probability arrays."""
    result = {}
    offset = 0
    for name in HEAD_NAMES:
        size = HEAD_CONFIGS[name]["size"]
        result[name] = flat_probs[offset:offset + size]
        offset += size
    return result


# ── Outcome mapping (same as Node.js historical-simulator) ──────────────────

def map_outcome(direction_action, price_delta_pct, atr_pct, day_high, day_low, price):
    """Map price movement to outcome (tp1/tp2/tp3/sl) using ATR-calibrated thresholds."""
    safe_atr = max(atr_pct, 0.3)
    tp3_thresh = safe_atr * 1.20
    tp2_thresh = safe_atr * 0.55
    tp1_thresh = safe_atr * 0.25
    sl_thresh  = safe_atr * 0.40

    if direction_action == 0:  # SKIP
        return "cancelled"

    is_long = direction_action == 1  # 1=LONG in direction head

    # Intraday high/low check
    if day_high > 0 and day_low > 0 and price > 0:
        intraday_up = (day_high - price) / price * 100
        intraday_down = (price - day_low) / price * 100
        move_for = intraday_up if is_long else intraday_down
        move_against = intraday_down if is_long else intraday_up
    else:
        move_for = abs(price_delta_pct) if ((is_long and price_delta_pct > 0) or (not is_long and price_delta_pct < 0)) else 0
        move_against = abs(price_delta_pct) if ((is_long and price_delta_pct < 0) or (not is_long and price_delta_pct > 0)) else 0

    # Check SL first (if price moved against us enough)
    if move_against >= sl_thresh:
        return "sl"
    # Then check TPs
    if move_for >= tp3_thresh:
        return "tp3"
    elif move_for >= tp2_thresh:
        return "tp2"
    elif move_for >= tp1_thresh:
        return "tp1"
    else:
        return "cancelled"


# ── PPO Training Loop ───────────────────────────────────────────────────────

def train_ppo(episodes, passes=5000, lr=8e-4, clip_ratio=0.2, entropy_coeff=0.03,
              gamma_discount=0.99, lam=0.95, batch_size=256, epochs_per_update=2,
              train_split=0.8):
    """Train multi-head PPO on GPU."""

    print(f"\n{'='*60}")
    print(f"  Multi-Head PPO Training on Metal GPU")
    print(f"  Episodes: {len(episodes)}")
    print(f"  Passes: {passes}")
    print(f"  State size: {STATE_SIZE}")
    print(f"  Heads: {', '.join(HEAD_NAMES)}")
    print(f"  Learning rate: {lr}")
    print(f"{'='*60}\n")

    # Sort by date for walk-forward split
    episodes.sort(key=lambda e: e.get("date", ""))
    split_idx = int(len(episodes) * train_split)
    train_eps = episodes[:split_idx]
    test_eps = episodes[split_idx:]
    print(f"Train: {len(train_eps)} episodes, Test: {len(test_eps)} episodes")
    print(f"Train dates: {train_eps[0].get('date', '?')} → {train_eps[-1].get('date', '?')}")
    print(f"Test dates:  {test_eps[0].get('date', '?')} → {test_eps[-1].get('date', '?')}")

    # Normalize all states
    train_states = np.array([normalize_state(ep) for ep in train_eps], dtype=np.float32)
    test_states  = np.array([normalize_state(ep) for ep in test_eps], dtype=np.float32)

    # Create models
    actor = create_actor()
    critic = create_critic()
    actor_optimizer = keras.optimizers.Adam(learning_rate=lr)
    critic_optimizer = keras.optimizers.Adam(learning_rate=lr)

    # Pre-compute head offsets for slicing
    head_offsets = []
    off = 0
    for name in HEAD_NAMES:
        size = HEAD_CONFIGS[name]["size"]
        head_offsets.append((name, off, size))
        off += size

    # Pre-compute vectorized episode data for fast outcome mapping
    ep_price_delta = np.array([ep.get("priceDeltaPct", 0) for ep in train_eps], dtype=np.float32)
    ep_atr = np.array([max(ep.get("atrPct", 1.0), 0.3) for ep in train_eps], dtype=np.float32)
    ep_day_high = np.array([ep.get("dayHigh", 0) for ep in train_eps], dtype=np.float32)
    ep_day_low = np.array([ep.get("dayLow", 0) for ep in train_eps], dtype=np.float32)
    ep_price = np.array([max(ep.get("price", 1), 1) for ep in train_eps], dtype=np.float32)

    # Reward lookup tables [risk_idx][outcome_idx] → reward
    # outcomes: 0=cancelled, 1=tp1, 2=tp2, 3=tp3, 4=sl
    reward_table = np.array([
        [0.0, 1.5, 3.0, 5.0, -1.5],  # tight
        [0.0, 1.0, 2.5, 4.0, -2.0],  # normal
        [0.0, 0.8, 2.0, 3.5, -2.5],  # wide
    ], dtype=np.float32)

    start_time = time.time()
    win_rates = []
    total_wins = 0
    total_losses = 0
    N_train = len(train_eps)

    for pass_num in range(1, passes + 1):
        # ── Vectorized forward pass (GPU) ──
        batch_probs = actor.predict(train_states, verbose=0, batch_size=N_train)  # [N, 14]
        batch_values = critic.predict(train_states, verbose=0, batch_size=N_train).squeeze()  # [N]

        # ── Vectorized action sampling (numpy) ──
        # Sample from each head in bulk
        sampled_actions = {}
        sampled_logprobs = {}
        for name, offset, size in head_offsets:
            probs = batch_probs[:, offset:offset+size]  # [N, size]
            probs = np.maximum(probs, 1e-8)
            probs = probs / probs.sum(axis=1, keepdims=True)
            # Vectorized sampling via cumulative sum
            cum_probs = np.cumsum(probs, axis=1)
            rands = np.random.random(N_train)[:, None]
            actions = (cum_probs < rands).sum(axis=1).astype(np.int32)
            actions = np.minimum(actions, size - 1)
            sampled_actions[name] = actions
            chosen_probs = probs[np.arange(N_train), actions]
            sampled_logprobs[name] = np.log(np.maximum(chosen_probs, 1e-8))

        dir_actions = sampled_actions["direction"]  # [N]
        risk_actions = sampled_actions["risk"]
        session_actions = sampled_actions["session"]
        sizing_actions = sampled_actions["sizing"]

        # ── Vectorized outcome mapping ──
        is_long = dir_actions == 1
        is_short = dir_actions == 2
        is_skip = dir_actions == 0

        # Intraday moves
        has_hl = (ep_day_high > 0) & (ep_day_low > 0)
        intraday_up = np.where(has_hl, (ep_day_high - ep_price) / ep_price * 100, np.abs(ep_price_delta))
        intraday_down = np.where(has_hl, (ep_price - ep_day_low) / ep_price * 100, np.abs(ep_price_delta))

        move_for = np.where(is_long, intraday_up, np.where(is_short, intraday_down, 0))
        move_against = np.where(is_long, intraday_down, np.where(is_short, intraday_up, 0))

        # ATR thresholds
        tp3_t = ep_atr * 1.20
        tp2_t = ep_atr * 0.55
        tp1_t = ep_atr * 0.25
        sl_t  = ep_atr * 0.40

        # Outcome: 0=cancelled, 1=tp1, 2=tp2, 3=tp3, 4=sl
        outcome_idx = np.zeros(N_train, dtype=np.int32)  # default cancelled
        outcome_idx = np.where(move_for >= tp1_t, 1, outcome_idx)
        outcome_idx = np.where(move_for >= tp2_t, 2, outcome_idx)
        outcome_idx = np.where(move_for >= tp3_t, 3, outcome_idx)
        outcome_idx = np.where(move_against >= sl_t, 4, outcome_idx)  # SL overrides TPs
        outcome_idx = np.where(is_skip, 0, outcome_idx)

        # ── Vectorized reward ──
        rewards = reward_table[risk_actions, outcome_idx]

        # Session wait penalty/bonus
        big_move = np.abs(ep_price_delta) > ep_atr * 0.5
        is_wait = session_actions == 1
        rewards = np.where(is_wait & big_move, -0.5, np.where(is_wait, 0.1, rewards))

        # Sizing multiplier
        is_full = sizing_actions == 2   # full
        is_small = sizing_actions == 0  # small
        is_win = (outcome_idx >= 1) & (outcome_idx <= 3)
        rewards = np.where(is_full & is_win, rewards * 1.2, rewards)
        rewards = np.where(is_full & ~is_win & ~is_wait, rewards * 1.3, rewards)
        rewards = np.where(is_small & is_win, rewards * 0.8, rewards)
        rewards = np.where(is_small & ~is_win & ~is_wait, rewards * 0.7, rewards)

        # Stats
        pass_wins = int(is_win.sum())
        pass_losses = int((outcome_idx == 4).sum())
        pass_skipped = int(is_skip.sum() + (outcome_idx == 0).sum())
        total_wins += pass_wins
        total_losses += pass_losses

        # ── Prepare tensors for PPO update ──
        states_t = tf.constant(train_states, dtype=tf.float32)
        rewards_t = rewards
        values_t = batch_values

        # Compute advantages (simplified — each episode is independent)
        advantages = rewards_t - values_t
        returns = rewards_t  # single-step, no discounting between independent episodes

        # Normalize advantages
        adv_std = advantages.std() + 1e-8
        advantages = (advantages - advantages.mean()) / adv_std

        advantages_t = tf.constant(advantages, dtype=tf.float32)
        returns_tf = tf.constant(returns, dtype=tf.float32)

        # Old log probs (sum across heads) — vectorized
        old_logprob_sum = np.zeros(N_train, dtype=np.float32)
        for name in HEAD_NAMES:
            old_logprob_sum += sampled_logprobs[name]
        old_logprob_sums = tf.constant(old_logprob_sum, dtype=tf.float32)

        # Per-head action tensors
        head_action_tensors = {}
        for name in HEAD_NAMES:
            head_action_tensors[name] = tf.constant(sampled_actions[name], dtype=tf.int32)

        # PPO update epochs
        for epoch in range(epochs_per_update):
            perm = np.random.permutation(N_train)

            for start in range(0, N_train, batch_size):
                end = min(start + batch_size, N_train)
                if end - start < 16:
                    continue
                batch_idx = perm[start:end]
                B = len(batch_idx)

                b_states = tf.gather(states_t, batch_idx)
                b_advantages = tf.gather(advantages_t, batch_idx)
                b_returns = tf.gather(returns_tf, batch_idx)
                b_old_logprobs = tf.gather(old_logprob_sums, batch_idx)

                # Actor update
                with tf.GradientTape() as tape:
                    flat_probs = actor(b_states, training=True)  # [B, 14]

                    new_logprob_sum = tf.zeros([B])
                    entropy_sum = tf.zeros([B])

                    for name, offset, size in head_offsets:
                        head_probs = flat_probs[:, offset:offset + size]
                        b_actions = tf.gather(head_action_tensors[name], batch_idx)
                        one_hot = tf.one_hot(b_actions, size)
                        chosen_prob = tf.reduce_sum(head_probs * one_hot, axis=1)
                        chosen_prob = tf.clip_by_value(chosen_prob, 1e-8, 1.0)
                        log_prob = tf.math.log(chosen_prob)
                        new_logprob_sum = new_logprob_sum + log_prob

                        safe_probs = tf.clip_by_value(head_probs, 1e-8, 1.0)
                        head_entropy = -tf.reduce_sum(safe_probs * tf.math.log(safe_probs), axis=1)
                        entropy_sum = entropy_sum + head_entropy

                    ratio = tf.exp(new_logprob_sum - b_old_logprobs)
                    surr1 = ratio * b_advantages
                    surr2 = tf.clip_by_value(ratio, 1 - clip_ratio, 1 + clip_ratio) * b_advantages
                    policy_loss = -tf.reduce_mean(tf.minimum(surr1, surr2))
                    entropy_bonus = -entropy_coeff * tf.reduce_mean(entropy_sum)
                    actor_loss = policy_loss + entropy_bonus

                actor_grads = tape.gradient(actor_loss, actor.trainable_variables)
                actor_optimizer.apply_gradients(zip(actor_grads, actor.trainable_variables))

                # Critic update
                with tf.GradientTape() as tape:
                    vals = tf.squeeze(critic(b_states, training=True))
                    critic_loss = 0.5 * tf.reduce_mean(tf.square(vals - b_returns))

                critic_grads = tape.gradient(critic_loss, critic.trainable_variables)
                critic_optimizer.apply_gradients(zip(critic_grads, critic.trainable_variables))

        resolved = pass_wins + pass_losses
        wr = pass_wins / resolved * 100 if resolved > 0 else 0
        total_wins += pass_wins
        total_losses += pass_losses
        win_rates.append(wr)

        if pass_num % 10 == 0 or pass_num == 1:
            elapsed = time.time() - start_time
            eta = elapsed / pass_num * (passes - pass_num)
            print(f"Pass {pass_num:>5}/{passes}: WR={wr:.1f}% wins={pass_wins} losses={pass_losses} skip={pass_skipped} | {elapsed:.0f}s elapsed, ETA {eta:.0f}s")

    # ── Walk-forward test ───────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print(f"  Walk-Forward Validation ({len(test_eps)} episodes)")
    print(f"{'='*60}")

    test_probs = actor.predict(test_states, verbose=0)
    test_wins = 0
    test_losses = 0
    test_skipped = 0

    for i, ep in enumerate(test_eps):
        hp = split_head_probs(test_probs[i])

        # Greedy selection (best action per head)
        direction_action = int(np.argmax(hp["direction"]))
        risk_action = int(np.argmax(hp["risk"]))
        session_action = int(np.argmax(hp["session"]))

        if direction_action == 0 or session_action == 1:
            test_skipped += 1
            continue

        risk_label = HEAD_CONFIGS["risk"]["labels"][risk_action]
        outcome = map_outcome(
            direction_action,
            ep.get("priceDeltaPct", 0),
            ep.get("atrPct", 1.0),
            ep.get("dayHigh", 0),
            ep.get("dayLow", 0),
            ep.get("price", 1),
        )

        if outcome in ["tp1", "tp2", "tp3"]:
            test_wins += 1
        elif outcome == "sl":
            test_losses += 1

    test_resolved = test_wins + test_losses
    test_wr = test_wins / test_resolved * 100 if test_resolved > 0 else 0
    print(f"Walk-forward WR: {test_wr:.1f}% ({test_wins}W / {test_losses}L, {test_skipped} skipped)")

    elapsed = time.time() - start_time
    print(f"\nTotal training time: {elapsed:.1f}s ({elapsed/60:.1f} min)")

    return actor, critic, {
        "winRate": wr,
        "walkForwardWR": test_wr,
        "testWins": test_wins,
        "testLosses": test_losses,
        "totalEpisodes": total_wins + total_losses,
        "totalWins": total_wins,
        "totalLosses": total_losses,
        "durationSec": elapsed,
        "passes": passes,
    }


# ── Export weights to JSON (for TensorFlow.js) ──────────────────────────────

def export_weights(actor, critic, stats):
    """Export model weights as JSON arrays for Node.js to load."""
    os.makedirs(MODEL_DIR, exist_ok=True)

    # Actor weights
    actor_weights = []
    for w in actor.get_weights():
        actor_weights.append({
            "name": "",  # TF.js doesn't need names
            "shape": list(w.shape),
            "data": w.flatten().tolist(),
        })

    # Critic weights
    critic_weights = []
    for w in critic.get_weights():
        critic_weights.append({
            "name": "",
            "shape": list(w.shape),
            "data": w.flatten().tolist(),
        })

    actor_path = os.path.join(MODEL_DIR, "actor-weights.json")
    critic_path = os.path.join(MODEL_DIR, "critic-weights.json")

    with open(actor_path, "w") as f:
        json.dump(actor_weights, f)
    with open(critic_path, "w") as f:
        json.dump(critic_weights, f)

    # Save state
    state = {
        "totalEpisodes": stats["totalEpisodes"],
        "totalWins": stats["totalWins"],
        "totalLosses": stats["totalLosses"],
        "trainingLoss": [],
        "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "gpuTrained": True,
        "walkForwardWR": stats["walkForwardWR"],
        "passes": stats["passes"],
    }
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

    actor_size = os.path.getsize(actor_path)
    critic_size = os.path.getsize(critic_path)
    print(f"\nExported weights:")
    print(f"  Actor:  {actor_path} ({actor_size/1024:.0f} KB)")
    print(f"  Critic: {critic_path} ({critic_size/1024:.0f} KB)")
    print(f"  State:  {STATE_FILE}")


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Train Multi-Head PPO on Metal GPU")
    parser.add_argument("--passes", type=int, default=5000, help="Number of training passes")
    parser.add_argument("--lr", type=float, default=8e-4, help="Learning rate")
    parser.add_argument("--batch-size", type=int, default=256, help="Batch size")
    parser.add_argument("--clip", type=float, default=0.2, help="PPO clip ratio")
    parser.add_argument("--entropy", type=float, default=0.03, help="Entropy coefficient")
    parser.add_argument("--no-export", action="store_true", help="Don't export weights")
    args = parser.parse_args()

    # Check GPU
    gpus = tf.config.list_physical_devices("GPU")
    if gpus:
        print(f"Using Metal GPU: {gpus[0]}")
    else:
        print("WARNING: No GPU found, using CPU (will be slower)")

    # Load episodes
    if not os.path.exists(EPISODES_FILE):
        print(f"ERROR: {EPISODES_FILE} not found!")
        print("First export episodes from the Node.js server:")
        print("  curl -s http://localhost:3000/api/trpc/market.exportTrainingEpisodes | python3 -c 'import sys,json; d=json.loads(sys.stdin.read()); json.dump(d[\"result\"][\"data\"][\"json\"], open(\"data/training-episodes.json\",\"w\"))'")
        sys.exit(1)

    with open(EPISODES_FILE) as f:
        episodes = json.load(f)

    print(f"Loaded {len(episodes)} episodes from {EPISODES_FILE}")

    # Train
    actor, critic, stats = train_ppo(
        episodes,
        passes=args.passes,
        lr=args.lr,
        batch_size=args.batch_size,
        clip_ratio=args.clip,
        entropy_coeff=args.entropy,
    )

    # Export
    if not args.no_export:
        export_weights(actor, critic, stats)

    print(f"\n{'='*60}")
    print(f"  DONE!")
    print(f"  Walk-forward WR: {stats['walkForwardWR']:.1f}%")
    print(f"  Training time: {stats['durationSec']:.1f}s")
    print(f"  GPU: {'Metal' if gpus else 'CPU'}")
    print(f"{'='*60}")

    # Write result for Node.js to read
    result_path = os.path.join(DATA_DIR, "gpu-training-result.json")
    with open(result_path, "w") as f:
        json.dump(stats, f, indent=2)
    print(f"\nResult written to {result_path}")


if __name__ == "__main__":
    main()
