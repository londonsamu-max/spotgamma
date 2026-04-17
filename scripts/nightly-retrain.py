#!/usr/bin/env python3
"""
nightly-retrain.py — Reentrenamiento nocturno automático
=========================================================
Corre cada noche a las 5:00 AM ET (después del cierre del mercado).

Flujo:
  1. Verifica si hay nuevos episodios live desde el último retrain
  2. Si hay suficientes episodios nuevos (MIN_NEW_EPISODES): retrain completo
  3. Guarda metadata del retrain para auditoría
  4. Coloca un flag ".weights-updated" que el servidor detecta al iniciar
"""
import os, sys, json, subprocess, datetime, shutil

_SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.join(_SCRIPT_DIR, "..")
DATA_DIR     = os.path.join(_PROJECT_DIR, "data")
SCRIPTS_DIR  = _SCRIPT_DIR
MODEL_MLP    = os.path.join(DATA_DIR, "ppo-multihead-model")
MODEL_LSTM   = os.path.join(DATA_DIR, "ppo-multihead-model-lstm")
LIVE_BANK    = os.path.join(DATA_DIR, "live-episodes.jsonl")
RETRAIN_LOG  = os.path.join(DATA_DIR, "retrain-history.json")
TRAIN_SCRIPT_MLP  = os.path.join(DATA_DIR, "train-tf-metal.py")
TRAIN_SCRIPT_LSTM = os.path.join(DATA_DIR, "train-tf-metal-lstm.py")

MIN_NEW_EPISODES = 10    # mínimo de episodios nuevos para retrain
LOG_LINES_KEEP   = 30    # últimas líneas del retrain a guardar

def load_retrain_history():
    if os.path.exists(RETRAIN_LOG):
        with open(RETRAIN_LOG) as f:
            return json.load(f)
    return {"runs": [], "last_episode_count": 0}

def save_retrain_history(h):
    with open(RETRAIN_LOG, "w") as f:
        json.dump(h, f, indent=2)

def count_live_episodes():
    if not os.path.exists(LIVE_BANK):
        return 0
    with open(LIVE_BANK) as f:
        return sum(1 for line in f if line.strip())

def run_training(script_path, log_path):
    """Ejecuta el script de entrenamiento y captura la salida."""
    print(f"  Running: python3 {os.path.basename(script_path)}", flush=True)
    try:
        result = subprocess.run(
            ["python3", script_path],
            capture_output=True, text=True, timeout=3600
        )
        # Guardar log
        with open(log_path, "w") as f:
            f.write(result.stdout)
            if result.stderr:
                f.write("\n--- STDERR ---\n")
                f.write(result.stderr)

        # Extraer métricas de las últimas líneas
        lines = result.stdout.strip().split("\n")
        last_lines = lines[-LOG_LINES_KEEP:]
        metrics = {}
        for line in last_lines:
            if "Direction Accuracy:" in line:
                try: metrics["dirAcc"] = float(line.split(":")[1].strip().split("%")[0])
                except: pass
            if "Naive WR:" in line:
                try: metrics["naiveWR"] = float(line.split(":")[1].strip().split("%")[0])
                except: pass
            if "Avg rolling dirAcc:" in line:
                try: metrics["avgRolling"] = float(line.split(":")[1].strip().split("%")[0])
                except: pass

        return result.returncode == 0, metrics, "\n".join(last_lines)
    except subprocess.TimeoutExpired:
        return False, {}, "TIMEOUT"
    except Exception as e:
        return False, {}, str(e)

def main():
    now = datetime.datetime.now()
    print(f"\n{'='*60}")
    print(f"NIGHTLY RETRAIN — {now.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*60}\n", flush=True)

    # ── Verificar episodios disponibles ──────────────────────────────────────
    total_eps = count_live_episodes()
    history   = load_retrain_history()
    last_count= history.get("last_episode_count", 0)
    new_eps   = total_eps - last_count

    print(f"Live episodes: {total_eps} total ({new_eps} nuevos desde último retrain)")

    if new_eps < MIN_NEW_EPISODES:
        print(f"  → Insuficientes episodios nuevos (min={MIN_NEW_EPISODES}). Saltando retrain.")
        run_record = {
            "date":     now.isoformat(),
            "skipped":  True,
            "reason":   f"solo {new_eps} episodios nuevos (min={MIN_NEW_EPISODES})",
            "total_eps": total_eps,
        }
        history["runs"].append(run_record)
        history["runs"] = history["runs"][-50:]  # keep last 50
        save_retrain_history(history)
        return

    # ── Backup de pesos actuales ──────────────────────────────────────────────
    date_str = now.strftime("%Y%m%d")
    for model_dir in [MODEL_MLP, MODEL_LSTM]:
        if os.path.exists(model_dir):
            backup = model_dir + f"_backup_{date_str}"
            if not os.path.exists(backup):
                shutil.copytree(model_dir, backup)
                print(f"  Backup: {os.path.basename(backup)}")

    run_record = {
        "date":      now.isoformat(),
        "skipped":   False,
        "total_eps": total_eps,
        "new_eps":   new_eps,
        "mlp":       {},
        "lstm":      {},
    }

    # ── Retrain MLP (train-tf-metal.py) ──────────────────────────────────────
    print(f"\n── MLP Retrain ──", flush=True)
    mlp_log = os.path.join(DATA_DIR, f"retrain-mlp-{date_str}.log")
    ok_mlp, metrics_mlp, last_mlp = run_training(TRAIN_SCRIPT_MLP, mlp_log)
    run_record["mlp"] = {"ok": ok_mlp, "metrics": metrics_mlp, "log": mlp_log}
    if ok_mlp:
        print(f"  ✅ MLP: dirAcc={metrics_mlp.get('dirAcc','?')}% naiveWR={metrics_mlp.get('naiveWR','?')}%")
    else:
        print(f"  ❌ MLP falló")

    # ── Retrain LSTM (train-tf-metal-lstm.py) — solo si hay suficientes días ──
    if total_eps >= 50:  # necesita al menos 50 episodios para secuencias LSTM
        print(f"\n── LSTM Retrain ──", flush=True)
        lstm_log = os.path.join(DATA_DIR, f"retrain-lstm-{date_str}.log")
        ok_lstm, metrics_lstm, last_lstm = run_training(TRAIN_SCRIPT_LSTM, lstm_log)
        run_record["lstm"] = {"ok": ok_lstm, "metrics": metrics_lstm, "log": lstm_log}
        if ok_lstm:
            print(f"  ✅ LSTM: dirAcc={metrics_lstm.get('dirAcc','?')}% naiveWR={metrics_lstm.get('naiveWR','?')}%")
        else:
            print(f"  ❌ LSTM falló (puede ser insuficiente historia secuencial)")
    else:
        print(f"\n── LSTM: skip (necesita ≥50 episodios, hay {total_eps}) ──")
        run_record["lstm"] = {"ok": False, "reason": f"insuficiente historia ({total_eps} < 50)"}

    # ── Flag para que el servidor detecte nuevos pesos ────────────────────────
    flag_path = os.path.join(DATA_DIR, ".weights-updated")
    with open(flag_path, "w") as f:
        f.write(now.isoformat())
    print(f"\n  Flag escrito: {flag_path}")

    # ── Guardar historial ─────────────────────────────────────────────────────
    history["last_episode_count"] = total_eps
    history["runs"].append(run_record)
    history["runs"] = history["runs"][-50:]
    save_retrain_history(history)

    print(f"\n✅ Nightly retrain completado — {now.strftime('%H:%M:%S')}")

if __name__ == "__main__":
    main()
