#!/bin/bash
# One-time setup for Sectional. Double-click this file, or run:  bash setup.command
set -e
cd "$(dirname "$0")"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

say "1/4  Getting a Python toolchain (uv)…"
if command -v uv >/dev/null 2>&1; then UV="$(command -v uv)"
elif [ -x "$HOME/.local/bin/uv" ]; then UV="$HOME/.local/bin/uv"
else
  curl -LsSf https://astral.sh/uv/install.sh | sh
  UV="$HOME/.local/bin/uv"
fi

say "2/4  Installing the app's Python packages (a few minutes the first time)…"
"$UV" venv --python 3.12 --allow-existing .venv
"$UV" pip install --python .venv/bin/python -r requirements.txt

say "3/4  Signing in to Hugging Face…"
cat <<'MSG'
Legato 2 is free, but its authors ask you to accept their terms first:
  a) Open https://huggingface.co/guangyangmusic/legato-2 while signed in and click to agree.
  b) Create a "Read" token at https://huggingface.co/settings/tokens and paste it below.
MSG
if [ -n "$HF_TOKEN" ] || [ -s "${HF_HOME:-$HOME/.cache/huggingface}/token" ]; then
  echo "Already signed in to Hugging Face."
else
  open "https://huggingface.co/guangyangmusic/legato-2" 2>/dev/null || true
  .venv/bin/hf auth login
fi

say "4/4  Downloading Legato 2 (~1.9 GB) and checking it reads music correctly…"
if ! .venv/bin/python -m app.selftest; then
  cat <<'MSG'

Setup stopped at the model check. If the message above mentions access or "gated",
accept the terms at https://huggingface.co/guangyangmusic/legato-2 and run setup again.
MSG
  exit 1
fi

chmod +x start.command 2>/dev/null || true
say "All set. Double-click start.command to open Sectional."
