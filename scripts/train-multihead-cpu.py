#!/usr/bin/env python3
"""
Multi-Head PPO Training — with Regime-Specific Models & SE Attention
Trains 3 specialized models (mean-reversion, momentum, squeeze) plus
a regime classifier. Uses Squeeze-and-Excitation attention in the backbone.
"""

import json, time, sys, os
import numpy as np

# ── Config ──────────────────────────────────────────────────────────────────
GENERALIST_ONLY = "--generalist" in sys.argv or "-g" in sys.argv
_args = [a for a in sys.argv[1:] if not a.startswith("-")]
PASSES = int(_args[0]) if _args else 500
BATCH_SIZE = 256
LR_ACTOR = 1e-5
LR_CRITIC = 1e-5
GAMMA = 0.99
CLIP_RATIO = 0.2
ENTROPY_COEFF = 0.02
SAMPLES_PER_PASS = 3_000
STATE_SIZE = 42

# Regime classification thresholds (on normalized features)
REGIME_GAMMA_IDX = 0        # gammaTilt feature index
REGIME_SQUEEZE_IDX = 10     # squeezeSig feature index
REGIME_GAMMA_POS = 0.3      # gammaTilt > 0.3 → positive gamma (mean-reversion)
REGIME_GAMMA_NEG = -0.3     # gammaTilt < -0.3 → negative gamma (momentum)
REGIME_SQUEEZE_HIGH = 0.5   # squeezeSig > 0.5 → squeeze

REGIME_NAMES = ["meanrev", "momentum", "squeeze"]

# Head configs
HEADS = {
    "direction": {"size": 3, "labels": ["SKIP", "LONG", "SHORT"]},
    "risk":      {"size": 3, "labels": ["tight", "normal", "wide"]},
    "entry":     {"size": 3, "labels": ["at_market", "at_level", "at_wall"]},
    "sizing":    {"size": 3, "labels": ["small", "medium", "full"]},
    "session":   {"size": 2, "labels": ["trade_now", "wait"]},
}
HEAD_NAMES = list(HEADS.keys())
TOTAL_HEAD_OUTPUTS = sum(h["size"] for h in HEADS.values())  # 14

# Rewards by risk level
REWARDS = {
    "tight":  {"tp3": 5.0, "tp2": 3.0, "tp1": 1.5, "sl": -1.5, "cancelled": 0.0},
    "normal": {"tp3": 4.0, "tp2": 2.5, "tp1": 1.0, "sl": -2.0, "cancelled": 0.0},
    "wide":   {"tp3": 3.5, "tp2": 2.0, "tp1": 0.8, "sl": -2.5, "cancelled": 0.0},
}

# ── Simple Neural Network (numpy-based) ────────────────────────────────────

def relu(x):
    return np.maximum(0, x)

def sigmoid(x):
    x = np.clip(x, -500, 500)
    return 1.0 / (1.0 + np.exp(-x))

def softmax(x, axis=-1):
    e = np.exp(x - np.max(x, axis=axis, keepdims=True))
    return e / (e.sum(axis=axis, keepdims=True) + 1e-8)

def he_init(fan_in, fan_out):
    return np.random.randn(fan_in, fan_out).astype(np.float32) * np.sqrt(2.0 / fan_in)

def glorot_init(fan_in, fan_out):
    limit = np.sqrt(6.0 / (fan_in + fan_out))
    return np.random.uniform(-limit, limit, (fan_in, fan_out)).astype(np.float32)


class SEAttention:
    """Squeeze-and-Excitation attention for tabular data.
    Learns feature-wise gating: which features to amplify/suppress."""

    def __init__(self, dim, reduction=4):
        rdim = max(dim // reduction, 1)
        self.W1 = glorot_init(dim, rdim)       # squeeze
        self.b1 = np.zeros(rdim, dtype=np.float32)
        self.W2 = glorot_init(rdim, dim)        # excite
        self.b2 = np.zeros(dim, dtype=np.float32)
        self.dim = dim
        self.rdim = rdim

    def forward(self, x):
        """x: [B, dim] → [B, dim] (gated)"""
        # Squeeze: compress to bottleneck
        z = relu(x @ self.W1 + self.b1)         # [B, rdim]
        # Excite: expand back, sigmoid gates
        gate = sigmoid(z @ self.W2 + self.b2)   # [B, dim]
        out = x * gate                           # [B, dim]
        # Cache for backward
        self._cache = (x, z, gate)
        return out

    def backward(self, d_out):
        """Backprop through SE block.
        d_out: [B, dim] gradient from downstream.
        Returns d_x: [B, dim] gradient to upstream, and updates internal grads."""
        x, z, gate = self._cache
        B = x.shape[0]

        # out = x * gate  →  d_x_direct = d_out * gate,  d_gate = d_out * x
        d_x_direct = d_out * gate
        d_gate = d_out * x

        # gate = sigmoid(z @ W2 + b2)  →  d_pre_gate = d_gate * gate * (1 - gate)
        d_pre_gate = d_gate * gate * (1.0 - gate)  # [B, dim]

        # z @ W2 + b2:  d_W2 = z.T @ d_pre_gate,  d_b2 = sum(d_pre_gate),  d_z = d_pre_gate @ W2.T
        self.dW2 = z.T @ d_pre_gate / B
        self.db2 = d_pre_gate.sum(axis=0) / B
        d_z = d_pre_gate @ self.W2.T  # [B, rdim]

        # z = relu(x @ W1 + b1)  →  d_pre_z = d_z * (z > 0)
        d_pre_z = d_z * (z > 0).astype(np.float32)  # [B, rdim]

        self.dW1 = x.T @ d_pre_z / B
        self.db1 = d_pre_z.sum(axis=0) / B
        d_x_from_squeeze = d_pre_z @ self.W1.T  # [B, dim]

        d_x = d_x_direct + d_x_from_squeeze
        return d_x

    def apply_grads(self, lr):
        """Apply cached gradients with given learning rate."""
        self.W1 += lr * clip_grad(self.dW1)
        self.b1 += lr * clip_grad(self.db1)
        self.W2 += lr * clip_grad(self.dW2)
        self.b2 += lr * clip_grad(self.db2)

    def get_params(self):
        return [
            ("se_W1", self.W1), ("se_b1", self.b1),
            ("se_W2", self.W2), ("se_b2", self.b2),
        ]


class MultiHeadActor:
    """Actor with shared backbone (including SE attention) + independent heads"""
    def __init__(self):
        # Shared backbone: 42 → Dense(192, relu) → SE(192) → Dense(96, relu) → Dense(64, relu) → heads
        self.w1 = he_init(STATE_SIZE, 192)
        self.b1 = np.zeros(192, dtype=np.float32)
        self.se = SEAttention(192, reduction=4)
        self.w2 = he_init(192, 96)
        self.b2 = np.zeros(96, dtype=np.float32)
        self.w3 = he_init(96, 64)
        self.b3 = np.zeros(64, dtype=np.float32)

        # Per-head: 64 → 24 → head_size
        self.head_w1 = {}
        self.head_b1 = {}
        self.head_w2 = {}
        self.head_b2 = {}
        for name, cfg in HEADS.items():
            self.head_w1[name] = he_init(64, 24)
            self.head_b1[name] = np.zeros(24, dtype=np.float32)
            self.head_w2[name] = glorot_init(24, cfg["size"])
            self.head_b2[name] = np.zeros(cfg["size"], dtype=np.float32)

    def forward(self, states):
        """Forward pass: states [B, 42] → head_probs dict of [B, head_size]"""
        # Shared backbone
        h1_pre = states @ self.w1 + self.b1
        h1 = relu(h1_pre)
        h1_att = self.se.forward(h1)             # SE attention after first layer
        h2 = relu(h1_att @ self.w2 + self.b2)
        shared = relu(h2 @ self.w3 + self.b3)

        head_probs = {}
        for name, cfg in HEADS.items():
            hh = relu(shared @ self.head_w1[name] + self.head_b1[name])
            logits = hh @ self.head_w2[name] + self.head_b2[name]
            head_probs[name] = softmax(logits)

        return head_probs

    def get_all_params(self):
        """Get all parameters as list of (name, array) tuples"""
        params = [
            ("w1", self.w1), ("b1", self.b1),
        ]
        params.extend(self.se.get_params())
        params.extend([
            ("w2", self.w2), ("b2", self.b2),
            ("w3", self.w3), ("b3", self.b3),
        ])
        for name in HEAD_NAMES:
            params.extend([
                (f"{name}_w1", self.head_w1[name]),
                (f"{name}_b1", self.head_b1[name]),
                (f"{name}_w2", self.head_w2[name]),
                (f"{name}_b2", self.head_b2[name]),
            ])
        return params


class Critic:
    """Value function: states → value"""
    def __init__(self):
        self.w1 = he_init(STATE_SIZE, 192)
        self.b1 = np.zeros(192, dtype=np.float32)
        self.w2 = he_init(192, 96)
        self.b2 = np.zeros(96, dtype=np.float32)
        self.w3 = he_init(96, 48)
        self.b3 = np.zeros(48, dtype=np.float32)
        self.w4 = glorot_init(48, 1)
        self.b4 = np.zeros(1, dtype=np.float32)

    def forward(self, states):
        h1 = relu(states @ self.w1 + self.b1)
        h2 = relu(h1 @ self.w2 + self.b2)
        h3 = relu(h2 @ self.w3 + self.b3)
        return (h3 @ self.w4 + self.b4).squeeze(-1)

    def get_all_params(self):
        return [
            ("w1", self.w1), ("b1", self.b1),
            ("w2", self.w2), ("b2", self.b2),
            ("w3", self.w3), ("b3", self.b3),
            ("w4", self.w4), ("b4", self.b4),
        ]

# ── Regime Classifier ──────────────────────────────────────────────────────

def classify_regime(states):
    """Classify each episode into regime(s) based on state features.
    Returns dict of regime_name → boolean mask [N].
    Episodes can belong to multiple regimes.
    Episodes that match NO regime are assigned to ALL regimes (general training).
    """
    N = states.shape[0]
    gamma_tilt = states[:, REGIME_GAMMA_IDX]
    squeeze_sig = states[:, REGIME_SQUEEZE_IDX]

    masks = {
        "meanrev":  gamma_tilt > REGIME_GAMMA_POS,          # positive gamma
        "momentum": gamma_tilt < REGIME_GAMMA_NEG,          # negative gamma
        "squeeze":  squeeze_sig > REGIME_SQUEEZE_HIGH,      # high squeeze
    }

    # Episodes that don't match any regime → assign to all
    any_regime = masks["meanrev"] | masks["momentum"] | masks["squeeze"]
    no_regime = ~any_regime
    for rname in REGIME_NAMES:
        masks[rname] = masks[rname] | no_regime

    return masks


def classify_single(state):
    """Classify a single state vector into a regime name.
    Returns the best-matching regime for inference."""
    gamma_tilt = state[REGIME_GAMMA_IDX]
    squeeze_sig = state[REGIME_SQUEEZE_IDX]

    # Priority: squeeze > momentum > meanrev (squeeze is strongest signal)
    if squeeze_sig > REGIME_SQUEEZE_HIGH:
        return "squeeze"
    if gamma_tilt < REGIME_GAMMA_NEG:
        return "momentum"
    if gamma_tilt > REGIME_GAMMA_POS:
        return "meanrev"
    # Default: mean-reversion (most common market state)
    return "meanrev"


# ── Gradient utilities ─────────────────────────────────────────────────────

def clip_grad(g, max_norm=1.0):
    """Clip gradients to prevent explosion"""
    norm = np.sqrt((g ** 2).sum())
    if norm > max_norm:
        g = g * (max_norm / norm)
    return np.nan_to_num(g, nan=0.0, posinf=0.0, neginf=0.0)


def update_actor_reinforce(actor, batch_states, batch_actions, batch_advantages, lr):
    """REINFORCE-style gradient with SE attention backprop:
    ∇θ log π(a|s) * A"""
    B = len(batch_states)
    head_probs = actor.forward(batch_states)

    # Shared backbone forward (recompute intermediates for gradient)
    h1_pre = batch_states @ actor.w1 + actor.b1
    h1 = relu(h1_pre)
    h1_att = actor.se.forward(h1)  # SE attention (caches internally)
    h2_pre = h1_att @ actor.w2 + actor.b2
    h2 = relu(h2_pre)
    shared_pre = h2 @ actor.w3 + actor.b3
    shared = relu(shared_pre)

    # ── Per-head gradients ──
    for name in HEAD_NAMES:
        probs = head_probs[name]
        actions = batch_actions[name]
        size = HEADS[name]["size"]

        one_hot = np.zeros_like(probs)
        one_hot[np.arange(B), actions] = 1.0
        d_logits = (one_hot - probs) * batch_advantages[:, None] / B

        hh = relu(shared @ actor.head_w1[name] + actor.head_b1[name])
        actor.head_w2[name] += lr * clip_grad(hh.T @ d_logits)
        actor.head_b2[name] += lr * clip_grad(d_logits.sum(axis=0))

        d_hh = d_logits @ actor.head_w2[name].T
        d_hh *= (hh > 0).astype(np.float32)
        actor.head_w1[name] += lr * clip_grad(shared.T @ d_hh)
        actor.head_b1[name] += lr * clip_grad(d_hh.sum(axis=0))

    # ── Shared backbone gradients (sum across all heads) ──
    d_shared = np.zeros_like(shared)
    for name in HEAD_NAMES:
        probs = head_probs[name]
        actions = batch_actions[name]
        one_hot = np.zeros_like(probs)
        one_hot[np.arange(B), actions] = 1.0
        d_logits = (one_hot - probs) * batch_advantages[:, None] / B

        hh = relu(shared @ actor.head_w1[name] + actor.head_b1[name])
        d_hh = d_logits @ actor.head_w2[name].T
        d_hh *= (hh > 0).astype(np.float32)
        d_shared += d_hh @ actor.head_w1[name].T

    d_shared *= (shared > 0).astype(np.float32)

    # Layer 3: shared = relu(h2 @ w3 + b3)
    actor.w3 += lr * clip_grad(h2.T @ d_shared)
    actor.b3 += lr * clip_grad(d_shared.sum(axis=0))

    # Layer 2: h2 = relu(h1_att @ w2 + b2)
    d_h2 = d_shared @ actor.w3.T * (h2 > 0).astype(np.float32)
    actor.w2 += lr * clip_grad(h1_att.T @ d_h2)
    actor.b2 += lr * clip_grad(d_h2.sum(axis=0))

    # SE attention backward: h1_att = SE(h1)
    d_h1_att = d_h2 @ actor.w2.T
    d_h1 = actor.se.backward(d_h1_att)
    actor.se.apply_grads(lr)

    # Layer 1: h1 = relu(states @ w1 + b1)
    d_h1 *= (h1 > 0).astype(np.float32)
    actor.w1 += lr * clip_grad(batch_states.T @ d_h1)
    actor.b1 += lr * clip_grad(d_h1.sum(axis=0))


def update_critic(critic, batch_states, batch_returns, lr):
    """MSE gradient for critic"""
    B = len(batch_states)

    h1 = relu(batch_states @ critic.w1 + critic.b1)
    h2 = relu(h1 @ critic.w2 + critic.b2)
    h3 = relu(h2 @ critic.w3 + critic.b3)
    values = (h3 @ critic.w4 + critic.b4).squeeze(-1)

    d_values = (values - batch_returns) / B
    d_values_2d = d_values[:, None]
    critic.w4 -= lr * clip_grad(h3.T @ d_values_2d)
    critic.b4 -= lr * clip_grad(d_values_2d.sum(axis=0))

    d_h3 = d_values_2d @ critic.w4.T * (h3 > 0).astype(np.float32)
    critic.w3 -= lr * clip_grad(h2.T @ d_h3)
    critic.b3 -= lr * clip_grad(d_h3.sum(axis=0))

    d_h2 = d_h3 @ critic.w3.T * (h2 > 0).astype(np.float32)
    critic.w2 -= lr * clip_grad(h1.T @ d_h2)
    critic.b2 -= lr * clip_grad(d_h2.sum(axis=0))

    d_h1 = d_h2 @ critic.w2.T * (h1 > 0).astype(np.float32)
    critic.w1 -= lr * clip_grad(batch_states.T @ d_h1)
    critic.b1 -= lr * clip_grad(d_h1.sum(axis=0))

    return float(((values - batch_returns) ** 2).mean())


# ── Approximate outcome calculator ────────────────────────────────────────

def compute_approx_outcome(direction, price_delta_pct, atr_pct, entry_price=0, day_high=0, day_low=0):
    """Compute outcome from daily high/low (fallback when no 1-min data)."""
    price_delta_pct = price_delta_pct or 0
    atr_pct = atr_pct or 1.0
    entry_price = entry_price or 0
    day_high = day_high or 0
    day_low = day_low or 0
    safe_atr = max(atr_pct, 0.3)
    sl_pct = safe_atr * 0.40
    tp1_pct = safe_atr * 0.25
    tp2_pct = safe_atr * 0.55
    tp3_pct = safe_atr * 1.20

    if entry_price > 0 and day_high > 0 and day_low > 0:
        up_pct = (day_high - entry_price) / entry_price * 100
        down_pct = (entry_price - day_low) / entry_price * 100

        if direction == "LONG":
            if down_pct >= sl_pct: return "sl"
            if up_pct >= tp3_pct: return "tp3"
            if up_pct >= tp2_pct: return "tp2"
            if up_pct >= tp1_pct: return "tp1"
        elif direction == "SHORT":
            if up_pct >= sl_pct: return "sl"
            if down_pct >= tp3_pct: return "tp3"
            if down_pct >= tp2_pct: return "tp2"
            if down_pct >= tp1_pct: return "tp1"

    # Fallback to close-to-close
    if direction == "LONG":
        if price_delta_pct >= tp3_pct: return "tp3"
        if price_delta_pct >= tp2_pct: return "tp2"
        if price_delta_pct >= tp1_pct: return "tp1"
        if price_delta_pct <= -sl_pct: return "sl"
    elif direction == "SHORT":
        if price_delta_pct <= -tp3_pct: return "tp3"
        if price_delta_pct <= -tp2_pct: return "tp2"
        if price_delta_pct <= -tp1_pct: return "tp1"
        if price_delta_pct >= sl_pct: return "sl"

    return "cancelled"


# ── Training a single regime model ─────────────────────────────────────────

def train_regime_model(regime_name, train_states, train_outcomes, train_ep_data,
                       states_all, all_outcomes_list, all_ep_data_list, train_idx_regime,
                       passes):
    """Train one actor for a specific regime. Returns (actor, critic, stats)."""
    print(f"\n{'─'*60}")
    print(f"TRAINING REGIME: {regime_name.upper()} ({len(train_idx_regime):,} episodes)")
    print(f"{'─'*60}")

    actor = MultiHeadActor()
    critic = Critic()

    N_regime = len(train_idx_regime)
    if N_regime == 0:
        print(f"  WARNING: No training data for regime {regime_name}, skipping.")
        return actor, critic, {"trainWR": 0, "wins": 0, "losses": 0}

    samples_per_pass = min(SAMPLES_PER_PASS, N_regime)

    # ── PRE-COMPUTE all outcomes once (vectorized) ──────────────────────────
    print(f"  [{regime_name}] Pre-computing outcomes for {len(train_idx_regime):,} episodes...")
    precomp_start = time.time()

    # Outcome maps: index → {LONG: outcome, SHORT: outcome, SKIP_reward: float}
    OUTCOME_MAP = {"tp1": 0, "tp2": 1, "tp3": 2, "sl": 3, "cancelled": 4}
    OUTCOME_LABELS = ["tp1", "tp2", "tp3", "sl", "cancelled"]

    # Pre-compute for all global indices we'll ever access
    all_idx_set = set(train_idx_regime.tolist())
    precomp_long = {}   # global_idx → outcome string
    precomp_short = {}  # global_idx → outcome string

    for gi in all_idx_set:
        ep = all_ep_data_list[gi]
        if ep.get("has1Min"):
            precomp_long[gi] = ep.get("exactLong", "cancelled") or "cancelled"
            precomp_short[gi] = ep.get("exactShort", "cancelled") or "cancelled"
        else:
            price = ep.get("price") or 0
            day_h = ep.get("dayHigh") or 0
            day_l = ep.get("dayLow") or 0
            atr = max(ep.get("atrPct") or 1.0, 0.3)
            if price > 0 and day_h > 0 and day_l > 0:
                up_pct_l = (day_h - price) / price * 100
                down_pct_l = (price - day_l) / price * 100
                up_pct_s = down_pct_l
                down_pct_s = up_pct_l
                for direction, up_pct, down_pct, store in [
                    ("LONG", up_pct_l, down_pct_l, precomp_long),
                    ("SHORT", up_pct_s, down_pct_s, precomp_short),
                ]:
                    if down_pct >= atr * 0.40:
                        store[gi] = "sl"
                    elif up_pct >= atr * 1.20:
                        store[gi] = "tp3"
                    elif up_pct >= atr * 0.55:
                        store[gi] = "tp2"
                    elif up_pct >= atr * 0.25:
                        store[gi] = "tp1"
                    else:
                        store[gi] = "cancelled"
            else:
                precomp_long[gi] = "cancelled"
                precomp_short[gi] = "cancelled"

    # Reward lookup tables (vectorized)
    REWARD_TIGHT =  np.array([1.5, 3.0, 5.0, -1.5, 0.1], dtype=np.float32)  # tp1,tp2,tp3,sl,cancelled
    REWARD_NORMAL = np.array([1.0, 2.5, 4.0, -2.0, 0.1], dtype=np.float32)
    REWARD_WIDE =   np.array([0.8, 2.0, 3.5, -2.5, 0.1], dtype=np.float32)
    REWARD_TABLES = np.stack([REWARD_TIGHT, REWARD_NORMAL, REWARD_WIDE])  # [3, 5]
    WIN_MASK = np.array([1, 1, 1, 0, 0], dtype=np.float32)
    LOSS_MASK = np.array([0, 0, 0, 1, 0], dtype=np.float32)

    precomp_time = time.time() - precomp_start
    print(f"  [{regime_name}] Pre-computed {len(precomp_long):,} outcomes in {precomp_time:.1f}s")

    total_wins = 0
    total_losses = 0
    wr_history = []
    start_time = time.time()

    for pass_num in range(1, passes + 1):
        sample_local_idx = np.random.choice(N_regime, size=samples_per_pass, replace=(N_regime < samples_per_pass))
        sample_global_idx = train_idx_regime[sample_local_idx]

        batch_states = states_all[sample_global_idx]

        # Forward pass
        head_probs = actor.forward(batch_states)
        values = critic.forward(batch_states)

        B = len(batch_states)
        actions = {}

        for name in HEAD_NAMES:
            probs = head_probs[name]
            cumprobs = np.cumsum(probs, axis=1)
            rand = np.random.random((B, 1)).astype(np.float32)
            acts = (rand >= cumprobs).sum(axis=1).astype(np.int32)
            acts = np.clip(acts, 0, HEADS[name]["size"] - 1)
            actions[name] = acts

        # Vectorized reward computation (no Python loop!)
        dir_actions = actions["direction"]    # [B] — 0=SKIP, 1=LONG, 2=SHORT
        risk_actions = actions["risk"]        # [B] — 0=tight, 1=normal, 2=wide

        # Get pre-computed outcomes for this batch
        outcome_idx = np.full(B, 4, dtype=np.int32)  # default = cancelled
        for i in range(B):
            gi = sample_global_idx[i]
            da = dir_actions[i]
            if da == 1:  # LONG
                outcome_idx[i] = OUTCOME_MAP.get(precomp_long.get(gi, "cancelled"), 4)
            elif da == 2:  # SHORT
                outcome_idx[i] = OUTCOME_MAP.get(precomp_short.get(gi, "cancelled"), 4)

        # Vectorized rewards: REWARD_TABLES[risk_action, outcome_idx]
        rewards = REWARD_TABLES[risk_actions, outcome_idx]

        # SKIP rewards
        skip_mask = dir_actions == 0
        skip_win_mask = outcome_idx < 3  # tp1/tp2/tp3
        skip_sl_mask = outcome_idx == 3  # sl
        rewards[skip_mask & skip_win_mask] = -0.5
        rewards[skip_mask & skip_sl_mask] = 0.3
        rewards[skip_mask & ~skip_win_mask & ~skip_sl_mask] = -0.1

        # Count wins/losses (non-skip only)
        non_skip = ~skip_mask
        pass_wins = int((non_skip & (outcome_idx < 3)).sum())
        pass_losses = int((non_skip & (outcome_idx == 3)).sum())

        total_wins += pass_wins
        total_losses += pass_losses

        # Advantages
        advantages = rewards - values
        adv_mean = advantages.mean()
        adv_std = advantages.std() + 1e-8
        advantages = np.clip((advantages - adv_mean) / adv_std, -5, 5)
        returns = np.clip(rewards, -10, 10)

        # Mini-batch updates
        for start in range(0, B, BATCH_SIZE):
            end = min(start + BATCH_SIZE, B)
            mb_states = batch_states[start:end]
            mb_actions = {name: actions[name][start:end] for name in HEAD_NAMES}
            mb_advantages = advantages[start:end]
            mb_returns = returns[start:end]

            update_actor_reinforce(actor, mb_states, mb_actions, mb_advantages, LR_ACTOR)
            update_critic(critic, mb_states, mb_returns, LR_CRITIC)

        resolved = pass_wins + pass_losses
        wr = pass_wins / resolved * 100 if resolved > 0 else 0
        wr_history.append(wr)

        if pass_num % 50 == 0 or pass_num <= 3:
            elapsed = time.time() - start_time
            eta = elapsed / pass_num * (passes - pass_num)
            total_resolved = total_wins + total_losses
            cum_wr = total_wins / total_resolved * 100 if total_resolved > 0 else 0
            print(f"  [{regime_name}] Pass {pass_num:>4}/{passes}: WR={wr:.1f}% (cum={cum_wr:.1f}%) "
                  f"wins={pass_wins} losses={pass_losses} [{elapsed:.0f}s, ETA {eta:.0f}s]", flush=True)

    elapsed = time.time() - start_time
    total_resolved = total_wins + total_losses
    final_wr = total_wins / total_resolved * 100 if total_resolved > 0 else 0
    print(f"  [{regime_name}] DONE: WR={final_wr:.1f}% wins={total_wins:,} losses={total_losses:,} "
          f"({elapsed:.1f}s)")

    stats = {
        "trainWR": final_wr,
        "wins": int(total_wins),
        "losses": int(total_losses),
        "episodes": int(N_regime),
        "durationSec": elapsed,
        "wrHistory": [round(w, 1) for w in wr_history[-10:]],
    }
    return actor, critic, stats


# ── Main Training Loop ──────────────────────────────────────────────────────

def main():
    print(f"Loading training data...")
    _script_dir = os.path.dirname(os.path.abspath(__file__))
    _data_file = os.path.join(_script_dir, "..", "data", "training-data-535k.json")
    with open(_data_file) as f:
        raw_data = json.load(f)
    print(f"Loaded {len(raw_data):,} episodes")

    # Parse into numpy arrays
    all_states = []
    all_outcomes = []
    all_dates = []
    all_episode_data = []

    for ep in raw_data:
        if ep.get("s") and len(ep["s"]) == STATE_SIZE:
            state = ep["s"]
            if any(not np.isfinite(v) for v in state):
                continue
            all_states.append(state)
            all_outcomes.append(ep.get("o", "cancelled"))
            all_dates.append(ep.get("date", ""))
            all_episode_data.append(ep)

    states = np.array(all_states, dtype=np.float32)
    N = len(states)
    print(f"Valid episodes: {N:,} (dropped {len(raw_data) - N:,} invalid)")

    # Walk-forward split: 80/20 by date
    dates = np.array(all_dates)
    sorted_idx = np.argsort(dates)
    split = int(N * 0.8)
    train_idx = sorted_idx[:split]
    test_idx = sorted_idx[split:]
    print(f"Train: {len(train_idx):,}, Test: {len(test_idx):,}")

    # ── GENERALIST MODE: Train one model on ALL data ──
    if GENERALIST_ONLY:
        print(f"\n{'='*60}")
        print(f"GENERALIST MODE (--generalist)")
        print(f"{'='*60}")
        actor, critic, stats = train_regime_model(
            "generalist", states[train_idx], all_outcomes, all_episode_data,
            states, all_outcomes, all_episode_data,
            train_idx, PASSES,
        )
        # Walk-forward test
        test_states_arr = states[test_idx]
        test_probs = actor.forward(test_states_arr)
        test_wins, test_losses, test_skips = 0, 0, 0
        for i in range(len(test_idx)):
            gi = test_idx[i]
            ep_d = all_episode_data[gi]
            direction_probs = test_probs["direction"][i]
            dir_action = np.argmax(direction_probs)
            if dir_action == 0:
                test_skips += 1
                continue
            direction = "LONG" if dir_action == 1 else "SHORT"
            risk_probs = test_probs["risk"][i]
            risk_action = np.argmax(risk_probs)
            risk_label = ["tight", "normal", "wide"][risk_action]
            sl_mult = [0.25, 0.40, 0.65][risk_action]
            tp1_mult = [0.20, 0.25, 0.35][risk_action]
            tp2_mult = [0.45, 0.55, 0.75][risk_action]
            tp3_mult = [0.90, 1.20, 1.80][risk_action]
            atr = ep_d.get("atrPct", 1.0)
            safe_atr = max(atr, 0.3)
            entry = ep_d.get("price", 0)
            exact_key = "exactLong" if direction == "LONG" else "exactShort"
            if exact_key in ep_d and ep_d[exact_key]:
                outcome = ep_d[exact_key]
            else:
                day_h = ep_d.get("dayHigh", 0)
                day_l = ep_d.get("dayLow", 0)
                delta_pct = ep_d.get("priceDeltaPct", 0)
                if entry > 0 and day_h > 0 and day_l > 0:
                    if direction == "LONG":
                        up_pct = (day_h - entry) / entry * 100
                        down_pct = (entry - day_l) / entry * 100
                    else:
                        up_pct = (entry - day_l) / entry * 100
                        down_pct = (day_h - entry) / entry * 100
                    if down_pct >= safe_atr * sl_mult:
                        outcome = "sl"
                    elif up_pct >= safe_atr * tp3_mult:
                        outcome = "tp3"
                    elif up_pct >= safe_atr * tp2_mult:
                        outcome = "tp2"
                    elif up_pct >= safe_atr * tp1_mult:
                        outcome = "tp1"
                    else:
                        outcome = "cancelled"
                else:
                    outcome = "cancelled"
            if outcome in ("tp1", "tp2", "tp3"):
                test_wins += 1
            elif outcome == "sl":
                test_losses += 1
        test_resolved = test_wins + test_losses
        test_wr = (test_wins / test_resolved * 100) if test_resolved > 0 else 0
        print(f"\n{'='*60}")
        print(f"WALK-FORWARD TEST ({len(test_idx):,} episodes)")
        print(f"{'='*60}")
        print(f"Test WR:    {test_wr:.1f}%")
        print(f"Test Wins:  {test_wins:,}")
        print(f"Test Losses:{test_losses:,}")
        print(f"Test Skips: {test_skips:,}")
        print(f"Test Total: {test_resolved:,} resolved")
        # Save weights
        model_dir = os.path.join(os.path.dirname(__file__), "..", "data", "ppo-multihead-model")
        os.makedirs(model_dir, exist_ok=True)
        actor_weights = []
        for wname, param in actor.get_all_params():
            actor_weights.append({"name": wname, "shape": list(param.shape), "data": param.flatten().tolist()})
        with open(os.path.join(model_dir, "actor-weights.json"), "w") as f:
            json.dump(actor_weights, f)
        print(f"Saved actor-weights.json")
        critic_weights = []
        for wname, param in critic.get_all_params():
            critic_weights.append({"name": wname, "shape": list(param.shape), "data": param.flatten().tolist()})
        with open(os.path.join(model_dir, "critic-weights.json"), "w") as f:
            json.dump(critic_weights, f)
        print(f"Saved critic-weights.json")
        state_info = {
            "totalEpisodes": int(stats["episodes"] * PASSES),
            "totalWins": int(stats["wins"]),
            "totalLosses": int(stats["losses"]),
            "trainWR": float(stats["trainWR"]),
            "testWR": float(test_wr),
            "testWins": int(test_wins),
            "testLosses": int(test_losses),
            "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "generalist": True,
        }
        with open(os.path.join(model_dir, "..", "ppo-multihead-state.json"), "w") as f:
            json.dump(state_info, f, indent=2)
        print(f"Saved ppo-multihead-state.json")
        print(f"\nWeights saved to {model_dir}")
        return

    # ── Classify regimes for training data ──
    train_states = states[train_idx]
    regime_masks = classify_regime(train_states)

    print(f"\nRegime distribution (training set):")
    for rname in REGIME_NAMES:
        count = regime_masks[rname].sum()
        print(f"  {rname:>12}: {int(count):>7,} episodes ({count / len(train_idx) * 100:.1f}%)")

    # Get global indices for each regime's training episodes
    regime_train_idx = {}
    for rname in REGIME_NAMES:
        local_mask = regime_masks[rname]
        regime_train_idx[rname] = train_idx[local_mask]

    # ── Train 3 regime-specific models ──
    actors = {}
    critics = {}
    regime_stats = {}

    for rname in REGIME_NAMES:
        actor, critic, stats = train_regime_model(
            rname, train_states, all_outcomes, all_episode_data,
            states, all_outcomes, all_episode_data,
            regime_train_idx[rname], PASSES,
        )
        actors[rname] = actor
        critics[rname] = critic
        regime_stats[rname] = stats

    # ── Walk-forward test with regime classifier ──
    print(f"\n{'='*60}")
    print(f"WALK-FORWARD TEST ({len(test_idx):,} episodes) — Regime Classifier")
    print(f"{'='*60}")

    test_states = states[test_idx]
    test_outcomes = [all_outcomes[i] for i in test_idx]
    test_ep_data = [all_episode_data[i] for i in test_idx]

    # Pre-compute all forward passes
    regime_test_probs = {}
    for rname in REGIME_NAMES:
        regime_test_probs[rname] = actors[rname].forward(test_states)

    # Per-regime test stats
    regime_test_wins = {r: 0 for r in REGIME_NAMES}
    regime_test_losses = {r: 0 for r in REGIME_NAMES}
    regime_test_skips = {r: 0 for r in REGIME_NAMES}
    regime_test_count = {r: 0 for r in REGIME_NAMES}

    test_wins = 0
    test_losses = 0
    test_skips = 0
    test_exact_used = 0

    for i in range(len(test_idx)):
        # Classify regime for this test episode
        regime = classify_single(test_states[i])
        regime_test_count[regime] += 1

        # Use that regime's model
        head_probs = regime_test_probs[regime]
        dir_probs = head_probs["direction"][i]
        direction = HEADS["direction"]["labels"][np.argmax(dir_probs)]

        if direction == "SKIP":
            test_skips += 1
            regime_test_skips[regime] += 1
            continue

        ep_data = test_ep_data[i]
        if ep_data.get("has1Min"):
            if direction == "LONG":
                outcome = ep_data.get("exactLong", "cancelled") or "cancelled"
            else:
                outcome = ep_data.get("exactShort", "cancelled") or "cancelled"
            test_exact_used += 1
        else:
            outcome = compute_approx_outcome(
                direction, ep_data.get("priceDeltaPct", 0),
                ep_data.get("atrPct", 1.0), ep_data.get("price", 0),
                ep_data.get("dayHigh", 0), ep_data.get("dayLow", 0),
            )

        if outcome in ["tp1", "tp2", "tp3"]:
            test_wins += 1
            regime_test_wins[regime] += 1
        elif outcome == "sl":
            test_losses += 1
            regime_test_losses[regime] += 1

    test_resolved = test_wins + test_losses
    test_wr = test_wins / test_resolved * 100 if test_resolved > 0 else 0

    print(f"\nOverall Test WR:    {test_wr:.1f}%")
    print(f"Test Wins:          {test_wins:,}")
    print(f"Test Losses:        {test_losses:,}")
    print(f"Test Skips:         {test_skips:,}")
    print(f"Test Total:         {test_resolved:,} resolved")
    print(f"Test Exact:         {test_exact_used:,} used 1-min outcomes")

    print(f"\nPer-Regime Walk-Forward WR:")
    print(f"  {'Regime':>12}  {'Count':>7}  {'Wins':>6}  {'Losses':>6}  {'Skips':>6}  {'WR':>7}")
    print(f"  {'─'*55}")
    for rname in REGIME_NAMES:
        rw = regime_test_wins[rname]
        rl = regime_test_losses[rname]
        rs = regime_test_skips[rname]
        rc = regime_test_count[rname]
        rr = rw + rl
        rwr = rw / rr * 100 if rr > 0 else 0
        print(f"  {rname:>12}  {rc:>7,}  {rw:>6,}  {rl:>6,}  {rs:>6,}  {rwr:>6.1f}%")

    # ── Export weights for Node.js ─────────────────────────────────────────
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "ppo-multihead-model")
    os.makedirs(model_dir, exist_ok=True)

    # Save per-regime actor weights
    for rname in REGIME_NAMES:
        actor_weights = []
        for wname, param in actors[rname].get_all_params():
            actor_weights.append({
                "name": wname,
                "shape": list(param.shape),
                "data": param.flatten().tolist(),
            })
        fname = f"actor-weights-{rname}.json"
        with open(os.path.join(model_dir, fname), "w") as f:
            json.dump(actor_weights, f)
        print(f"Saved {fname}")

    # Save critic weights (shared critic from last regime, or we can pick best)
    best_regime = max(REGIME_NAMES, key=lambda r: regime_stats[r]["trainWR"])
    critic_weights = []
    for wname, param in critics[best_regime].get_all_params():
        critic_weights.append({
            "name": wname,
            "shape": list(param.shape),
            "data": param.flatten().tolist(),
        })
    with open(os.path.join(model_dir, "critic-weights.json"), "w") as f:
        json.dump(critic_weights, f)

    # Save regime classifier config
    regime_config = {
        "gammaFeatureIdx": REGIME_GAMMA_IDX,
        "squeezeFeatureIdx": REGIME_SQUEEZE_IDX,
        "gammaPositiveThreshold": REGIME_GAMMA_POS,
        "gammaNegativeThreshold": REGIME_GAMMA_NEG,
        "squeezeHighThreshold": REGIME_SQUEEZE_HIGH,
        "regimes": REGIME_NAMES,
        "defaultRegime": "meanrev",
        "priority": ["squeeze", "momentum", "meanrev"],
    }
    with open(os.path.join(model_dir, "regime-classifier.json"), "w") as f:
        json.dump(regime_config, f, indent=2)
    print(f"Saved regime-classifier.json")

    # Also save a combined actor-weights.json for backward compatibility
    # (uses the best regime's weights)
    best_actor_weights = []
    for wname, param in actors[best_regime].get_all_params():
        best_actor_weights.append({
            "name": wname,
            "shape": list(param.shape),
            "data": param.flatten().tolist(),
        })
    with open(os.path.join(model_dir, "actor-weights.json"), "w") as f:
        json.dump(best_actor_weights, f)

    # Aggregate stats
    total_wins_all = sum(regime_stats[r]["wins"] for r in REGIME_NAMES)
    total_losses_all = sum(regime_stats[r]["losses"] for r in REGIME_NAMES)
    total_resolved_all = total_wins_all + total_losses_all
    final_wr_all = total_wins_all / total_resolved_all * 100 if total_resolved_all > 0 else 0
    total_duration = sum(regime_stats[r]["durationSec"] for r in REGIME_NAMES)

    state_data = {
        "totalEpisodes": int(total_resolved_all),
        "totalWins": int(total_wins_all),
        "totalLosses": int(total_losses_all),
        "winRate": float(final_wr_all),
        "walkForwardWR": float(test_wr),
        "passes": PASSES,
        "datasetSize": N,
        "durationSec": total_duration,
        "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "regimeModels": True,
        "attentionType": "squeeze-and-excitation",
        "perRegimeStats": {
            rname: {
                "trainWR": regime_stats[rname]["trainWR"],
                "testWR": (regime_test_wins[rname] / (regime_test_wins[rname] + regime_test_losses[rname]) * 100
                           if (regime_test_wins[rname] + regime_test_losses[rname]) > 0 else 0),
                "trainEpisodes": regime_stats[rname]["episodes"],
                "testEpisodes": regime_test_count[rname],
            }
            for rname in REGIME_NAMES
        },
    }
    state_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "ppo-multihead-state.json")
    with open(state_file, "w") as f:
        json.dump(state_data, f, indent=2)

    print(f"\nWeights saved to {model_dir}/")
    print(f"State saved to {state_file}")

    # Save result for Node.js to read
    result = {
        "trainWR": final_wr_all,
        "testWR": test_wr,
        "passes": PASSES,
        "episodes": N,
        "durationSec": total_duration,
        "wins": total_wins_all,
        "losses": total_losses_all,
        "testWins": test_wins,
        "testLosses": test_losses,
        "regimeModels": True,
        "perRegime": {
            rname: {
                "trainWR": regime_stats[rname]["trainWR"],
                "testWR": (regime_test_wins[rname] / (regime_test_wins[rname] + regime_test_losses[rname]) * 100
                           if (regime_test_wins[rname] + regime_test_losses[rname]) > 0 else 0),
            }
            for rname in REGIME_NAMES
        },
    }
    _result_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "mh-python-result.json")
    with open(_result_file, "w") as f:
        json.dump(result, f)

    print(f"\n{'='*60}")
    print(f"ALL REGIMES COMPLETE")
    print(f"{'='*60}")
    print(f"Combined Train WR: {final_wr_all:.1f}%")
    print(f"Walk-Forward WR:   {test_wr:.1f}%")
    print(f"Total Duration:    {total_duration:.1f}s ({total_duration/60:.1f} min)")
    for rname in REGIME_NAMES:
        rw = regime_test_wins[rname]
        rl = regime_test_losses[rname]
        rr = rw + rl
        rwr = rw / rr * 100 if rr > 0 else 0
        print(f"  {rname:>12} test WR: {rwr:.1f}% ({rr:,} resolved)")


if __name__ == "__main__":
    main()
