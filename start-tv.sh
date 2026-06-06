#!/bin/bash
# Run this before starting Claude Code.
# VS Code sets ELECTRON_RUN_AS_NODE=1 which breaks TradingView's Electron launcher.

PORT="${1:-9222}"
TV="/Applications/TradingView.app/Contents/MacOS/TradingView"

if [ ! -f "$TV" ]; then
  echo "Error: TradingView not found at $TV"
  exit 1
fi

# Check if already running with CDP
if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
  echo "TradingView already running with CDP on port $PORT"
  exit 0
fi

pkill -x TradingView 2>/dev/null
sleep 1

echo "Launching TradingView with CDP on port $PORT..."
env -u ELECTRON_RUN_AS_NODE "$TV" --remote-debugging-port=$PORT &

for i in $(seq 1 20); do
  if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
    echo "CDP ready on port $PORT (PID $!)"
    exit 0
  fi
  sleep 1
done

echo "Warning: CDP not responding after 20s — TradingView may still be loading."
