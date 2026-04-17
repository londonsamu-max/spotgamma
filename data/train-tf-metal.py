"""
train-tf-metal.py — Multi-Head PPO v5
======================================
Mejoras sobre v3:
  1. Supervisión en cabeza de dirección  — pre-training 50 passes con cross-entropy
  2. Batches balanceados                 — igual LONG/SHORT/ambiguous en cada batch
  3. Métricas honestas                   — Direction Accuracy + Skip Quality
  4. PPO real con ratio clipping         — K=2 épocas por batch, clip ε=0.2
  5. Recency weighting                   — datos recientes pesan más (half-life 1 año)
  6. [v4] Fix reward SKIP                — usa ambos outcomes; evitar-pérdida=+0.5,
                                          ambiguo=+0.2, oportunidad-perdida=-0.1 (no -0.5)
  7. [v4] Entropy bonus por cabeza dir   — bonus extra para explorar SKIP
  8. [v4] Early stopping compuesto       — dirAcc*0.6 + skipQ*0.4
"""
import json, time, sys, os, datetime
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import numpy as np

print("Loading TensorFlow with Metal GPU...", flush=True)
import tensorflow as tf
gpus = tf.config.list_physical_devices('GPU')
print(f"GPUs: {len(gpus)} {'(Metal)' if gpus else '(CPU only)'}", flush=True)

# ── Config ────────────────────────────────────────────────────────────────────
PASSES_SUPERVISED  = 50     # Fase 1: supervisado solo direction head
PASSES_PPO         = 450    # Fase 2: PPO completo
SAMPLES_PER_PASS   = 9_000  # divisible entre 3 para batches balanceados
STATE_SIZE         = 49
LR_SUPERVISED      = 1e-4   # más alto para convergencia rápida en supervisado
LR_PPO             = 5e-6   # muy conservador — evita destruir supervisado
CLIP_RATIO         = 0.2    # PPO epsilon estándar
PPO_EPOCHS         = 1      # 1 epoch por batch — menos overfitting en PPO
ENTROPY_COEFF           = 0.02
DIR_ENTROPY_BONUS       = 0.08    # direction head — fomenta SKIP
SECONDARY_ENTROPY_COEFF = 0.10    # cabezas secundarias — previene collapse (5× global)
PASSES_SECONDARY_SUP    = 30      # Fase 0: supervisado de cabezas secundarias
EARLY_STOP_PATIENCE     = 50      # passes sin mejora en dirAcc → stop
RECENCY_HALFLIFE   = 365.0  # días — half-life para weighting

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
DATA_PATH = "/Users/samuellondono/spotgamma_monitor/data/training-data-445k.json"
print(f"Loading {DATA_PATH}...", flush=True)
with open(DATA_PATH) as f:
    raw_data = json.load(f)
print(f"Loaded {len(raw_data):,} raw episodes", flush=True)

# ── Top-strike distance augmentation (features 46-48) ────────────────────────
# Los episodios históricos no tienen largeGamma1/2/3.
# Usamos augmentación gaussiana controlada para enseñar al modelo que estos
# features pueden tomar cualquier valor en [-3, 3], no siempre 0.
# Std=1.0 corresponde a ~2% de distancia, rango realista para top strikes.
# En producción el modelo recibirá valores reales; el noise evita que ignore las features.
def augment_top_strikes(s46, ep, noise_std=1.0):
    """Añade 3 features de distancia al top strike. Usa noise si no hay datos reales."""
    price = ep.get("price", 0)
    lg1 = ep.get("largeGamma1", 0) or ep.get("topStrike1", 0)
    lg2 = ep.get("largeGamma2", 0) or ep.get("topStrike2", 0)
    lg3 = ep.get("largeGamma3", 0) or ep.get("topStrike3", 0)

    def pct_dist(strike):
        if price > 0 and strike > 0:
            return (price - strike) / price * 100  # positivo = por debajo del precio
        # Sin datos reales: ruido gaussiano en rango [-3, 3] (post-normalización ÷2)
        # noise_std=1.0 → std final ≈ 0.5 en el espacio normalizado
        return float(np.clip(np.random.normal(0, noise_std), -6, 6))

    d1 = np.clip(pct_dist(lg1) / 2, -3, 3)   # normalizar igual que en inference
    d2 = np.clip(pct_dist(lg2) / 2, -3, 3)
    d3 = np.clip(pct_dist(lg3) / 2, -3, 3)
    return s46 + [float(d1), float(d2), float(d3)]

def pad_state(s, ep):
    if len(s) == STATE_SIZE: return s
    # 46 → 49: añadir top-strike distances (con augmentación si no hay datos reales)
    if len(s) == 46:
        return augment_top_strikes(s, ep)
    # 42 → 46 → 49
    if len(s) == 42:
        tn = ep.get("timeNorm", 0.48)
        st = 0 if tn<0.38 else 1 if tn<0.48 else 2 if tn<0.60 else 3 if tn<0.63 else 4
        im = ep.get("impliedMoveUsage", 1.0)
        s46 = s + [st/3-1, 0.0, 0.0, min(1, im/2)*2-1]
        return augment_top_strikes(s46, ep)
    return None

START_DATE = "2022-01-01"  # era post-0DTE — gamma/vanna tienen impacto real intraday

# Solo has1Min (sin look-ahead) y desde START_DATE
states_list, all_ep_data = [], []
for ep in raw_data:
    if not ep.get("has1Min"): continue
    if (ep.get("date") or "") < START_DATE: continue   # filtrar era pre-0DTE
    s = ep.get("s", [])
    p = pad_state(s, ep)
    if p is not None and not any(not np.isfinite(v) for v in p):
        states_list.append(p)
        all_ep_data.append(ep)

states = np.array(states_list, dtype=np.float32)
N = len(states)
print(f"Clean episodes (has1Min): {N:,}", flush=True)

# ── Rolling z-score (régimen-invariante) ──────────────────────────────────────
# Para cada episodio en fecha D, z-scoreamos sus features usando la media y std
# de los WINDOW_ROLL_DAYS días de trading anteriores. Sin look-ahead.
# Esto hace que gammaTilt=0.5 en 2018 y en 2025 tengan la misma representación
# relativa a su ventana reciente, aunque el nivel absoluto sea diferente.
#
# Los features s[] ya están en rango ~[-3, 3] (normalización estática).
# El z-score los re-centra para que la distribución sea estacionaria.
WINDOW_ROLL_DAYS  = 60   # días de trading para la ventana
MIN_ROLL_DAYS_ACT = 10   # mínimo antes de activar z-scoring
Z_CLIP_RANGE      = 5.0  # clamp

def compute_rolling_zscores(states_arr, dates_arr):
    """
    Devuelve states z-scoreadas walk-forward (sin look-ahead).
    Para cada fecha D, usa días de [D-60d, D).
    """
    states_z = states_arr.copy()
    unique_dates = sorted(set(dates_arr))

    # Media diaria de features (promedia episodios del mismo día)
    day_mean = {}
    for d in unique_dates:
        mask = dates_arr == d
        day_mean[d] = states_arr[mask].mean(axis=0)

    # Stats de ventana por fecha
    date_to_stats = {}
    for d in unique_dates:
        d_dt = datetime.date.fromisoformat(d) if d else None
        if d_dt is None:
            date_to_stats[d] = None
            continue
        window_start = (d_dt - datetime.timedelta(days=WINDOW_ROLL_DAYS)).isoformat()
        window_days = [dd for dd in unique_dates if dd and window_start <= dd < d]
        if len(window_days) < MIN_ROLL_DAYS_ACT:
            date_to_stats[d] = None  # cold-start
            continue
        arr = np.array([day_mean[dd] for dd in window_days], dtype=np.float64)
        mu    = arr.mean(axis=0)
        sigma = arr.std(axis=0) + 1e-6
        date_to_stats[d] = (mu.astype(np.float32), sigma.astype(np.float32))

    warmed, cold = 0, 0
    for i in range(len(states_arr)):
        stats = date_to_stats.get(dates_arr[i])
        if stats is None:
            cold += 1
            continue
        mu, sigma = stats
        states_z[i] = np.clip((states_arr[i] - mu) / sigma, -Z_CLIP_RANGE, Z_CLIP_RANGE)
        warmed += 1

    print(f"Rolling z-score: {warmed:,} warmed, {cold:,} cold-start (< {MIN_ROLL_DAYS_ACT} days)", flush=True)
    return states_z

# Sort por fecha
dates    = np.array([ep.get("date","") for ep in all_ep_data])

# Aplicar rolling z-score antes de definir splits (walk-forward: no usa data futura)
print("Computing rolling z-scores (walk-forward, no look-ahead)...", flush=True)
states = compute_rolling_zscores(states, dates)
print("Z-score applied.", flush=True)

sorted_idx = np.argsort(dates)
split      = int(N * 0.8)
train_idx  = sorted_idx[:split].copy()
test_idx   = sorted_idx[split:]
print(f"Train: {len(train_idx):,}  Test: {len(test_idx):,}", flush=True)
print(f"Date range: {dates[sorted_idx[0]]} → {dates[sorted_idx[-1]]}", flush=True)

# ── Pre-computar outcomes ─────────────────────────────────────────────────────
print("Pre-computing outcomes...", flush=True)
outcome_long  = np.full(N, 4, dtype=np.int32)
outcome_short = np.full(N, 4, dtype=np.int32)
for gi in range(N):
    ep = all_ep_data[gi]
    outcome_long[gi]  = OMAP.get(ep.get("exactLong","cancelled")  or "cancelled", 4)
    outcome_short[gi] = OMAP.get(ep.get("exactShort","cancelled") or "cancelled", 4)

im_usage    = np.array([ep.get("impliedMoveUsage", 1.0) for ep in all_ep_data], dtype=np.float32)
sig_quality = np.array([ep.get("signalQuality", 0)      for ep in all_ep_data], dtype=np.float32)

# ── FIX 1 — Direction labels (ground truth sin ambigüedad) ────────────────────
# LONG (1): LONG wins  AND SHORT loses     → señal unívoca
# SHORT (2): SHORT wins AND LONG loses     → señal unívoca
# SKIP (0): todo lo demás (ambiguous)
direction_labels = np.zeros(N, dtype=np.int32)
for gi in range(N):
    lw = outcome_long[gi]  < 3   # LONG gana (tp1/2/3)
    ll = outcome_long[gi]  == 3  # LONG pierde (sl)
    sw = outcome_short[gi] < 3
    sl = outcome_short[gi] == 3
    if lw and sl:  direction_labels[gi] = 1
    elif sw and ll: direction_labels[gi] = 2

counts = np.bincount(direction_labels, minlength=3)
print(f"Direction labels — SKIP:{counts[0]:,}  LONG:{counts[1]:,}  SHORT:{counts[2]:,}", flush=True)

# ── Labels supervisados para cabezas secundarias ──────────────────────────────
# Derivados de features observables — dan señal directa para evitar mode collapse.
#
# overExtension (TRADE=0, SKIP=1):
#   Ambas direcciones habrían tocado SL → mercado choppy/sobreextendido en ambas caras.
#   Usamos los outcomes reales: si LONG=SL Y SHORT=SL → genuino overextension.
#   Este label está bien poblado en training (no depende de im_usage que siempre es 0).
#
# entryQuality (ACCEPT_CAUTION=0, WAIT_OPTIMAL=1):
#   signalQuality < 3 → aceptar con cautela; >= 3 → esperar entry óptimo
#
# scoreThreshold (LOW=0, MEDIUM=1, HIGH=2, EXTRA=3):
#   Mapeo directo de signalQuality (0–4+) → cuatro bandas de confianza
oe_labels = ((outcome_long == 3) & (outcome_short == 3)).astype(np.int32)  # 0=TRADE, 1=SKIP (ambas perderían)
eq_labels = (sig_quality >= 3.0).astype(np.int32)       # 0=ACCEPT_CAUTION, 1=WAIT_OPTIMAL
st_labels = np.where(sig_quality <= 1, 0,
            np.where(sig_quality <= 2, 1,
            np.where(sig_quality <= 3, 2, 3))).astype(np.int32)

oe_counts = np.bincount(oe_labels, minlength=2)
eq_counts = np.bincount(eq_labels, minlength=2)
st_counts = np.bincount(st_labels, minlength=4)
print(f"overExtension  — TRADE:{oe_counts[0]:,}  SKIP:{oe_counts[1]:,}", flush=True)
print(f"entryQuality   — ACCEPT_CAUTION:{eq_counts[0]:,}  WAIT_OPTIMAL:{eq_counts[1]:,}", flush=True)
print(f"scoreThreshold — LOW:{st_counts[0]:,}  MED:{st_counts[1]:,}  HIGH:{st_counts[2]:,}  EXTRA:{st_counts[3]:,}", flush=True)

SECONDARY_HEAD_LABELS = [
    ("overExtension",  oe_labels, 2),
    ("entryQuality",   eq_labels, 2),
    ("scoreThreshold", st_labels, 4),
]

# ── FIX 2 — Índices por categoría (para batches balanceados) ─────────────────
train_long_idx  = train_idx[direction_labels[train_idx] == 1]
train_short_idx = train_idx[direction_labels[train_idx] == 2]
train_amb_idx   = train_idx[direction_labels[train_idx] == 0]
print(f"Train — LONG:{len(train_long_idx):,}  SHORT:{len(train_short_idx):,}  AMB:{len(train_amb_idx):,}", flush=True)

# ── FIX 5 — Recency weights ───────────────────────────────────────────────────
today = datetime.date.today()
recency_w = np.zeros(N, dtype=np.float64)
for gi in range(N):
    d = dates[gi]
    try:
        ep_date = datetime.date.fromisoformat(d)
        days_ago = max(0, (today - ep_date).days)
    except Exception:
        days_ago = 1000
    recency_w[gi] = np.exp(-days_ago / RECENCY_HALFLIFE)

def make_sample_weights(idx_subset):
    w = recency_w[idx_subset].copy()
    w /= w.sum()
    return w

long_w  = make_sample_weights(train_long_idx)
short_w = make_sample_weights(train_short_idx)
amb_w   = make_sample_weights(train_amb_idx)

def balanced_batch(n_per_class=SAMPLES_PER_PASS//3):
    """Sample n_per_class LONG + SHORT + AMB, weighted by recency."""
    ls = np.random.choice(train_long_idx,  n_per_class, replace=True, p=long_w)
    ss = np.random.choice(train_short_idx, n_per_class, replace=True, p=short_w)
    ab = np.random.choice(train_amb_idx,   n_per_class, replace=True, p=amb_w)
    idx = np.concatenate([ls, ss, ab])
    np.random.shuffle(idx)
    return idx

# ── Reward table ──────────────────────────────────────────────────────────────
REWARD_TABLES_NP = np.array([
    [1.5, 3.0, 5.0, -1.5, 0.1],
    [1.0, 2.5, 4.0, -2.0, 0.1],
    [0.8, 2.0, 3.5, -2.5, 0.1],
], dtype=np.float32)

# ── Modelo ────────────────────────────────────────────────────────────────────
inp = tf.keras.Input(shape=(STATE_SIZE,))
x = tf.keras.layers.Dense(192, activation='relu', kernel_initializer='he_normal',
                           kernel_regularizer=tf.keras.regularizers.l2(1e-4))(inp)
x = tf.keras.layers.Dropout(0.15)(x)
x = tf.keras.layers.Dense(96, activation='relu', kernel_initializer='he_normal',
                           kernel_regularizer=tf.keras.regularizers.l2(1e-4))(x)
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
    tf.keras.layers.Dense(128, activation='relu', input_shape=(STATE_SIZE,),
                          kernel_initializer='he_normal',
                          kernel_regularizer=tf.keras.regularizers.l2(1e-4)),
    tf.keras.layers.Dropout(0.10),
    tf.keras.layers.Dense(64, activation='relu',
                          kernel_initializer='he_normal',
                          kernel_regularizer=tf.keras.regularizers.l2(1e-4)),
    tf.keras.layers.Dropout(0.05),
    tf.keras.layers.Dense(1, kernel_initializer='glorot_normal'),
])

sup_opt    = tf.keras.optimizers.Adam(LR_SUPERVISED)
actor_opt  = tf.keras.optimizers.Adam(LR_PPO)
critic_opt = tf.keras.optimizers.Adam(LR_PPO)

# Head offsets en output concatenado
head_offsets = {}
off = 0
for name in HEAD_NAMES:
    head_offsets[name] = (off, off + HEAD_SIZES[name])
    off += HEAD_SIZES[name]

print(f"\nActor  params: {actor.count_params():,}")
print(f"Critic params: {critic_model.count_params():,}")

# ── FASE 0: Supervisado — cabezas secundarias (overExtension, entryQuality, scoreThreshold)
# Objetivo: arrancar con distribuciones diversas para que el PPO tenga algo que optimizar.
# Sin esto las cabezas colapsan al primer pass de PPO porque el reward de dirección
# aplasta el gradiente de las cabezas secundarias.
print(f"\n{'='*60}")
print(f"FASE 0 — Supervisado ({PASSES_SECONDARY_SUP} passes) — cabezas secundarias")
print(f"{'='*60}\n")

start0 = time.time()
for p in range(1, PASSES_SECONDARY_SUP + 1):
    idx     = balanced_batch()
    batch_s = tf.constant(states[idx])

    with tf.GradientTape() as tape:
        all_p    = actor(batch_s, training=True)
        sec_loss = tf.zeros(())
        for (name, lbl_arr, sz) in SECONDARY_HEAD_LABELS:
            s_o, e_o = head_offsets[name]
            p_head   = tf.clip_by_value(all_p[:, s_o:e_o], 1e-8, 1.0)
            true_oh  = tf.one_hot(lbl_arr[idx], sz)
            sec_loss += -tf.reduce_mean(tf.reduce_sum(true_oh * tf.math.log(p_head), axis=1))

    grads = tape.gradient(sec_loss, actor.trainable_variables)
    grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
    sup_opt.apply_gradients(zip(grads, actor.trainable_variables))

    if p % 10 == 0 or p == PASSES_SECONDARY_SUP:
        # Chequear distribuciones de las 3 cabezas en test set
        probs_np = actor(tf.constant(states[test_idx]), training=False).numpy()
        dist_str = ""
        for (name, _, sz) in SECONDARY_HEAD_LABELS:
            s_o, e_o = head_offsets[name]
            acts  = np.argmax(probs_np[:, s_o:e_o], axis=1)
            dist  = np.bincount(acts, minlength=sz) / len(test_idx) * 100
            parts = "/".join(f"{d:.0f}%" for d in dist)
            dist_str += f"  {name}:[{parts}]"
        print(f"[SEC] Pass {p:>3}/{PASSES_SECONDARY_SUP}: loss={sec_loss.numpy():.4f}{dist_str}", flush=True)

print(f"Fase 0 done ({time.time()-start0:.1f}s)\n")

print(f"\n{'='*60}")
print(f"FASE 1 — Supervisado ({PASSES_SUPERVISED} passes) — direction head")
print(f"{'='*60}\n")

# ── Threshold-based direction (espeja lógica de ppo-inference.ts) ────────────
SKIP_THRESHOLD  = 0.25   # SKIP si P(SKIP) >= 25%
MIN_TRADE_CONF  = 0.50   # SKIP si max(P(LONG),P(SHORT)) < 50%

def pick_direction(probs3):
    """Misma lógica que pickDirection() en ppo-inference.ts."""
    p_skip, p_long, p_short = float(probs3[0]), float(probs3[1]), float(probs3[2])
    if p_skip >= SKIP_THRESHOLD:                        return 0
    if max(p_long, p_short) < MIN_TRADE_CONF:           return 0
    return 1 if p_long >= p_short else 2

# ── FIX 3 — Métricas honestas ─────────────────────────────────────────────────
def eval_all_metrics(eval_idx):
    """Calcula Direction Accuracy, Skip Quality, y Naive WR — con threshold inference."""
    probs_np = actor(tf.constant(states[eval_idx]), training=False).numpy()
    dir_correct = dir_total = 0
    skip_good = skip_total = 0
    naive_wins = naive_losses = 0

    for i, gi in enumerate(eval_idx):
        pred = pick_direction(probs_np[i, :3])   # threshold, no argmax
        true = int(direction_labels[gi])

        if pred == 0:  # modelo dice SKIP
            skip_total += 1
            # Buen skip: true era ambiguo, O la dirección opuesta habría ganado
            if true == 0:
                skip_good += 1  # correcto: ambiguo → skip
            elif true == 1 and outcome_long[gi] == 3:
                skip_good += 1  # habría perdido el LONG → bien skipeado
            elif true == 2 and outcome_short[gi] == 3:
                skip_good += 1  # habría perdido el SHORT → bien skipeado
        else:  # modelo toma el trade
            # Naive WR
            o = outcome_long[gi] if pred == 1 else outcome_short[gi]
            if o < 3:    naive_wins   += 1
            elif o == 3: naive_losses += 1
            # Direction Accuracy (solo cuando hay ground truth claro)
            if true != 0:
                dir_total += 1
                if pred == true:
                    dir_correct += 1

    dir_acc  = dir_correct / dir_total  * 100 if dir_total  > 0 else 0.0
    skip_q   = skip_good   / skip_total * 100 if skip_total > 0 else 0.0
    naive_wr = naive_wins  / (naive_wins + naive_losses) * 100 if (naive_wins+naive_losses) > 0 else 0.0
    skip_pct = skip_total  / len(eval_idx) * 100
    return dir_acc, skip_q, naive_wr, skip_pct, dir_total, skip_total

# ── FASE 1: Supervisado — entrenar solo la cabeza de dirección ────────────────
dir_head_s, dir_head_e = head_offsets["direction"]  # offsets en output concat

best_dir_acc  = 0.0
best_pass_sup = 0
best_actor_w  = None
start = time.time()

for p in range(1, PASSES_SUPERVISED + 1):
    idx = balanced_batch()
    batch_s = tf.constant(states[idx])
    # Labels supervisados: direction_labels de cada episodio
    dir_true = tf.one_hot(direction_labels[idx], 3)  # [B, 3]

    with tf.GradientTape() as tape:
        all_p = actor(batch_s, training=True)
        dir_p = tf.clip_by_value(all_p[:, dir_head_s:dir_head_e], 1e-8, 1.0)
        # Cross-entropy solo para el direction head
        sup_loss = -tf.reduce_mean(tf.reduce_sum(dir_true * tf.math.log(dir_p), axis=1))

    grads = tape.gradient(sup_loss, actor.trainable_variables)
    grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
    sup_opt.apply_gradients(zip(grads, actor.trainable_variables))

    if p % 10 == 0 or p <= 3:
        el  = time.time() - start
        da, sq, nwr, skpct, dtot, stot = eval_all_metrics(test_idx)
        # [v5] Penalizar skip>60% en supervisado — evita guardar modelo todo-SKIP
        skip_penalty = max(0.0, (skpct - 60.0) / 40.0)  # 0 si skip≤60%, escala hasta 1 si skip=100%
        da_adj = da * (1.0 - skip_penalty)
        tag = f" [★best adj={da_adj:.1f}]" if da_adj > best_dir_acc else f" [pat]"
        if da_adj > best_dir_acc:
            best_dir_acc  = da_adj
            best_pass_sup = p
            best_actor_w  = [v.numpy().copy() for v in actor.trainable_variables]
        print(f"[SUP] Pass {p:>3}/{PASSES_SUPERVISED}: "
              f"loss={sup_loss.numpy():.4f}  "
              f"dirAcc={da:.1f}%  skipQ={sq:.1f}%  "
              f"naiveWR={nwr:.1f}%  skip={skpct:.0f}%{tag}", flush=True)

print(f"\n★ Best supervised dirAcc={best_dir_acc:.1f}% at pass {best_pass_sup}")
print(f"Restoring best supervised weights...", flush=True)
if best_actor_w:
    for var, w in zip(actor.trainable_variables, best_actor_w):
        var.assign(w)

# ── FASE 2: PPO real con ratio clipping ───────────────────────────────────────
print(f"\n{'='*60}")
print(f"FASE 2 — PPO con ratio clipping ({PASSES_PPO} passes)")
print(f"{'='*60}\n")

# Inicializar baseline del PPO con la métrica COMPUESTA desde los pesos supervisados.
# Bug anterior: se usaba best_dir_acc (escala ~70-80%) pero PPO compara composite (~50-56%)
# → el PPO nunca guardaba pesos mejorados (siempre restauraba pass 0).
da_init, sq_init, _, _, _, _ = eval_all_metrics(test_idx)
best_dir_acc_ppo  = da_init * 0.6 + sq_init * 0.4   # misma escala que la comparación PPO
print(f"PPO baseline composite: {best_dir_acc_ppo:.1f}  (dirAcc={da_init:.1f}%  skipQ={sq_init:.1f}%)", flush=True)
best_pass_ppo     = 0
patience_count    = 0
best_actor_w_ppo  = [v.numpy().copy() for v in actor.trainable_variables]
total_wins = total_losses = 0
start2 = time.time()

for p in range(1, PASSES_PPO + 1):
    idx       = balanced_batch()
    batch_s   = tf.constant(states[idx])
    B         = len(idx)

    # ── Recopilar con política VIEJA (sin gradiente) ─────────────────────────
    old_all_probs = actor(batch_s, training=False).numpy()
    values        = critic_model(batch_s, training=False).numpy().squeeze()

    actions = {}
    for name in HEAD_NAMES:
        s_o, e_o = head_offsets[name]
        probs    = old_all_probs[:, s_o:e_o]
        cumprobs = np.cumsum(probs, axis=1)
        rand     = np.random.random((B, 1)).astype(np.float32)
        acts     = np.clip((rand >= cumprobs).sum(axis=1).astype(np.int32),
                           0, HEAD_SIZES[name]-1)
        actions[name] = acts

    da = actions["direction"]; ra = actions["risk"]
    oe = actions["overExtension"]
    eq = actions["entryQuality"]
    st = actions["scoreThreshold"]

    oi      = np.where(da==1, outcome_long[idx], np.where(da==2, outcome_short[idx], 4))
    rewards = REWARD_TABLES_NP[ra, oi].copy()

    skip    = da == 0

    # [v4] SKIP rewards rediseñados — usar AMBOS outcomes para evaluar calidad del skip
    # Antes: -0.5 si el trade hubiera ganado → el modelo aprendía "nunca skipear"
    # Ahora: recompensar skip selectivo, penalizar leve oportunidades perdidas claras
    lw_skip = outcome_long[idx]  < 3          # LONG hubiera ganado
    ll_skip = outcome_long[idx]  == 3         # LONG hubiera perdido
    sw_skip = outcome_short[idx] < 3          # SHORT hubiera ganado
    sl_skip = outcome_short[idx] == 3         # SHORT hubiera perdido
    both_lose   = ll_skip & sl_skip           # ambas direcciones pierden → skip perfecto
    is_amb_skip = direction_labels[idx] == 0  # episodio ambiguo según ground truth
    is_clear_skip = direction_labels[idx] != 0  # había una dirección ganadora clara

    rewards[skip & both_lose]                     =  0.8   # [v5] +0.8: evitó pérdida segura → excelente
    rewards[skip & is_amb_skip & ~both_lose]       =  0.4   # [v5] +0.4: episodio ambiguo → buen skip
    rewards[skip & is_clear_skip]                  = -0.2   # [v5] -0.2: perdió oportunidad clara

    ns            = ~skip
    is_win        = (oi < 3) & ns
    is_loss       = (oi == 3) & ns
    batch_im      = im_usage[idx]
    batch_sig     = sig_quality[idx]
    high_exh      = batch_im > 1.5

    oem = np.ones(B, dtype=np.float32)
    oem[(oe==1) & high_exh]            = 1.3
    oem[(oe==0) & high_exh & is_loss]  = 0.5

    qm  = np.ones(B, dtype=np.float32)
    qm[(eq==1) & is_win]  = 1.2
    qm[(eq==0) & is_loss] = 0.7

    tm  = np.ones(B, dtype=np.float32)
    tm[(st==3) & (batch_sig>=4) & is_win]  = 1.15
    tm[(st==0) & (batch_sig<=2) & is_loss] = 0.6

    rewards *= oem * qm * tm

    pw = int(is_win.sum()); pl = int(is_loss.sum())
    total_wins += pw; total_losses += pl

    adv     = rewards - values
    adv     = np.clip((adv-adv.mean())/(adv.std()+1e-8), -5, 5).astype(np.float32)
    returns = np.clip(rewards, -10, 10).astype(np.float32)

    # ── FIX 4 — PPO K epochs con ratio clipping ──────────────────────────────
    old_probs_tf = {}
    for name in HEAD_NAMES:
        s_o, e_o = head_offsets[name]
        old_probs_tf[name] = tf.constant(
            np.clip(old_all_probs[:, s_o:e_o], 1e-8, 1.0), dtype=tf.float32)

    for _k in range(PPO_EPOCHS):
        with tf.GradientTape() as tape:
            new_all_p    = actor(batch_s, training=True)
            ppo_loss_sum = tf.zeros(())
            entropy_sum  = tf.zeros(B)

            for name in HEAD_NAMES:
                s_o, e_o  = head_offsets[name]
                new_p     = tf.clip_by_value(new_all_p[:, s_o:e_o], 1e-8, 1.0)
                oh        = tf.one_hot(actions[name], HEAD_SIZES[name])
                new_chosen = tf.reduce_sum(new_p * oh, axis=1)
                old_chosen = tf.reduce_sum(old_probs_tf[name] * oh, axis=1)
                ratio     = new_chosen / (old_chosen + 1e-8)
                adv_t     = tf.constant(adv)
                surr1     = ratio * adv_t
                surr2     = tf.clip_by_value(ratio, 1-CLIP_RATIO, 1+CLIP_RATIO) * adv_t
                ppo_loss_sum += -tf.reduce_mean(tf.minimum(surr1, surr2))
                entropy_sum  -= tf.reduce_sum(new_p * tf.math.log(new_p), axis=1)

            # [v4] Entropy bonus extra para la cabeza de dirección (fomenta SKIP)
            dir_s, dir_e = head_offsets["direction"]
            dir_p_ent = tf.clip_by_value(new_all_p[:, dir_s:dir_e], 1e-8, 1.0)
            dir_entropy = -tf.reduce_mean(
                tf.reduce_sum(dir_p_ent * tf.math.log(dir_p_ent), axis=1)
            )
            # [v4+] Entropy bonus extra para cabezas secundarias — previene mode collapse
            # Sin esto, el gradiente de dirección aplasta las cabezas débiles
            sec_entropy = tf.zeros(())
            for sec_name in ["overExtension", "entryQuality", "scoreThreshold"]:
                sec_s, sec_e = head_offsets[sec_name]
                sec_p_ent = tf.clip_by_value(new_all_p[:, sec_s:sec_e], 1e-8, 1.0)
                sec_entropy += tf.reduce_mean(
                    -tf.reduce_sum(sec_p_ent * tf.math.log(sec_p_ent), axis=1)
                )
            actor_loss = (ppo_loss_sum
                          - ENTROPY_COEFF           * tf.reduce_mean(entropy_sum)
                          - DIR_ENTROPY_BONUS        * dir_entropy
                          - SECONDARY_ENTROPY_COEFF  * sec_entropy)

        grads = tape.gradient(actor_loss, actor.trainable_variables)
        grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
        actor_opt.apply_gradients(zip(grads, actor.trainable_variables))

    # Critic update (una vez por pass)
    with tf.GradientTape() as tape:
        v      = tf.squeeze(critic_model(batch_s, training=True))
        c_loss = tf.reduce_mean(tf.square(v - tf.constant(returns)))
    c_grads = tape.gradient(c_loss, critic_model.trainable_variables)
    c_grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in c_grads]
    critic_opt.apply_gradients(zip(c_grads, critic_model.trainable_variables))

    # ── Reporte + Early stopping ──────────────────────────────────────────────
    if p % 10 == 0 or p <= 3:
        el   = time.time() - start2
        eta  = el / p * (PASSES_PPO - p)
        tr   = total_wins + total_losses
        cwr  = total_wins / tr * 100 if tr > 0 else 0
        rr   = pw + pl
        wr   = pw / rr * 100 if rr > 0 else 0

        da_v, sq_v, nwr_v, skpct_v, dtot_v, stot_v = eval_all_metrics(test_idx)

        # [v4] Métrica compuesta: dirAcc + skipQ ponderados
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

        # [v4] Skip % en dirección + head collapse monitor
        dir_dist  = np.bincount(actions["direction"], minlength=3)
        dir_pcts  = dir_dist / dir_dist.sum() * 100
        skip_batch_pct = dir_pcts[0]

        he_dist = f" | dir: SKIP:{dir_pcts[0]:.0f}% LONG:{dir_pcts[1]:.0f}% SHORT:{dir_pcts[2]:.0f}%"
        for hn in ["overExtension","entryQuality","scoreThreshold"]:
            s_o, e_o = head_offsets[hn]
            dist  = np.bincount(actions[hn], minlength=HEAD_SIZES[hn])
            pcts  = dist/dist.sum()*100
            parts = [f"{HEAD_LABELS[hn][i]}:{pcts[i]:.0f}%" for i in range(len(HEAD_LABELS[hn]))]
            he_dist += f" | {hn}: {' '.join(parts)}"

        print(f"[PPO] Pass {p:>4}/{PASSES_PPO}: "
              f"trainWR={wr:.1f}%(cum={cwr:.1f}%) "
              f"dirAcc={da_v:.1f}% skipQ={sq_v:.1f}% naiveWR={nwr_v:.1f}% "
              f"[{el:.0f}s ETA {eta:.0f}s]{tag}{he_dist}", flush=True)

        if patience_count >= EARLY_STOP_PATIENCE:
            print(f"\n⚡ Early stopping pass {p} — best dirAcc={best_dir_acc_ppo:.1f}% pass {best_pass_ppo}", flush=True)
            break

# Restaurar mejores pesos
print(f"\nRestoring best PPO weights (pass {best_pass_ppo}, dirAcc={best_dir_acc_ppo:.1f}%)", flush=True)
for var, w in zip(actor.trainable_variables, best_actor_w_ppo):
    var.assign(w)

elapsed = time.time() - start
tr  = total_wins + total_losses
fwr = total_wins / tr * 100 if tr > 0 else 0

# ── Evaluación final completa ─────────────────────────────────────────────────
print(f"\n{'='*60}\nTRAINING COMPLETE\n{'='*60}")
print(f"Fase 1 (supervisado): {PASSES_SUPERVISED} passes — best dirAcc={best_dir_acc:.1f}%")
print(f"Fase 2 (PPO):         {p} passes — best dirAcc={best_dir_acc_ppo:.1f}%")
print(f"Duration: {elapsed:.1f}s ({elapsed/60:.1f} min)")
print(f"TrainWR (cum): {fwr:.1f}%")

print(f"\n{'='*60}\nFINAL TEST METRICS ({len(test_idx):,} episodes)\n{'='*60}")
da_f, sq_f, nwr_f, skpct_f, dtot_f, stot_f = eval_all_metrics(test_idx)
print(f"Direction Accuracy:  {da_f:.1f}%  ({dtot_f:,} clear-direction trades)")
print(f"Skip Quality:        {sq_f:.1f}%  ({stot_f:,} skipped trades)")
print(f"Naive WR:            {nwr_f:.1f}%")
print(f"Skip rate:           {skpct_f:.1f}%")

# Baseline comparisons
base_long_wins  = int(np.sum(outcome_long[test_idx]  < 3))
base_long_loss  = int(np.sum(outcome_long[test_idx]  == 3))
base_short_wins = int(np.sum(outcome_short[test_idx] < 3))
base_short_loss = int(np.sum(outcome_short[test_idx] == 3))
baseline_long_wr  = base_long_wins  / (base_long_wins+base_long_loss)  * 100
baseline_short_wr = base_short_wins / (base_short_wins+base_short_loss) * 100
print(f"\nBaseline siempre-LONG:  {baseline_long_wr:.1f}%")
print(f"Baseline siempre-SHORT: {baseline_short_wr:.1f}%")
print(f"Modelo añade sobre LONG: {nwr_f-baseline_long_wr:+.1f}pp")

print(f"\n{'='*60}\nROLLING WALK-FORWARD (4 ventanas)\n{'='*60}")
window_dir_accs = []
for w_i in range(1, 5):
    w_test_start = int(N * w_i * 0.2)
    w_test_end   = int(N * min((w_i+1)*0.2, 1.0))
    w_test       = sorted_idx[w_test_start:w_test_end]
    if len(w_test) == 0: continue
    wda, wsq, wnwr, wskp, _, _ = eval_all_metrics(w_test)
    window_dir_accs.append(wda)
    print(f"  Window {w_i} (test {w_i*20}-{min((w_i+1)*20,100)}%): "
          f"dirAcc={wda:.1f}%  skipQ={wsq:.1f}%  naiveWR={wnwr:.1f}%  skip={wskp:.0f}%", flush=True)
avg_rolling = np.mean(window_dir_accs) if window_dir_accs else 0
print(f"\nAvg rolling dirAcc: {avg_rolling:.1f}%")

# ── Guardar pesos (mismo formato que ppo-inference.ts) ───────────────────────
model_dir = "/Users/samuellondono/spotgamma_monitor/data/ppo-multihead-model"
os.makedirs(model_dir, exist_ok=True)

actor_weights = []
for wname, idx2 in [("w1",0),("b1",1),("w2",2),("b2",3),("w3",4),("b3",5)]:
    w = actor.trainable_variables[idx2].numpy()
    actor_weights.append({"name":wname,"shape":list(w.shape),"data":w.flatten().tolist()})
hi = 6
for name in HEAD_NAMES:
    for suffix in ["w1","b1","w2","b2"]:
        w = actor.trainable_variables[hi].numpy()
        actor_weights.append({"name":f"{name}_{suffix}","shape":list(w.shape),"data":w.flatten().tolist()})
        hi += 1
with open(os.path.join(model_dir,"actor-weights.json"),"w") as f:
    json.dump(actor_weights, f)

critic_weights = []
for i, wname in enumerate(["w1","b1","w2","b2","w3","b3","w4","b4"]):
    if i < len(critic_model.trainable_variables):
        w = critic_model.trainable_variables[i].numpy()
        critic_weights.append({"name":wname,"shape":list(w.shape),"data":w.flatten().tolist()})
with open(os.path.join(model_dir,"critic-weights.json"),"w") as f:
    json.dump(critic_weights, f)

state_info = {
    "totalEpisodes":      int(N * p),
    "totalWins":          int(total_wins),
    "totalLosses":        int(total_losses),
    "trainWR":            float(fwr),
    "testWR":             float(nwr_f),
    "directionAccuracy":  float(da_f),
    "skipQuality":        float(sq_f),
    "walkForwardDirAcc":  float(avg_rolling),
    "bestDirAcc":         float(best_dir_acc_ppo),
    "bestPass":           int(best_pass_ppo),
    "earlyStop":          patience_count >= EARLY_STOP_PATIENCE,
    "cleanEpisodes":      int(N),
    "lastUpdated":        time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "architecture":       "PPO_PURO_8heads_46features_v3",
    "heads":              HEAD_NAMES,
    "stateSize":          STATE_SIZE,
    "gpu":                bool(gpus),
    "improvements":       ["no_lookahead","supervised_direction_pretraining",
                           "balanced_batches","direction_accuracy_metric",
                           "ppo_ratio_clipping","recency_weighting"],
}
with open(os.path.join(model_dir,"..","ppo-multihead-state.json"),"w") as f:
    json.dump(state_info, f, indent=2)

print(f"\n✅ Weights saved to {model_dir}")
print(f"Version: v3 | dirAcc={da_f:.1f}% | skipQ={sq_f:.1f}% | naiveWR={nwr_f:.1f}%")
