#!/bin/bash
# Starts Sectional and opens it in your browser. Close this window to stop it.
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Run setup.command first."; read -r -p "Press Return to close."; exit 1
fi
export PYTORCH_ENABLE_MPS_FALLBACK=1
( sleep 3; open "http://localhost:8765" ) &
exec .venv/bin/python -m app.main
