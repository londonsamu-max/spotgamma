#!/bin/bash
# nightly-retrain.sh — Wrapper para cron
#
# NOTE: This script is designed for Unix/Mac cron and is NOT compatible with
# Windows natively. On Windows, use Task Scheduler with nightly-retrain.py directly,
# or run this script via Git Bash / WSL.
#
# Instalar en crontab:
#   crontab -e
#   0 5 * * 1-5 /path/to/scripts/nightly-retrain.sh
#
# Corre de lunes a viernes a las 5:00 AM (hora local = ET)
# Después del cierre del mercado americano, antes de la apertura europea.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_DIR/data/nightly-retrain.log"

# Rotación de log (conservar últimos 1000 líneas)
if [ -f "$LOG_FILE" ]; then
    tail -1000 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

echo "===== $(date '+%Y-%m-%d %H:%M:%S') — Iniciando nightly retrain =====" >> "$LOG_FILE"

python3 "$SCRIPT_DIR/nightly-retrain.py" >> "$LOG_FILE" 2>&1

echo "===== $(date '+%Y-%m-%d %H:%M:%S') — Finalizado =====" >> "$LOG_FILE"
