"""TensorFlow Metal GPU training — Multi-Head PPO with 46 features + 8 heads (PPO Puro)"""
import json, time, sys, os
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import numpy as np

# Lazy import TF to show progress sooner
print("Loading TensorFlow with Metal GPU...", flush=True)
import tensorflow as tf
gpus = tf.config.list_physical_devices('GPU')
print(f"GPUs: {len(gpus)} {'(Metal)' if gpus else '(CPU only)'}", flush=True)

PASSES = 500
STATE_SIZE = 46  # 42 market + 4 context features
LR = 5e-5
SAMPLES_PER_PASS = 10_000

HEAD_NAMES = ["direction", "risk", "entry", "sizing", "session", "overExtension", "entryQuality", "scoreThreshold"]
HEAD_SIZES = {
    "direction": 3, "risk": 3, "entry": 3, "sizing": 3, "session": 2,
    "overExtension": 2, "entryQuality": 2, "scoreThreshold": 4,
}
HEAD_LABELS = {
    "direction": ["SKIP","LONG","SHORT"], "risk": ["tight","normal","wide"],
    "entry": ["at_market","at_level","at_wall"], "sizing": ["small","medium","full"],
    "session": ["trade_now","wait"],
    "overExtension": ["TRADE","SKIP"],
    "entryQuality": ["ACCEPT_CAUTION","WAIT_OPTIMAL"],
    "scoreThreshold": ["LOW","MEDIUM","HIGH","EXTRA"],
}

# Load data
DATA_PATH = "/Users/samuellondono/spotgamma_monitor/data/training-data-445k.json"
print(f"Loading data from {DATA_PATH}...", flush=True)
with open(DATA_PATH) as f:
    raw_data = json.load(f)
print(f"Loaded {len(raw_data):,} episodes", flush=True)

# Accept both 42-feature and 46-feature states
# Pad 42-feature states with 4 default context features
def pad_state(s, ep):
    if len(s) == STATE_SIZE:
        return s
    if len(s) == 42:
        # Derive context features from episode metadata
        time_norm = ep.get("timeNorm", 0.48)
        session_type = 0 if time_norm < 0.38 else 1 if time_norm < 0.48 else 2 if time_norm < 0.60 else 3 if time_norm < 0.63 else 4
        im_usage = ep.get("impliedMoveUsage", 1.0)
        return s + [
            session_type / 3 - 1,    # sessionType normalized to ~[-1,1]
            0.0,                      # macroAlertActive (not in historical)
            0.0,                      # counterTrendDetected (not in historical)
            min(1, im_usage / 2) * 2 - 1,  # imExhaustionLevel normalized to [-1,1]
        ]
    return None  # skip invalid

states_list = []
all_ep_data = []
for ep in raw_data:
    s = ep.get("s", [])
    padded = pad_state(s, ep)
    if padded is not None and len(padded) == STATE_SIZE:
        states_list.append(padded)
        all_ep_data.append(ep)

states = np.array(states_list, dtype=np.float32)
N = len(states)
print(f"Valid: {N:,} (padded from 42→46 features where needed)", flush=True)

# Sort + split
dates = np.array([ep.get("date","") for ep in all_ep_data])
sorted_idx = np.argsort(dates)
split = int(N * 0.8)
train_idx = sorted_idx[:split]
test_idx = sorted_idx[split:]
print(f"Train: {len(train_idx):,}, Test: {len(test_idx):,}", flush=True)

# Pre-compute outcomes as numpy arrays for fast lookup
print("Pre-computing outcomes...", flush=True)
t0 = time.time()
outcome_long = np.full(N, 4, dtype=np.int32)   # 4 = cancelled
outcome_short = np.full(N, 4, dtype=np.int32)
OMAP = {"tp1":0,"tp2":1,"tp3":2,"sl":3,"cancelled":4}

for gi in range(N):
    ep = all_ep_data[gi]
    if ep.get("has1Min"):
        outcome_long[gi] = OMAP.get(ep.get("exactLong","cancelled") or "cancelled", 4)
        outcome_short[gi] = OMAP.get(ep.get("exactShort","cancelled") or "cancelled", 4)
    else:
        price = ep.get("price") or 0; day_h = ep.get("dayHigh") or 0; day_l = ep.get("dayLow") or 0
        atr = max(ep.get("atrPct") or 1.0, 0.3)
        if price > 0 and day_h > 0 and day_l > 0:
            for up, dn, store in [((day_h-price)/price*100, (price-day_l)/price*100, outcome_long),
                                   ((price-day_l)/price*100, (day_h-price)/price*100, outcome_short)]:
                if dn >= atr*0.40: store[gi] = 3
                elif up >= atr*1.20: store[gi] = 2
                elif up >= atr*0.55: store[gi] = 1
                elif up >= atr*0.25: store[gi] = 0

# Pre-compute context features for reward shaping
im_usage = np.array([ep.get("impliedMoveUsage", 1.0) for ep in all_ep_data], dtype=np.float32)
sig_quality = np.array([ep.get("signalQuality", 0) for ep in all_ep_data], dtype=np.float32)

print(f"Pre-computed in {time.time()-t0:.1f}s", flush=True)

# Reward table: [risk_idx, outcome_idx] → base reward
# risk: 0=tight, 1=normal, 2=wide | outcome: 0=tp1, 1=tp2, 2=tp3, 3=sl, 4=cancelled
REWARD_TABLES = tf.constant([
    [1.5, 3.0, 5.0, -1.5, 0.1],  # tight
    [1.0, 2.5, 4.0, -2.0, 0.1],  # normal
    [0.8, 2.0, 3.5, -2.5, 0.1],  # wide
], dtype=tf.float32)

# Build TF model — shared backbone + 8 heads (matching ppo-multihead.ts architecture)
inp = tf.keras.Input(shape=(STATE_SIZE,))
x = tf.keras.layers.Dense(192, activation='relu', kernel_initializer='he_normal', kernel_regularizer=tf.keras.regularizers.l2(1e-4))(inp)
x = tf.keras.layers.Dropout(0.15)(x)
x = tf.keras.layers.Dense(96, activation='relu', kernel_initializer='he_normal', kernel_regularizer=tf.keras.regularizers.l2(1e-4))(x)
x = tf.keras.layers.Dropout(0.10)(x)
shared = tf.keras.layers.Dense(64, activation='relu', kernel_initializer='he_normal')(x)

outputs = []
for name in HEAD_NAMES:
    h = tf.keras.layers.Dense(24, activation='relu', name=f'{name}_h')(shared)
    o = tf.keras.layers.Dense(HEAD_SIZES[name], activation='softmax', name=f'{name}_out')(h)
    outputs.append(o)
all_out = tf.keras.layers.Concatenate(name='all_heads')(outputs)
actor = tf.keras.Model(inp, all_out)

critic_model = tf.keras.Sequential([
    tf.keras.layers.Dense(192, activation='relu', input_shape=(STATE_SIZE,), kernel_initializer='he_normal'),
    tf.keras.layers.Dense(96, activation='relu', kernel_initializer='he_normal'),
    tf.keras.layers.Dense(48, activation='relu', kernel_initializer='he_normal'),
    tf.keras.layers.Dense(1, kernel_initializer='glorot_normal'),
])

actor_opt = tf.keras.optimizers.Adam(LR)
critic_opt = tf.keras.optimizers.Adam(LR)

# Head offsets in concatenated output
head_offsets = {}
off = 0
for name in HEAD_NAMES:
    s = HEAD_SIZES[name]
    head_offsets[name] = (off, off + s)
    off += s

print(f"Model: {STATE_SIZE} features → 192→96→64 backbone → {len(HEAD_NAMES)} heads ({off} total outputs)")
print(f"Actor params: {actor.count_params():,}")
print(f"Critic params: {critic_model.count_params():,}\n")

total_wins, total_losses = 0, 0
start = time.time()

for p in range(1, PASSES + 1):
    # Sample batch
    idx = train_idx[np.random.choice(len(train_idx), SAMPLES_PER_PASS, replace=True)]
    batch_s = tf.constant(states[idx])

    # Forward
    all_probs = actor(batch_s, training=False).numpy()
    values = critic_model(batch_s, training=False).numpy().squeeze()
    B = len(idx)

    # Sample actions from ALL 8 heads
    actions = {}
    for name in HEAD_NAMES:
        s_off, e_off = head_offsets[name]
        probs = all_probs[:, s_off:e_off]
        cumprobs = np.cumsum(probs, axis=1)
        rand = np.random.random((B, 1)).astype(np.float32)
        acts = np.clip((rand >= cumprobs).sum(axis=1).astype(np.int32), 0, HEAD_SIZES[name] - 1)
        actions[name] = acts

    da = actions["direction"]; ra = actions["risk"]
    oe = actions["overExtension"]  # 0=TRADE, 1=SKIP
    eq = actions["entryQuality"]   # 0=ACCEPT_CAUTION, 1=WAIT_OPTIMAL
    st = actions["scoreThreshold"] # 0=LOW, 1=MEDIUM, 2=HIGH, 3=EXTRA

    # Vectorized outcome lookup
    oi = np.where(da == 1, outcome_long[idx], np.where(da == 2, outcome_short[idx], 4))

    # Base rewards from risk table
    rewards = REWARD_TABLES.numpy()[ra, oi]

    # Skip handling
    skip = da == 0
    rewards[skip & (oi < 3)] = -0.5
    rewards[skip & (oi == 3)] = 0.3
    rewards[skip & (oi >= 4)] = -0.1

    # ── New head reward multipliers (PPO Puro) ──────────────────────────
    ns = ~skip
    is_win = (oi < 3) & ns
    is_loss = (oi == 3) & ns
    batch_im = im_usage[idx]
    batch_sig = sig_quality[idx]
    high_exhaustion = batch_im > 1.5

    # OverExtension: reward skipping in exhausted markets, penalize trading into them
    overext_mult = np.ones(B, dtype=np.float32)
    overext_mult[(oe == 1) & high_exhaustion] = 1.3          # SKIP in exhaustion → bonus
    overext_mult[(oe == 0) & high_exhaustion & is_loss] = 0.5  # TRADE in exhaustion + loss → penalty

    # EntryQuality: reward patience
    qual_mult = np.ones(B, dtype=np.float32)
    qual_mult[(eq == 1) & is_win] = 1.2           # WAIT_OPTIMAL + win → bonus
    qual_mult[(eq == 0) & is_loss] = 0.7           # ACCEPT_CAUTION + loss → penalty

    # ScoreThreshold: reward strictness when signal quality is low
    thresh_mult = np.ones(B, dtype=np.float32)
    thresh_mult[(st == 3) & (batch_sig >= 4) & is_win] = 1.15   # EXTRA strict + high signal + win
    thresh_mult[(st == 0) & (batch_sig <= 2) & is_loss] = 0.6   # LOW strict + low signal + loss

    rewards *= overext_mult * qual_mult * thresh_mult

    pw = int(is_win.sum())
    pl = int(is_loss.sum())
    total_wins += pw; total_losses += pl

    # Advantages
    adv = rewards - values
    adv = np.clip((adv - adv.mean()) / (adv.std() + 1e-8), -5, 5).astype(np.float32)
    returns = np.clip(rewards, -10, 10).astype(np.float32)

    # TF gradient update — actor (all 8 heads)
    with tf.GradientTape() as tape:
        all_p = actor(batch_s, training=True)
        log_prob_sum = tf.zeros(B)
        entropy_sum = tf.zeros(B)
        for name in HEAD_NAMES:
            s_off, e_off = head_offsets[name]
            probs = tf.clip_by_value(all_p[:, s_off:e_off], 1e-8, 1.0)
            one_hot = tf.one_hot(actions[name], HEAD_SIZES[name])
            chosen_p = tf.reduce_sum(probs * one_hot, axis=1)
            log_prob_sum += tf.math.log(chosen_p)
            entropy_sum -= tf.reduce_sum(probs * tf.math.log(probs), axis=1)
        adv_t = tf.constant(adv)
        loss = -tf.reduce_mean(log_prob_sum * adv_t) - 0.02 * tf.reduce_mean(entropy_sum)
    grads = tape.gradient(loss, actor.trainable_variables)
    grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
    actor_opt.apply_gradients(zip(grads, actor.trainable_variables))

    # Critic update
    with tf.GradientTape() as tape:
        v = tf.squeeze(critic_model(batch_s, training=True))
        c_loss = tf.reduce_mean(tf.square(v - tf.constant(returns)))
    c_grads = tape.gradient(c_loss, critic_model.trainable_variables)
    c_grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in c_grads]
    critic_opt.apply_gradients(zip(c_grads, critic_model.trainable_variables))

    if p % 10 == 0 or p <= 3:
        el = time.time() - start
        eta = el / p * (PASSES - p)
        tr = total_wins + total_losses
        cwr = total_wins / tr * 100 if tr > 0 else 0
        rr = pw + pl
        wr = pw / rr * 100 if rr > 0 else 0

        # Head distribution summary
        head_dist = ""
        for hn in ["overExtension", "entryQuality", "scoreThreshold"]:
            s_o, e_o = head_offsets[hn]
            dist = np.bincount(actions[hn], minlength=HEAD_SIZES[hn])
            pcts = dist / dist.sum() * 100
            labels = HEAD_LABELS[hn]
            parts = [f"{labels[i]}:{pcts[i]:.0f}%" for i in range(len(labels))]
            head_dist += f" | {hn}: {' '.join(parts)}"

        print(f"Pass {p:>4}/{PASSES}: WR={wr:.1f}% (cum={cwr:.1f}%) [{el:.0f}s, ETA {eta:.0f}s]{head_dist}", flush=True)

elapsed = time.time() - start
tr = total_wins + total_losses
fwr = total_wins / tr * 100 if tr > 0 else 0
print(f"\n{'='*60}\nTRAINING COMPLETE\n{'='*60}")
print(f"Passes: {PASSES}\nDuration: {elapsed:.1f}s ({elapsed/60:.1f} min)\nFinal WR: {fwr:.1f}%")

# Walk-forward test
print(f"\n{'='*60}\nWALK-FORWARD TEST ({len(test_idx):,} episodes)\n{'='*60}")
test_s = tf.constant(states[test_idx])
tp = actor(test_s, training=False).numpy()
tw, tl, ts2 = 0, 0, 0
for i in range(len(test_idx)):
    gi = test_idx[i]
    dir_probs = tp[i, :3]
    da2 = np.argmax(dir_probs)
    if da2 == 0: ts2 += 1; continue
    if da2 == 1: o = outcome_long[gi]
    else: o = outcome_short[gi]
    if o < 3: tw += 1
    elif o == 3: tl += 1
tres = tw + tl
twr = tw / tres * 100 if tres > 0 else 0
print(f"Test WR: {twr:.1f}%\nWins: {tw:,}\nLosses: {tl:,}\nSkips: {ts2:,}\nResolved: {tres:,}")

# Save weights in compatible format (matches ppo-inference.ts)
model_dir = "/Users/samuellondono/spotgamma_monitor/data/ppo-multihead-model"
os.makedirs(model_dir, exist_ok=True)

# Extract weights layer by layer — backbone (6 weight tensors: w1,b1,w2,b2,w3,b3)
actor_weights = []
layer_map = [("w1",0),("b1",1),("w2",2),("b2",3),("w3",4),("b3",5)]
for wname, idx2 in layer_map:
    w = actor.trainable_variables[idx2].numpy()
    actor_weights.append({"name": wname, "shape": list(w.shape), "data": w.flatten().tolist()})

# Head weights start at index 6 (after backbone + 2 dropout layers which have no weights)
# Each head has: hidden_w, hidden_b, output_w, output_b = 4 tensors
hi = 6
for name in HEAD_NAMES:
    for suffix in ["w1","b1","w2","b2"]:
        w = actor.trainable_variables[hi].numpy()
        actor_weights.append({"name": f"{name}_{suffix}", "shape": list(w.shape), "data": w.flatten().tolist()})
        hi += 1

with open(os.path.join(model_dir, "actor-weights.json"), "w") as f:
    json.dump(actor_weights, f)

critic_weights = []
for i, wname in enumerate(["w1","b1","w2","b2","w3","b3","w4","b4"]):
    if i < len(critic_model.trainable_variables):
        w = critic_model.trainable_variables[i].numpy()
        critic_weights.append({"name": wname, "shape": list(w.shape), "data": w.flatten().tolist()})
with open(os.path.join(model_dir, "critic-weights.json"), "w") as f:
    json.dump(critic_weights, f)

state_info = {
    "totalEpisodes": int(N * PASSES), "totalWins": int(total_wins), "totalLosses": int(total_losses),
    "trainWR": float(fwr), "testWR": float(twr), "testWins": int(tw), "testLosses": int(tl),
    "walkForwardWR": float(twr), "winRate": float(fwr),
    "lastUpdated": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "architecture": "PPO_PURO_8heads_46features",
    "heads": HEAD_NAMES,
    "stateSize": STATE_SIZE,
    "gpu": bool(gpus),
}
with open(os.path.join(model_dir, "..", "ppo-multihead-state.json"), "w") as f:
    json.dump(state_info, f, indent=2)

print(f"\nWeights saved to {model_dir}")
print(f"Architecture: {STATE_SIZE} features → 192→96→64 → 8 heads ({off} outputs)")
print(f"Heads: {', '.join(HEAD_NAMES)}")
