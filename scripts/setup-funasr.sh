#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
runtime_dir="$project_dir/.venv-funasr"

if command -v python3.11 >/dev/null 2>&1; then
  python_cmd="python3.11"
elif command -v python3.12 >/dev/null 2>&1; then
  python_cmd="python3.12"
else
  echo "CalMee FunASR requires Python 3.11 or 3.12."
  exit 1
fi

"$python_cmd" -m venv "$runtime_dir"
"$runtime_dir/bin/python" -m pip install --upgrade pip wheel
"$runtime_dir/bin/python" -m pip install -r "$project_dir/funasr_sidecar/requirements.txt"
"$runtime_dir/bin/python" "$project_dir/funasr_sidecar/main.py" --self-test

echo "FunASR runtime is ready at $runtime_dir"
