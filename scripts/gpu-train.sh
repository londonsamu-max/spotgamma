#!/bin/bash
# GPU Training Pipeline
# 1. Export episodes from Node.js server
# 2. Train on Metal GPU with Python
# 3. Weights auto-exported to data/ppo-multihead-model/

PASSES=${1:-5000}
PORT=${2:-3000}

echo "=== GPU Training Pipeline ==="
echo "Passes: $PASSES"
echo ""

# Step 1: Export training episodes
echo "[1/3] Exporting training episodes from server..."
curl -s -X POST "http://localhost:$PORT/api/trpc/market.exportTrainingEpisodes" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -c "
import sys, json
raw = sys.stdin.read()
if not raw.strip():
    print('ERROR: Server not responding')
    sys.exit(1)
d = json.loads(raw)
r = d.get('result', {}).get('data', {}).get('json', {})
print(f'Exported {r.get(\"episodes\", 0)} episodes to {r.get(\"path\", \"?\")}')
" || { echo "Failed to export. Is the server running on port $PORT?"; exit 1; }

# Step 2: Train on GPU
echo ""
echo "[2/3] Training on Metal GPU ($PASSES passes)..."
python3 "$(dirname "$0")/gpu-train-multihead.py" --passes "$PASSES"

# Step 3: Done — weights already in data/ppo-multihead-model/
echo ""
echo "[3/3] Weights exported. Restart the Node.js server to load new weights."
echo ""
echo "To restart: kill the server and run 'npm run dev'"
