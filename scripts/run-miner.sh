#!/bin/bash
REPO_URL="${1:?Usage: ./run-miner.sh <repo-url>}"
REPO_NAME=$(basename "$REPO_URL" .git)
echo "=================================================="
echo "  NREKI CHRONOS ORCHESTRATOR - TRUE CRASH-ONLY"
echo "  Target: $REPO_NAME"
echo "=================================================="
# 8GB heap para repos grandes como VSCode
export NODE_OPTIONS="--max-old-space-size=8192"
while true; do 
    cd "$(dirname "$0")/.." || exit 1
    
    # KILL SWITCH IMPLACABLE: Si Node se congela en CPU, el OS lo aniquila en 180s.
    timeout 180s npx tsx scripts/chronos-miner.ts "$REPO_URL"
    
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -eq 42 ]; then
        echo "=================================================="
        echo "  MINING 100% COMPLETE. Dataset ready."
        echo "=================================================="
        rm -f "${REPO_NAME}_immortality_drive.json"
        rm -f "${REPO_NAME}_active.tmp"
        break
    elif [ $EXIT_CODE -eq 124 ]; then
        echo "[ORCHESTRATOR] ⚠️ OS TIMEOUT (180s). Node event loop blocked. Poisoning commit and respawning..."
        sleep 2
    elif [ $EXIT_CODE -eq 0 ]; then
        echo "[ORCHESTRATOR] Tactical RAM flush (Batch Limit). Resuming instantly..."
    else
        echo "[ORCHESTRATOR] Crash (exit $EXIT_CODE). Clearing git locks and resuming in 3s..."
        rm -f "/tmp/nreki-bare-${REPO_NAME}/.git/index.lock" 2>/dev/null
        rm -f "/tmp/nreki-wt-${REPO_NAME}/.git/index.lock" 2>/dev/null
        sleep 3
    fi
done
