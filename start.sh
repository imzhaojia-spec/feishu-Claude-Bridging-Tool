#!/usr/bin/env bash
# 飞书桥接 — 进程监督脚本 (Mac / Linux)
# exit 0 = 正常退出不重启, exit 1 = 崩溃重启

while true; do
  echo "[$(date)] 飞书桥接启动..."
  node src/main.js
  code=$?
  if [ $code -eq 0 ]; then
    echo "[$(date)] 桥接正常退出。"
    break
  fi
  echo "[$(date)] 桥接崩溃 (exit=$code)，3 秒后重启..."
  sleep 3
done
