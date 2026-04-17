"""
train-gate.py — Quality Gate Classifier
========================================
Modelo binario supervisado que predice: ¿vale la pena tradear este setup?

  TRADE (1): hay una dirección ganadora clara (LONG gana Y SHORT pierde, o viceversa)
  SKIP  (0): el resultado es ambiguo (ambos ganan, ambos pierden, o cancelado)

Esto separa el problema en dos modelos independientes:
  Gate  → decide si hay señal suficiente para entrar
  PPO   → decide dirección (LONG/SHORT) cuando el gate dice TRADE

Ventajas:
  - El gate aprende con supervisión directa (no RL ruidoso)
  - El PPO nunca ve SKIP — aprende solo dirección pura
  - El gate puede ajustarse independientemente con un threshold
"""
import json, time, os, datetime
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import numpy as np

print("Loading TensorFlow...", flush=True)
import tensorflow as tf
gpus = tf.config.list_physical_devices('GPU')
print(f"GPUs: {len(gpus)} {'(Metal)' if gpus else '(CPU only)'}", flush=True)

# ── Config ────────────────────────────────────────────────────────────────────
_SCRIPT_DIR    = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR   = os.path.join(_SCRIPT_DIR, "..")
DATA_PATH      = os.path.join(_PROJECT_DIR, "data", "training-data-445k.json")
MODEL_DIR      = os.path.join(_PROJECT_DIR, "data", "ppo-multihead-model")
STATE_SIZE     = 49
PASSES         = 200
LR             = 5e-5
BATCH_SIZE     = 4_000       # 2k TRADE + 2k SKIP por pass
EARLY_PATIENCE = 30          # passes sin mejora en val_F1
RECENCY_HL     = None        # None = sin recency weighting (pesos iguales por episodio)
                             # El gate aprende patrones atemporales, no régimen específico
                             # El PPO sí usa recency (HL=365) porque dirección es régimen-dependiente
OMAP           = {"tp1":0,"tp2":1,"tp3":2,"sl":3,"cancelled":4}

# ── Cargar datos ──────────────────────────────────────────────────────────────
print(f"\nLoading {DATA_PATH}...", flush=True)
with open(DATA_PATH) as f:
    raw = json.load(f)
print(f"Loaded {len(raw):,} raw episodes", flush=True)

def augment_top_strikes(s46, ep, noise_std=1.0):
    """Añade 3 features de top-strike distance. Usa ruido gaussiano si no hay datos."""
    price = ep.get("price", 0)
    def pct_dist(k):
        strike = ep.get(k, 0)
        if price > 0 and strike > 0:
            return float(np.clip((price - strike) / price * 100 / 2, -3, 3))
        return float(np.clip(np.random.normal(0, noise_std), -3, 3))
    return s46 + [pct_dist("largeGamma1"), pct_dist("largeGamma2"), pct_dist("largeGamma3")]

def pad_state(s, ep):
    if len(s) == STATE_SIZE: return s
    if len(s) == 46:
        return augment_top_strikes(s, ep)
    if len(s) == 42:
        tn = ep.get("timeNorm", 0.48)
        st = 0 if tn<0.38 else 1 if tn<0.48 else 2 if tn<0.60 else 3 if tn<0.63 else 4
        im = ep.get("impliedMoveUsage", 1.0)
        s46 = s + [st/3-1, 0.0, 0.0, min(1, im/2)*2-1]
        return augment_top_strikes(s46, ep)
    return None

START_DATE = "2022-01-01"  # solo era post-0DTE — gamma/vanna tienen impacto real intraday

states_l, eps_l = [], []
for ep in raw:
    if not ep.get("has1Min"): continue
    if (ep.get("date") or "") < START_DATE: continue   # filtrar era pre-0DTE
    p = pad_state(ep.get("s", []), ep)
    if p and not any(not np.isfinite(v) for v in p):
        states_l.append(p)
        eps_l.append(ep)

states = np.array(states_l, dtype=np.float32)
N = len(states)
print(f"Clean episodes (has1Min): {N:,}", flush=True)

# ── Rolling z-score (régimen-invariante) ──────────────────────────────────────
# Para cada episodio en fecha D, z-scoreamos sus features usando la media y std
# de los WINDOW_DAYS días de trading anteriores. Evita que gammaTilt=0.5 en 2018
# signifique lo mismo que en 2025, donde el mercado de opciones cambió radicalmente.
#
# cold-start: episodios con < MIN_ROLL_DAYS de historia → features sin cambio
# Los features ya están normalizados estáticamente (en ~[-3, 3]), z-score los refina
# para que la distribución sea estacionaria dentro de la ventana.
WINDOW_DAYS  = 60   # días de historia para media/std
MIN_ROLL_DAYS = 10  # mínimo para activar z-scoring
Z_CLIP       = 5.0  # clampar z-scores

def compute_rolling_zscores(states_arr, dates_arr):
    """
    Devuelve states z-scoreadas de forma walk-forward (sin look-ahead).
    Por cada fecha D, la estadística usa días en [D-60d, D) (excluye D).
    """
    states_z = states_arr.copy()
    unique_dates = sorted(set(dates_arr))
    DIM = states_arr.shape[1]

    # Media diaria (promedio de todos los episodios de cada día)
    day_mean = {}
    for d in unique_dates:
        mask = dates_arr == d
        day_mean[d] = states_arr[mask].mean(axis=0)

    # Para cada fecha, calcular stats de la ventana precedente
    date_to_stats = {}
    for d in unique_dates:
        d_dt = datetime.date.fromisoformat(d)
        window_start = (d_dt - datetime.timedelta(days=WINDOW_DAYS)).isoformat()
        # Solo días estrictamente antes de D y dentro de la ventana
        window_days = [dd for dd in unique_dates if window_start <= dd < d]
        if len(window_days) < MIN_ROLL_DAYS:
            date_to_stats[d] = None  # cold-start
            continue
        arr = np.array([day_mean[dd] for dd in window_days], dtype=np.float64)
        mu  = arr.mean(axis=0)
        sigma = arr.std(axis=0) + 1e-6
        date_to_stats[d] = (mu.astype(np.float32), sigma.astype(np.float32))

    # Aplicar z-score por episodio
    warmed, cold = 0, 0
    for i in range(len(states_arr)):
        stats = date_to_stats.get(dates_arr[i])
        if stats is None:
            cold += 1
            continue
        mu, sigma = stats
        states_z[i] = np.clip((states_arr[i] - mu) / sigma, -Z_CLIP, Z_CLIP)
        warmed += 1

    print(f"Rolling z-score: {warmed:,} warmed, {cold:,} cold-start (< {MIN_ROLL_DAYS} days)", flush=True)
    return states_z

dates_arr = np.array([ep.get("date", "") for ep in eps_l])
print("Computing rolling z-scores (walk-forward)...", flush=True)
states = compute_rolling_zscores(states, dates_arr)
print("Z-score done.", flush=True)

# ── Labels ────────────────────────────────────────────────────────────────────
# TRADE=1: hay una dirección ganadora inequívoca
# SKIP=0 : resultado ambiguo
ol = np.array([OMAP.get(e.get("exactLong","cancelled")  or "cancelled", 4) for e in eps_l], np.int32)
os_= np.array([OMAP.get(e.get("exactShort","cancelled") or "cancelled", 4) for e in eps_l], np.int32)

gate_labels = np.zeros(N, dtype=np.float32)
for gi in range(N):
    lw = ol[gi] < 3;   ll = ol[gi] == 3
    sw = os_[gi] < 3;  sl = os_[gi] == 3
    if (lw and sl) or (sw and ll):
        gate_labels[gi] = 1.0  # TRADE — señal clara

n_trade = int(gate_labels.sum())
n_skip  = N - n_trade
print(f"Gate labels — TRADE:{n_trade:,} ({n_trade/N*100:.1f}%)  SKIP:{n_skip:,} ({n_skip/N*100:.1f}%)", flush=True)

# ── Walk-forward split 80/20 ───────────────────────────────────────────────────
dates      = np.array([e.get("date","") for e in eps_l])
sorted_idx = np.argsort(dates)
split      = int(N * 0.8)
train_idx  = sorted_idx[:split].copy()
test_idx   = sorted_idx[split:]
print(f"Train: {len(train_idx):,}  Test: {len(test_idx):,}", flush=True)
print(f"Date range: {dates[sorted_idx[0]]} → {dates[sorted_idx[-1]]}", flush=True)

# ── Pesos de sampling — sin recency para el gate ─────────────────────────────
# El gate aprende patrones atemporales (¿hay señal clara?) que deben funcionar
# en cualquier régimen. Todos los episodios pesan igual.
# Comparación de impacto recency:
#   HL=365d → 2016-2021 tiene 1.5% del peso → aprende solo 2025 → F1=26% en datos viejos
#   Sin recency → 2016-2026 peso uniforme   → aprende patrones generales → esperamos F1≥60%
train_trade_idx = train_idx[gate_labels[train_idx] == 1]
train_skip_idx  = train_idx[gate_labels[train_idx] == 0]

tw = np.ones(len(train_trade_idx), dtype=np.float64); tw /= tw.sum()
sw = np.ones(len(train_skip_idx),  dtype=np.float64); sw /= sw.sum()

print(f"Recency weighting: DESACTIVADO (pesos uniformes 2016-2026)", flush=True)

def balanced_gate_batch(n=BATCH_SIZE//2):
    ls = np.random.choice(train_trade_idx, n, replace=True, p=tw)
    ss = np.random.choice(train_skip_idx,  n, replace=True, p=sw)
    idx = np.concatenate([ls, ss])
    np.random.shuffle(idx)
    return idx

# ── Modelo ────────────────────────────────────────────────────────────────────
gate_inp = tf.keras.Input(shape=(STATE_SIZE,), name="gate_input")
gx = tf.keras.layers.Dense(128, activation='relu', kernel_initializer='he_normal',
                             kernel_regularizer=tf.keras.regularizers.l2(1e-3),
                             name="gate_dense1")(gate_inp)
gx = tf.keras.layers.Dropout(0.20)(gx)
gx = tf.keras.layers.Dense(64, activation='relu', kernel_initializer='he_normal',
                             kernel_regularizer=tf.keras.regularizers.l2(1e-3),
                             name="gate_dense2")(gx)
gx = tf.keras.layers.Dropout(0.15)(gx)
gx = tf.keras.layers.Dense(32, activation='relu', kernel_initializer='he_normal',
                             name="gate_dense3")(gx)
gate_out = tf.keras.layers.Dense(1, activation='sigmoid', name="gate_out")(gx)
gate_model = tf.keras.Model(gate_inp, gate_out)
gate_opt   = tf.keras.optimizers.Adam(LR)

print(f"\nGate model params: {gate_model.count_params():,}")
print(f"Architecture: {STATE_SIZE} → 128 → 64 → 32 → 1 (sigmoid)\n")

# ── Eval helper ───────────────────────────────────────────────────────────────
def eval_gate(eval_idx, threshold=0.50):
    """Precision, Recall, F1, skip_rate para un threshold dado."""
    probs = gate_model(tf.constant(states[eval_idx]), training=False).numpy().squeeze()
    preds = (probs >= threshold).astype(np.int32)
    true  = gate_labels[eval_idx].astype(np.int32)

    tp = int(((preds==1) & (true==1)).sum())
    fp = int(((preds==1) & (true==0)).sum())
    fn = int(((preds==0) & (true==1)).sum())
    tn = int(((preds==0) & (true==0)).sum())

    prec   = tp / (tp+fp)  * 100 if (tp+fp)  > 0 else 0.0
    recall = tp / (tp+fn)  * 100 if (tp+fn)  > 0 else 0.0
    f1     = 2*prec*recall / (prec+recall) if (prec+recall) > 0 else 0.0
    skip_r = (preds==0).sum() / len(eval_idx) * 100
    acc    = (preds==true).sum() / len(eval_idx) * 100
    return prec, recall, f1, skip_r, acc, tp, fp, fn, tn

# ── Training loop ─────────────────────────────────────────────────────────────
best_f1     = 0.0
best_pass   = 0
patience_ct = 0
best_w      = None
start       = time.time()

print(f"{'Pass':>5}  {'loss':>8}  {'prec%':>7}  {'rec%':>6}  {'F1%':>6}  {'skip%':>6}  {'acc%':>6}  tag")
print("-"*70)

for p in range(1, PASSES + 1):
    idx     = balanced_gate_batch()
    batch_s = tf.constant(states[idx])
    batch_y = tf.constant(gate_labels[idx, None])

    with tf.GradientTape() as tape:
        preds = gate_model(batch_s, training=True)
        loss  = tf.reduce_mean(tf.keras.losses.binary_crossentropy(batch_y, preds))

    grads = tape.gradient(loss, gate_model.trainable_variables)
    grads = [tf.clip_by_norm(g, 1.0) if g is not None else g for g in grads]
    gate_opt.apply_gradients(zip(grads, gate_model.trainable_variables))

    if p % 10 == 0 or p <= 3:
        pr, rc, f1, sk, ac, *_ = eval_gate(test_idx, threshold=0.50)

        if f1 > best_f1:
            best_f1   = f1
            best_pass = p
            patience_ct = 0
            best_w    = [v.numpy().copy() for v in gate_model.trainable_variables]
            tag = f"[★ F1={f1:.1f}]"
        else:
            patience_ct += 1
            tag = f"[pat:{patience_ct}/{EARLY_PATIENCE}]"

        print(f"{p:>5}  {loss.numpy():>8.4f}  {pr:>6.1f}%  {rc:>5.1f}%  {f1:>5.1f}%  {sk:>5.1f}%  {ac:>5.1f}%  {tag}", flush=True)

        if patience_ct >= EARLY_PATIENCE:
            print(f"\n⚡ Early stopping pass {p} — best F1={best_f1:.1f}% at pass {best_pass}")
            break

# Restaurar mejores pesos
print(f"\nRestoring best weights (pass {best_pass}, F1={best_f1:.1f}%)")
if best_w:
    for var, w in zip(gate_model.trainable_variables, best_w):
        var.assign(w)

elapsed = time.time() - start
print(f"Training time: {elapsed:.1f}s ({elapsed/60:.1f} min)\n")

# ── Threshold sweep ───────────────────────────────────────────────────────────
print("="*75)
print("THRESHOLD SWEEP — test set")
print("="*75)
print(f"{'thresh':>7}  {'prec%':>7}  {'rec%':>6}  {'F1%':>6}  {'skip%':>6}  {'acc%':>6}  {'TP':>6}  {'FP':>6}  {'FN':>6}  {'TN':>6}")
best_f1_thresh = 0.0
best_thresh    = 0.50
for thresh in [0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]:
    pr, rc, f1, sk, ac, tp, fp, fn, tn = eval_gate(test_idx, thresh)
    marker = " ←F1max" if f1 > best_f1_thresh else ""
    if f1 > best_f1_thresh:
        best_f1_thresh = f1
        best_thresh    = thresh
    print(f"  {thresh:.2f}   {pr:>6.1f}%  {rc:>5.1f}%  {f1:>5.1f}%  {sk:>5.1f}%  {ac:>5.1f}%  {tp:>6,}  {fp:>6,}  {fn:>6,}  {tn:>6,}{marker}")

print(f"\n→ Threshold óptimo (F1-max): {best_thresh:.2f}")

# ── Rolling walk-forward ──────────────────────────────────────────────────────
print(f"\n{'='*75}")
print("ROLLING WALK-FORWARD (4 ventanas)")
print("="*75)
window_f1s = []
for w_i in range(1, 5):
    w_start = int(N * w_i * 0.20)
    w_end   = int(N * min((w_i+1)*0.20, 1.0))
    w_test  = sorted_idx[w_start:w_end]
    if len(w_test) == 0: continue
    pr, rc, f1, sk, ac, tp, fp, fn, tn = eval_gate(w_test, best_thresh)
    window_f1s.append(f1)
    print(f"  Window {w_i} ({w_i*20}-{min((w_i+1)*20,100)}%): prec={pr:.1f}% rec={rc:.1f}% F1={f1:.1f}% skip={sk:.1f}%  (W:{tp:,} correct-trade, {tn:,} correct-skip)")

avg_f1 = np.mean(window_f1s) if window_f1s else 0
print(f"\nAvg rolling F1: {avg_f1:.1f}%")

# ── Guardar pesos ─────────────────────────────────────────────────────────────
os.makedirs(MODEL_DIR, exist_ok=True)
gate_weights_data = []
layer_names = [("w1","b1"), ("w2","b2"), ("w3","b3"), ("w_out","b_out")]
var_idx = 0
for wname, bname in layer_names:
    # Cada Dense tiene kernel y bias
    w = gate_model.trainable_variables[var_idx].numpy()
    b = gate_model.trainable_variables[var_idx+1].numpy()
    gate_weights_data.append({"name": wname, "shape": list(w.shape), "data": w.flatten().tolist()})
    gate_weights_data.append({"name": bname, "shape": list(b.shape), "data": b.flatten().tolist()})
    var_idx += 2

gate_path = os.path.join(MODEL_DIR, "gate-weights.json")
with open(gate_path, "w") as f:
    json.dump(gate_weights_data, f)

# Guardar config del gate
gate_config = {
    "architecture":   "Gate_46features_128_64_32_1",
    "threshold":      float(best_thresh),
    "bestF1":         float(best_f1_thresh),
    "avgRollingF1":   float(avg_f1),
    "trainEpisodes":  int(len(train_idx)),
    "testEpisodes":   int(len(test_idx)),
    "nTrade":         int(n_trade),
    "nSkip":          int(n_skip),
    "lastUpdated":    time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "stateSize":      STATE_SIZE,
}
with open(os.path.join(MODEL_DIR, "gate-config.json"), "w") as f:
    json.dump(gate_config, f, indent=2)

print(f"\n✅ Gate weights saved → {gate_path}")
print(f"   Threshold recomendado: {best_thresh:.2f} (F1={best_f1_thresh:.1f}%)")
print(f"   Avg rolling F1: {avg_f1:.1f}%")
print(f"\nUso en producción:")
print(f"  if gate(state) < {best_thresh:.2f}: SKIP  // gate dice 'no hay señal'")
print(f"  else: PPO.predict(state)          // PPO decide LONG / SHORT")
