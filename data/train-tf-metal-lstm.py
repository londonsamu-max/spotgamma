"""
train-tf-metal-lstm.py — Multi-Head PPO v6 con LSTM
=====================================================
Arquitectura dual-input:
  1. Rama LSTM:    secuencia de últimos SEQ_LEN días → LSTM(128) → contexto histórico
  2. Rama directa: estado actual del día → Dense(128) → representación actual
  Combina ambas → 8 cabezas de decisión

Ventaja sobre v5 (MLP plano):
  - El modelo ve UN MES de historia del gamma, HIRO, y mercado
  - Aprende que "gamma flip bajando 5 días seguidos" ≠ "gamma flip cayó hoy"
  - Captura patrones temporales: momentum de flujos, divergencias progresivas

Datos de entrada:
  - Histórico (training-data-445k.json): episodios desde 2022
  - Live (live-episodes.jsonl): trades reales si existen
"""
import json, time, sys, os, datetime
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import numpy as np
from collections import defaultdict

print("Loading TensorFlow with Metal GPU...", flush=True)
import tensorflow as tf
gpus = tf.config.list_physical_devices('GPU')
print(f"GPUs: {len(gpus)} {'(Metal)' if gpus else '(CPU only)'}", flush=True)

# ── Config ────────────────────────────────────────────────────────────────────
SEQ_LEN            = 10    # días (reducido de 20 → 2x menos BPTT, ≈ 2 semanas contexto)
LSTM_UNITS         = 64    # hidden state (reducido de 128 → 4x menos params recurrentes)
STATE_SIZE         = 94    # features expandidos (49 originales + 45 nuevos de SpotGamma)
COMBINED_SIZE      = LSTM_UNITS + STATE_SIZE  # 158

PASSES_SUPERVISED  = 50
PASSES_PPO         = 500   # máximo — early stopping activo (para si no mejora 60 passes)
SAMPLES_PER_PASS   = 4_000  # reducido de 9000 → 2.25x menos por pass
LR_SUPERVISED      = 8e-5
LR_PPO             = 3e-6   # más bajo: LSTM es más sensible al LR
CLIP_RATIO         = 0.2
PPO_EPOCHS         = 1
ENTROPY_COEFF           = 0.02
DIR_ENTROPY_BONUS       = 0.08
SECONDARY_ENTROPY_COEFF = 0.10
PASSES_SECONDARY_SUP    = 30
EARLY_STOP_PATIENCE     = 60
RECENCY_HALFLIFE        = 365.0
START_DATE              = "2022-01-01"
WINDOW_DAYS             = 60
MIN_ROLL_DAYS_ACT       = 10
Z_CLIP_RANGE            = 5.0

HEAD_NAMES = ["direction","risk","entry","sizing","session",
              "overExtension","entryQuality","scoreThreshold"]
HEAD_SIZES = {"direction":3,"risk":3,"entry":3,"sizing":3,"session":2,
              "overExtension":2,"entryQuality":2,"scoreThreshold":4}
HEAD_LABELS = {
    "direction":      ["SKIP","LONG","SHORT"],
    "risk":           ["tight","normal","wide"],
    "entry":          ["at_market","at_level","at_wall"],
    "sizing":         ["small","medium","full"],
    "session":        ["trade_now","wait"],
    "overExtension":  ["TRADE","SKIP"],
    "entryQuality":   ["ACCEPT_CAUTION","WAIT_OPTIMAL"],
    "scoreThreshold": ["LOW","MEDIUM","HIGH","EXTRA"],
}
OMAP = {"tp1":0,"tp2":1,"tp3":2,"sl":3,"cancelled":4}

# ── Cargar datos ──────────────────────────────────────────────────────────────
DATA_DIR  = "/Users/samuellondono/spotgamma_monitor/data"
HIST_PATH = os.path.join(DATA_DIR, "training-data-445k.json")
LIVE_PATH = os.path.join(DATA_DIR, "live-episodes.jsonl")
MODEL_DIR = os.path.join(DATA_DIR, "ppo-multihead-model-lstm")

print(f"Loading {HIST_PATH}...", flush=True)
with open(HIST_PATH) as f:
    raw_data = json.load(f)
print(f"Loaded {len(raw_data):,} historical episodes", flush=True)

# Cargar live episodes si existen
live_data = []
if os.path.exists(LIVE_PATH):
    with open(LIVE_PATH) as f:
        for line in f:
            line = line.strip()
            if line:
                try: live_data.append(json.loads(line))
                except: pass
    print(f"Loaded {len(live_data):,} live episodes", flush=True)

# ── Top-strike distance augmentation ─────────────────────────────────────────
def augment_top_strikes(s46, ep, noise_std=1.0):
    price = ep.get("price", 0)
    lg1 = ep.get("largeGamma1", 0) or ep.get("topStrike1", 0)
    lg2 = ep.get("largeGamma2", 0) or ep.get("topStrike2", 0)
    lg3 = ep.get("largeGamma3", 0) or ep.get("topStrike3", 0)
    def pct_dist(strike):
        if price > 0 and strike > 0:
            return (price - strike) / price * 100
        return float(np.clip(np.random.normal(0, noise_std), -6, 6))
    d1 = float(np.clip(pct_dist(lg1) / 2, -3, 3))
    d2 = float(np.clip(pct_dist(lg2) / 2, -3, 3))
    d3 = float(np.clip(pct_dist(lg3) / 2, -3, 3))
    return s46 + [d1, d2, d3]

def pad_state(s, ep):
    if len(s) == STATE_SIZE: return s
    if len(s) == 46: return augment_top_strikes(s, ep)
    if len(s) == 42:
        tn = ep.get("timeNorm", 0.48)
        st = 0 if tn<0.38 else 1 if tn<0.48 else 2 if tn<0.60 else 3 if tn<0.63 else 4
        im = ep.get("impliedMoveUsage", 1.0)
        s46 = s + [st/3-1, 0.0, 0.0, min(1, im/2)*2-1]
        return augment_top_strikes(s46, ep)
    return None

# ── Filtrar y cargar episodios ────────────────────────────────────────────────
states_list, all_ep_data = [], []
for ep in raw_data:
    if not ep.get("has1Min"): continue
    if (ep.get("date") or "") < START_DATE: continue
    s = ep.get("s", [])
    p = pad_state(s, ep)
    if p is not None and not any(not np.isfinite(v) for v in p):
        states_list.append(p)
        all_ep_data.append(ep)

# Agregar live episodes (tienen estado directamente en "state")
for ep in live_data:
    if ep.get("outcome") is None: continue  # solo cerrados
    s = ep.get("state", ep.get("rawState", []))
    if len(s) == STATE_SIZE and not any(not np.isfinite(v) for v in s):
        # Construir ep-like para compatibilidad
        ep_compat = {
            "date":              ep.get("date", ""),
            "has1Min":           True,
            "exactLong":         _live_outcome_to_exact(ep.get("outcome"), ep.get("action", {}).get("direction")),
            "exactShort":        _live_outcome_to_exact(ep.get("outcome"), ep.get("action", {}).get("direction"), short=True),
            "impliedMoveUsage":  ep.get("rawState", [1.0] * STATE_SIZE)[72] if len(ep.get("rawState", [])) > 72 else 1.0,
            "signalQuality":     0,
        }
        states_list.append(s)
        all_ep_data.append(ep_compat)

def _live_outcome_to_exact(outcome, direction, short=False):
    if outcome is None: return "cancelled"
    if outcome == "sl":
        return "sl"
    if not short:  # long perspective
        return outcome if direction == 1 else "sl"
    else:          # short perspective
        return outcome if direction == 2 else "sl"

states = np.array(states_list, dtype=np.float32)
N = len(states)
print(f"Clean episodes: {N:,}", flush=True)

# ── Rolling z-score ───────────────────────────────────────────────────────────
def compute_rolling_zscores(states_arr, dates_arr):
    states_z = states_arr.copy()
    day_mean = defaultdict(list)
    for i, d in enumerate(dates_arr):
        day_mean[d].append(states_arr[i])
    day_mean = {d: np.mean(v, axis=0) for d, v in day_mean.items()}
    sorted_days = sorted(day_mean.keys())
    date_to_stats = {}
    for idx, d in enumerate(sorted_days):
        window_days = [dd for dd in sorted_days[max(0, idx-WINDOW_DAYS):idx] if dd in day_mean]
        if len(window_days) < MIN_ROLL_DAYS_ACT:
            date_to_stats[d] = None
            continue
        arr   = np.array([day_mean[dd] for dd in window_days], dtype=np.float64)
        mu    = arr.mean(axis=0)
        sigma = arr.std(axis=0) + 1e-6
        date_to_stats[d] = (mu.astype(np.float32), sigma.astype(np.float32))
    for i in range(len(states_arr)):
        stats = date_to_stats.get(dates_arr[i])
        if stats is None: continue
        mu, sigma = stats
        states_z[i] = np.clip((states_arr[i] - mu) / sigma, -Z_CLIP_RANGE, Z_CLIP_RANGE)
    return states_z

dates = np.array([ep.get("date", "") for ep in all_ep_data])
print("Computing rolling z-scores...", flush=True)
states = compute_rolling_zscores(states, dates)

# ── Construir secuencias diarias para LSTM ────────────────────────────────────
# Para cada día, promediamos todos los episodios de ese día → estado diario
print("Building daily LSTM sequences...", flush=True)

daily_states = defaultdict(list)
for i, ep in enumerate(all_ep_data):
    d = ep.get("date", "")
    if d: daily_states[d].append(states[i])

daily_avg = {d: np.mean(v, axis=0) for d, v in daily_states.items()}
sorted_days = sorted(daily_avg.keys())
date_to_dayidx = {d: i for i, d in enumerate(sorted_days)}

# Construir secuencia para cada episodio: últimos SEQ_LEN días ANTES de la fecha del ep
sequences = np.zeros((N, SEQ_LEN, STATE_SIZE), dtype=np.float32)
for i, ep in enumerate(all_ep_data):
    d = ep.get("date", "")
    if d not in date_to_dayidx: continue
    d_idx = date_to_dayidx[d]
    # Tomar los SEQ_LEN días anteriores (sin incluir el día actual → no look-ahead)
    for seq_pos in range(SEQ_LEN):
        src_day_idx = d_idx - SEQ_LEN + seq_pos
        if src_day_idx >= 0:
            src_day = sorted_days[src_day_idx]
            if src_day in daily_avg:
                sequences[i, seq_pos] = daily_avg[src_day]
            # Si el día no tiene datos: queda en cero (padding)

print(f"Sequences built: {sequences.shape}", flush=True)

# ── Walk-forward split ────────────────────────────────────────────────────────
sorted_idx = np.argsort(dates)
split      = int(N * 0.8)
train_idx  = sorted_idx[:split].copy()
test_idx   = sorted_idx[split:]
print(f"Train: {len(train_idx):,}  Test: {len(test_idx):,}", flush=True)

# ── Outcomes y labels ─────────────────────────────────────────────────────────
outcome_long  = np.full(N, 4, dtype=np.int32)
outcome_short = np.full(N, 4, dtype=np.int32)
for gi in range(N):
    ep = all_ep_data[gi]
    outcome_long[gi]  = OMAP.get(ep.get("exactLong","cancelled")  or "cancelled", 4)
    outcome_short[gi] = OMAP.get(ep.get("exactShort","cancelled") or "cancelled", 4)

im_usage    = np.array([ep.get("impliedMoveUsage", 1.0) for ep in all_ep_data], dtype=np.float32)
sig_quality = np.array([ep.get("signalQuality", 0)      for ep in all_ep_data], dtype=np.float32)

# Labels de dirección
dir_labels = np.zeros(N, dtype=np.int32)  # 0=SKIP
for i in range(N):
    ol, os_ = outcome_long[i], outcome_short[i]
    long_wins  = ol  < 3
    short_wins = os_ < 3
    long_loses = ol  == 3
    short_loses= os_ == 3
    if long_wins  and short_loses: dir_labels[i] = 1  # LONG
    elif short_wins and long_loses: dir_labels[i] = 2  # SHORT

# Labels secundarias
both_sl   = (outcome_long == 3) & (outcome_short == 3)
oe_labels = both_sl.astype(np.int32)
eq_labels = (sig_quality >= 3.0).astype(np.int32)
st_labels = np.where(sig_quality <= 1, 0,
            np.where(sig_quality <= 2, 1,
            np.where(sig_quality <= 3, 2, 3))).astype(np.int32)

# Splits balanceados para training
long_idx  = train_idx[dir_labels[train_idx] == 1]
short_idx = train_idx[dir_labels[train_idx] == 2]
skip_idx  = train_idx[dir_labels[train_idx] == 0]

# Recency weights
today_d = datetime.date.today()
def recency_weight(date_str):
    try:
        d = datetime.date.fromisoformat(date_str)
        age_days = max(0, (today_d - d).days)
        return float(np.exp(-age_days * np.log(2) / RECENCY_HALFLIFE))
    except: return 1.0

weights = np.array([recency_weight(ep.get("date","")) for ep in all_ep_data], dtype=np.float32)

# ── Arquitectura dual-input LSTM ─────────────────────────────────────────────
print("Building LSTM model...", flush=True)

# Rama 1: LSTM sobre secuencia histórica
seq_input = tf.keras.Input(shape=(SEQ_LEN, STATE_SIZE), name="seq_input")
lstm_out  = tf.keras.layers.LSTM(LSTM_UNITS, name="lstm_encoder")(seq_input)
lstm_proj = tf.keras.layers.Dense(128, activation="relu", name="lstm_proj")(lstm_out)

# Rama 2: estado actual
cur_input = tf.keras.Input(shape=(STATE_SIZE,), name="cur_input")
cur_proj  = tf.keras.layers.Dense(128, activation="relu", name="cur_proj")(cur_input)

# Fusión
combined = tf.keras.layers.Concatenate(name="combined")([lstm_proj, cur_proj])  # (256,)
shared1  = tf.keras.layers.Dense(256, activation="relu", name="shared1")(combined)
shared2  = tf.keras.layers.Dense(128, activation="relu", name="shared2")(shared1)
trunk    = tf.keras.layers.Dense(64,  activation="relu", name="trunk")(shared2)

# 8 cabezas
head_outputs = {}
for hn in HEAD_NAMES:
    h1 = tf.keras.layers.Dense(32, activation="relu", name=f"{hn}_h1")(trunk)
    h2 = tf.keras.layers.Dense(HEAD_SIZES[hn], activation="softmax", name=f"{hn}_out")(h1)
    head_outputs[hn] = h2

actor = tf.keras.Model(
    inputs=[seq_input, cur_input],
    outputs=list(head_outputs.values()),
    name="actor_lstm"
)

# Critic (igual estructura)
c_combined = tf.keras.layers.Concatenate()([lstm_proj, cur_proj])
c1 = tf.keras.layers.Dense(128, activation="relu")(c_combined)
c2 = tf.keras.layers.Dense(64,  activation="relu")(c1)
v  = tf.keras.layers.Dense(1)(c2)
critic_model = tf.keras.Model(inputs=[seq_input, cur_input], outputs=v, name="critic_lstm")

print(f"Actor  params: {actor.count_params():,}", flush=True)
print(f"Critic params: {critic_model.count_params():,}", flush=True)

actor_opt  = tf.keras.optimizers.Adam(LR_SUPERVISED)
critic_opt = tf.keras.optimizers.Adam(LR_SUPERVISED)

# ── @tf.function wrappers — compilan el graph → 3-5x más rápido ─────────────
@tf.function
def train_secondary(seq_b, cur_b, oe_b, eq_b, st_b):
    with tf.GradientTape() as tape:
        outs      = actor([seq_b, cur_b], training=True)
        oe_logits = outs[HEAD_NAMES.index("overExtension")]
        eq_logits = outs[HEAD_NAMES.index("entryQuality")]
        st_logits = outs[HEAD_NAMES.index("scoreThreshold")]
        loss = (tf.reduce_mean(tf.keras.losses.sparse_categorical_crossentropy(oe_b, oe_logits))
              + tf.reduce_mean(tf.keras.losses.sparse_categorical_crossentropy(eq_b, eq_logits))
              + tf.reduce_mean(tf.keras.losses.sparse_categorical_crossentropy(st_b, st_logits)))
    grads = tape.gradient(loss, actor.trainable_variables)
    grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
    actor_opt.apply_gradients(zip(grads, actor.trainable_variables))
    return loss

@tf.function
def train_supervised(seq_b, cur_b, dir_b, w_b):
    with tf.GradientTape() as tape:
        outs    = actor([seq_b, cur_b], training=True)
        dir_out = outs[0]
        dir_loss = tf.reduce_mean(w_b * tf.keras.losses.sparse_categorical_crossentropy(dir_b, dir_out))
        dir_ent  = -tf.reduce_mean(tf.reduce_sum(dir_out * tf.math.log(dir_out + 1e-8), axis=1))
        loss     = dir_loss - DIR_ENTROPY_BONUS * dir_ent
    grads = tape.gradient(loss, actor.trainable_variables)
    grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
    actor_opt.apply_gradients(zip(grads, actor.trainable_variables))
    return loss

@tf.function
def train_ppo_actor(seq_b, cur_b, dir_b_tf, old_logp_tf, adv_tf, w_tf):
    with tf.GradientTape() as tape:
        outs    = actor([seq_b, cur_b], training=True)
        dir_out = outs[0]
        new_logp = tf.math.log(tf.gather(dir_out, dir_b_tf, batch_dims=1) + 1e-8)
        ratio    = tf.exp(new_logp - old_logp_tf)
        surr1    = ratio * adv_tf
        surr2    = tf.clip_by_value(ratio, 1-CLIP_RATIO, 1+CLIP_RATIO) * adv_tf
        pg_loss  = -tf.reduce_mean(w_tf * tf.minimum(surr1, surr2))
        total_ent = tf.constant(0.0)
        for hi, hn in enumerate(HEAD_NAMES):
            probs = outs[hi]
            ent   = -tf.reduce_mean(tf.reduce_sum(probs * tf.math.log(probs + 1e-8), axis=1))
            coeff = DIR_ENTROPY_BONUS if hn == "direction" else (SECONDARY_ENTROPY_COEFF if hn in ["overExtension","entryQuality","scoreThreshold"] else ENTROPY_COEFF)
            total_ent = total_ent + coeff * ent
        actor_loss = pg_loss - total_ent
    grads = tape.gradient(actor_loss, actor.trainable_variables)
    grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
    actor_opt.apply_gradients(zip(grads, actor.trainable_variables))
    return actor_loss

@tf.function
def train_critic(seq_b, cur_b, rewards_tf):
    with tf.GradientTape() as tape:
        v      = tf.squeeze(critic_model([seq_b, cur_b], training=True))
        c_loss = tf.reduce_mean(tf.square(v - rewards_tf))
    c_grads = tape.gradient(c_loss, critic_model.trainable_variables)
    c_grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in c_grads]
    critic_opt.apply_gradients(zip(c_grads, critic_model.trainable_variables))
    return c_loss

# ── Head offsets para logits concatenados ─────────────────────────────────────
head_offsets = {}
offset = 0
for hn in HEAD_NAMES:
    head_offsets[hn] = (offset, offset + HEAD_SIZES[hn])
    offset += HEAD_SIZES[hn]
TOTAL_HEADS_OUT = offset

# ── Helpers ───────────────────────────────────────────────────────────────────
def sample_balanced(n_per_class):
    li = np.random.choice(long_idx,  min(n_per_class, len(long_idx)),  replace=len(long_idx)<n_per_class)
    si = np.random.choice(short_idx, min(n_per_class, len(short_idx)), replace=len(short_idx)<n_per_class)
    ki = np.random.choice(skip_idx,  min(n_per_class, len(skip_idx)),  replace=len(skip_idx)<n_per_class)
    idx = np.concatenate([li, si, ki])
    np.random.shuffle(idx)
    return idx

def predict_all(idx_arr):
    seq_b = sequences[idx_arr]
    cur_b = states[idx_arr]
    outs  = actor([seq_b, cur_b], training=False)
    return [o.numpy() for o in outs]

def eval_all_metrics(idx_arr):
    outs = predict_all(idx_arr)
    dir_probs = outs[0]
    dir_act   = np.argmax(dir_probs, axis=1)
    skip_mask = dir_act == 0
    trade_mask= ~skip_mask

    if trade_mask.sum() == 0:
        return 0.0, 0.0, 0.0, 100.0, 0, len(idx_arr)

    traded_idx = idx_arr[trade_mask]
    dir_traded = dir_act[trade_mask]
    ol_t = outcome_long[traded_idx]
    os_t = outcome_short[traded_idx]

    long_traded  = traded_idx[dir_traded == 1]
    short_traded = traded_idx[dir_traded == 2]

    long_wins  = int(np.sum(outcome_long[long_traded]   < 3)) if len(long_traded)  > 0 else 0
    short_wins = int(np.sum(outcome_short[short_traded] < 3)) if len(short_traded) > 0 else 0
    total_wins = long_wins + short_wins
    total_trades= len(traded_idx)

    naive_wr = total_wins / total_trades * 100 if total_trades > 0 else 0

    # Direction accuracy (clear-direction episodes)
    is_clear_long  = (outcome_long  < 3) & (outcome_short == 3)
    is_clear_short = (outcome_short < 3) & (outcome_long  == 3)
    clear_mask = is_clear_long[traded_idx] | is_clear_short[traded_idx]
    dir_correct = (
        (dir_traded[is_clear_long[traded_idx]]  == 1).sum() +
        (dir_traded[is_clear_short[traded_idx]] == 2).sum()
    )
    dir_total = clear_mask.sum()
    dir_acc = dir_correct / dir_total * 100 if dir_total > 0 else 0

    # Skip quality
    skipped_idx = idx_arr[skip_mask]
    if len(skipped_idx) > 0:
        ol_s = outcome_long[skipped_idx]
        os_s = outcome_short[skipped_idx]
        both_win   = ((ol_s < 3) & (os_s < 3)).sum()
        both_loss  = ((ol_s == 3) & (os_s == 3)).sum()
        skip_good  = both_loss
        skip_total = len(skipped_idx)
        skip_q = skip_good / skip_total * 100 if skip_total > 0 else 0
    else:
        skip_q = 0.0

    skip_pct = skip_mask.sum() / len(idx_arr) * 100
    return float(dir_acc), float(skip_q), float(naive_wr), float(skip_pct), int(dir_total), int(skip_mask.sum())

# ── Fase 0: Supervisado de cabezas secundarias ────────────────────────────────
print(f"\n{'='*60}")
print(f"FASE 0 — Supervisado ({PASSES_SECONDARY_SUP} passes) — cabezas secundarias")
print(f"{'='*60}\n", flush=True)

oe_labels_tf = tf.constant(oe_labels, dtype=tf.int32)
eq_labels_tf = tf.constant(eq_labels, dtype=tf.int32)
st_labels_tf = tf.constant(st_labels, dtype=tf.int32)
N_PER  = SAMPLES_PER_PASS // 3
start0 = time.time()

for p in range(1, PASSES_SECONDARY_SUP + 1):
    idx    = sample_balanced(N_PER)
    seq_b  = tf.constant(sequences[idx], dtype=tf.float32)
    cur_b  = tf.constant(states[idx],    dtype=tf.float32)
    oe_b   = tf.gather(oe_labels_tf, idx)
    eq_b   = tf.gather(eq_labels_tf, idx)
    st_b   = tf.gather(st_labels_tf, idx)

    loss = train_secondary(seq_b, cur_b, oe_b, eq_b, st_b)

    if p % 10 == 0 or p == PASSES_SECONDARY_SUP:
        outs_v = predict_all(idx)
        oe_dist = np.bincount(np.argmax(outs_v[HEAD_NAMES.index("overExtension")], axis=1), minlength=2)
        eq_dist = np.bincount(np.argmax(outs_v[HEAD_NAMES.index("entryQuality")],  axis=1), minlength=2)
        st_dist = np.bincount(np.argmax(outs_v[HEAD_NAMES.index("scoreThreshold")],axis=1), minlength=4)
        oe_p = oe_dist/oe_dist.sum()*100; eq_p = eq_dist/eq_dist.sum()*100; st_p = st_dist/st_dist.sum()*100
        print(f"[SEC] Pass {p:>3}/{PASSES_SECONDARY_SUP}: loss={loss.numpy():.4f}  "
              f"overExtension:[{oe_p[0]:.0f}%/{oe_p[1]:.0f}%]  "
              f"entryQuality:[{eq_p[0]:.0f}%/{eq_p[1]:.0f}%]  "
              f"scoreThreshold:[{st_p[0]:.0f}%/{st_p[1]:.0f}%/{st_p[2]:.0f}%/{st_p[3]:.0f}%]", flush=True)

print(f"Fase 0 done ({time.time()-start0:.1f}s)\n", flush=True)

# ── Fase 1: Supervisado de direction head ─────────────────────────────────────
print(f"{'='*60}")
print(f"FASE 1 — Supervisado ({PASSES_SUPERVISED} passes) — direction head")
print(f"{'='*60}\n", flush=True)

dir_labels_tf = tf.constant(dir_labels, dtype=tf.int32)
best_dir_acc  = 0.0
best_adj      = 0.0
patience_sup  = 0
best_sup_w    = [v.numpy().copy() for v in actor.trainable_variables]
start1 = time.time()

for p in range(1, PASSES_SUPERVISED + 1):
    idx   = sample_balanced(N_PER)
    seq_b = tf.constant(sequences[idx], dtype=tf.float32)
    cur_b = tf.constant(states[idx],    dtype=tf.float32)
    dir_b = tf.gather(dir_labels_tf, idx)
    w_b   = tf.constant(weights[idx], dtype=tf.float32)

    loss = train_supervised(seq_b, cur_b, dir_b, w_b)

    if p % 10 == 0 or p <= 3 or p == PASSES_SUPERVISED:
        da, sq, nwr, skp, _, _ = eval_all_metrics(test_idx)
        skip_pen = max(0, (skp - 60) / 40)
        adj      = da * (1 - skip_pen)
        tag = ""
        if adj > best_adj:
            best_adj     = adj
            best_dir_acc = da
            patience_sup = 0
            best_sup_w   = [v.numpy().copy() for v in actor.trainable_variables]
            tag = f" [★best adj={adj:.1f}]"
        else:
            patience_sup += 1
            tag = " [pat]" if p == PASSES_SUPERVISED else ""
        print(f"[SUP] Pass {p:>3}/{PASSES_SUPERVISED}: loss={loss.numpy():.4f}  "
              f"dirAcc={da:.1f}%  skipQ={sq:.1f}%  naiveWR={nwr:.1f}%  skip={skp:.0f}%{tag}", flush=True)

print(f"\n★ Best supervised dirAcc={best_dir_acc:.1f}% (adj={best_adj:.1f})")
print("Restoring best supervised weights...")
for var, w in zip(actor.trainable_variables, best_sup_w):
    var.assign(w)

# ── Fase 2: PPO ───────────────────────────────────────────────────────────────
print(f"\n{'='*60}")
print(f"FASE 2 — PPO con ratio clipping ({PASSES_PPO} passes)")
print(f"{'='*60}\n", flush=True)

actor_opt  = tf.keras.optimizers.Adam(LR_PPO)
critic_opt = tf.keras.optimizers.Adam(LR_PPO)

best_dir_acc_ppo  = best_adj
best_pass_ppo     = 0
patience_count    = 0
best_actor_w_ppo  = [v.numpy().copy() for v in actor.trainable_variables]

start2 = time.time()
total_wins, total_losses, pw, pl = 0, 0, 0, 0

for p in range(1, PASSES_PPO + 1):
    npc = SAMPLES_PER_PASS // 3
    idx = sample_balanced(npc)
    seq_b = tf.constant(sequences[idx], dtype=tf.float32)
    cur_b = tf.constant(states[idx],    dtype=tf.float32)
    w_b   = tf.constant(weights[idx],   dtype=tf.float32)

    # Old log-probs
    old_outs = actor([seq_b, cur_b], training=False)
    old_dir  = old_outs[0].numpy()
    dir_b    = dir_labels[idx]
    old_logp = np.log(old_dir[np.arange(len(idx)), dir_b] + 1e-8)

    # Rewards — vectorizado con numpy (sin loop Python)
    ol_b = outcome_long[idx]; os_b = outcome_short[idx]
    is_long  = (dir_b == 1); is_short = (dir_b == 2); is_skip = (dir_b == 0)
    long_win  = is_long  & (ol_b < 3);  long_loss  = is_long  & (ol_b == 3)
    short_win = is_short & (os_b < 3);  short_loss = is_short & (os_b == 3)
    skip_good = is_skip  & (ol_b == 3) & (os_b == 3)
    rewards = np.where(long_win | short_win, 1.0,
              np.where(long_loss | short_loss, -1.0,
              np.where(skip_good, 0.2, np.where(is_skip, -0.05, 0.0)))).astype(np.float32)
    pw += int(np.sum(long_win | short_win))
    pl += int(np.sum(long_loss | short_loss))
    total_wins   += int(np.sum((rewards > 0) & ~is_skip))
    total_losses += int(np.sum((rewards < 0) & ~is_skip))

    # Critic values → advantages
    v_preds = tf.squeeze(critic_model([seq_b, cur_b], training=False)).numpy()
    adv     = (rewards - v_preds)
    adv     = (adv - adv.mean()) / (adv.std() + 1e-8)

    # PPO update — @tf.function compilado
    dir_b_tf   = tf.constant(dir_b,   dtype=tf.int32)
    old_logp_tf= tf.constant(old_logp, dtype=tf.float32)
    adv_tf     = tf.constant(adv,     dtype=tf.float32)
    w_tf       = tf.constant(w_b,     dtype=tf.float32)
    rewards_tf = tf.constant(rewards, dtype=tf.float32)
    for _ in range(PPO_EPOCHS):
        train_ppo_actor(seq_b, cur_b, dir_b_tf, old_logp_tf, adv_tf, w_tf)
    train_critic(seq_b, cur_b, rewards_tf)

    if p % 10 == 0 or p <= 3:
        el  = time.time() - start2
        eta = el / p * (PASSES_PPO - p)
        tr  = total_wins + total_losses
        cwr = total_wins / tr * 100 if tr > 0 else 0
        rr  = pw + pl
        wr  = pw / rr * 100 if rr > 0 else 0

        da_v, sq_v, nwr_v, skpct_v, dtot_v, stot_v = eval_all_metrics(test_idx)
        composite_v = da_v * 0.6 + sq_v * 0.4

        if composite_v > best_dir_acc_ppo:
            best_dir_acc_ppo = composite_v
            best_pass_ppo    = p
            patience_count   = 0
            best_actor_w_ppo = [v.numpy().copy() for v in actor.trainable_variables]
            tag = f" [★best comp={composite_v:.1f}]"
        else:
            patience_count += 1
            tag = f" [pat:{patience_count}/{EARLY_STOP_PATIENCE}]"

        dir_dist = np.bincount(np.argmax(predict_all(idx)[0], axis=1), minlength=3)
        dir_pcts = dir_dist / dir_dist.sum() * 100
        he_dist  = f" | dir: SKIP:{dir_pcts[0]:.0f}% LONG:{dir_pcts[1]:.0f}% SHORT:{dir_pcts[2]:.0f}%"

        print(f"[PPO] Pass {p:>4}/{PASSES_PPO}: "
              f"trainWR={wr:.1f}%(cum={cwr:.1f}%) "
              f"dirAcc={da_v:.1f}% skipQ={sq_v:.1f}% naiveWR={nwr_v:.1f}% "
              f"[{el:.0f}s ETA {eta:.0f}s]{tag}{he_dist}", flush=True)

        if patience_count >= EARLY_STOP_PATIENCE:
            print(f"\n⚡ Early stopping pass {p}")
            break

        pw, pl = 0, 0  # reset per-pass counters

# Restaurar mejores pesos
print(f"\nRestoring best PPO weights (pass {best_pass_ppo}, comp={best_dir_acc_ppo:.1f}%)")
for var, w in zip(actor.trainable_variables, best_actor_w_ppo):
    var.assign(w)

# ── Evaluación final ──────────────────────────────────────────────────────────
elapsed = time.time() - start1
da_f, sq_f, nwr_f, skpct_f, dtot_f, stot_f = eval_all_metrics(test_idx)

print(f"\n{'='*60}\nTRAINING COMPLETE (LSTM v6)\n{'='*60}")
print(f"Duration: {elapsed:.1f}s ({elapsed/60:.1f} min)")
print(f"\n{'='*60}\nFINAL TEST METRICS ({len(test_idx):,} episodes)\n{'='*60}")
print(f"Direction Accuracy:  {da_f:.1f}%  ({dtot_f:,} clear-direction trades)")
print(f"Skip Quality:        {sq_f:.1f}%  ({stot_f:,} skipped trades)")
print(f"Naive WR:            {nwr_f:.1f}%")
print(f"Skip rate:           {skpct_f:.1f}%")

base_long_wins  = int(np.sum(outcome_long[test_idx]  < 3))
base_long_loss  = int(np.sum(outcome_long[test_idx]  == 3))
baseline_long_wr= base_long_wins / (base_long_wins+base_long_loss) * 100
print(f"\nBaseline LONG: {baseline_long_wr:.1f}%")
print(f"Modelo añade:  {nwr_f-baseline_long_wr:+.1f}pp")

print(f"\n{'='*60}\nROLLING WALK-FORWARD (4 ventanas)\n{'='*60}")
wdas = []
for w_i in range(1, 5):
    ws = int(N * w_i * 0.2); we = int(N * min((w_i+1)*0.2, 1.0))
    wt = sorted_idx[ws:we]
    if len(wt) == 0: continue
    wda, wsq, wnwr, wskp, _, _ = eval_all_metrics(wt)
    wdas.append(wda)
    print(f"  W{w_i} (test {w_i*20}-{min((w_i+1)*20,100)}%): "
          f"dirAcc={wda:.1f}%  skipQ={wsq:.1f}%  naiveWR={wnwr:.1f}%  skip={wskp:.0f}%")
print(f"\nAvg rolling dirAcc: {np.mean(wdas):.1f}%")

# ── Guardar pesos ─────────────────────────────────────────────────────────────
os.makedirs(MODEL_DIR, exist_ok=True)

# Extraer pesos del actor por nombre de capa
def get_layer_weights(model, layer_name):
    layer = model.get_layer(layer_name)
    return layer.get_weights()

# LSTM weights (kernel, recurrent_kernel, bias)
lstm_w = get_layer_weights(actor, "lstm_encoder")
lstm_kernel    = lstm_w[0].tolist()  # (STATE_SIZE, 4*LSTM_UNITS)
lstm_rec_kernel= lstm_w[1].tolist()  # (LSTM_UNITS, 4*LSTM_UNITS)
lstm_bias      = lstm_w[2].tolist()  # (4*LSTM_UNITS,)

# Projection layers
lstm_proj_w = get_layer_weights(actor, "lstm_proj")
cur_proj_w  = get_layer_weights(actor, "cur_proj")
shared1_w   = get_layer_weights(actor, "shared1")
shared2_w   = get_layer_weights(actor, "shared2")
trunk_w     = get_layer_weights(actor, "trunk")

# Head weights
head_weights = {}
for hn in HEAD_NAMES:
    h1_w = get_layer_weights(actor, f"{hn}_h1")
    h2_w = get_layer_weights(actor, f"{hn}_out")
    head_weights[hn] = {
        "h1_w": h1_w[0].tolist(), "h1_b": h1_w[1].tolist(),
        "h2_w": h2_w[0].tolist(), "h2_b": h2_w[1].tolist(),
    }

actor_data = {
    "lstm_kernel":     lstm_kernel,
    "lstm_rec_kernel": lstm_rec_kernel,
    "lstm_bias":       lstm_bias,
    "lstm_proj_w":     lstm_proj_w[0].tolist(), "lstm_proj_b": lstm_proj_w[1].tolist(),
    "cur_proj_w":      cur_proj_w[0].tolist(),  "cur_proj_b":  cur_proj_w[1].tolist(),
    "shared1_w":       shared1_w[0].tolist(),   "shared1_b":   shared1_w[1].tolist(),
    "shared2_w":       shared2_w[0].tolist(),   "shared2_b":   shared2_w[1].tolist(),
    "trunk_w":         trunk_w[0].tolist(),     "trunk_b":     trunk_w[1].tolist(),
    "heads":           head_weights,
    "lstm_units":      LSTM_UNITS,
    "seq_len":         SEQ_LEN,
    "state_size":      STATE_SIZE,
}

import json as jsonmod
with open(os.path.join(MODEL_DIR, "actor-weights-lstm.json"), "w") as f:
    jsonmod.dump(actor_data, f)

version = {
    "version":    "lstm-v6",
    "dirAcc":     round(da_f, 2),
    "skipQ":      round(sq_f, 2),
    "naiveWR":    round(nwr_f, 2),
    "avgRolling": round(float(np.mean(wdas)), 2),
    "trained":    datetime.datetime.now().isoformat(),
    "seqLen":     SEQ_LEN,
    "lstmUnits":  LSTM_UNITS,
    "stateSize":  STATE_SIZE,
    "nEpisodes":  N,
    "nLive":      len(live_data),
}
with open(os.path.join(MODEL_DIR, "version.json"), "w") as f:
    jsonmod.dump(version, f, indent=2)

print(f"\n✅ LSTM weights saved to {MODEL_DIR}")
print(f"   dirAcc={da_f:.1f}% | naiveWR={nwr_f:.1f}% | seqLen={SEQ_LEN} | lstmUnits={LSTM_UNITS}")
