#!/usr/bin/env bash
# FileHub 启动脚本 (macOS / Linux / Git Bash)
set -e
cd "$(dirname "$0")"
echo "[FileHub] 检查依赖..."
python -m pip install -q -r requirements.txt
echo "[FileHub] 启动服务 http://127.0.0.1:8000"
exec python server/main.py
