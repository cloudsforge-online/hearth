#!/usr/bin/env bash
# Run a small Hearth network locally without Docker: one seed + two miners.
# Usage: ./scripts/run-local-network.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$ROOT/node"
LOGS="$ROOT/.netlogs"
DATA="$ROOT/.netdata"
mkdir -p "$LOGS" "$DATA"

pids=()
cleanup() {
  echo; echo "stopping network..."
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "starting seed node (RPC :8645, P2P :8646)..."
node "$NODE/bin/hearthd.js" --data "$DATA/seed" --rpc 8645 --p2p 8646 \
  > "$LOGS/seed.log" 2>&1 &
pids+=($!)
sleep 1

echo "starting miner1 (peers seed)..."
node "$NODE/bin/hearthd.js" --data "$DATA/miner1" --rpc 8647 --p2p 8648 \
  --peer 127.0.0.1:8646 --mine --throttle 0.6 > "$LOGS/miner1.log" 2>&1 &
pids+=($!)

echo "starting miner2 (peers seed)..."
node "$NODE/bin/hearthd.js" --data "$DATA/miner2" --rpc 8649 --p2p 8650 \
  --peer 127.0.0.1:8646 --mine --throttle 0.6 > "$LOGS/miner2.log" 2>&1 &
pids+=($!)

cat <<EOF

Hearth local network is up.
  seed   RPC  http://localhost:8645   (logs: .netlogs/seed.log)
  miner1 RPC  http://localhost:8647   (logs: .netlogs/miner1.log)
  miner2 RPC  http://localhost:8649   (logs: .netlogs/miner2.log)

Try:
  curl -s localhost:8645/info
  cd node && node bin/hearth-cli.js --rpc http://localhost:8645 blocks 5
  open web/explorer.html   (append ?rpc=http://localhost:8645)

Press Ctrl-C to stop.
EOF

wait
