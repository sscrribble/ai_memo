#!/usr/bin/env bash
# 실행 중인 AI 메모 서버를 멈춘다 (자동으로 다시 켜지지 않게 시작 스크립트도 함께).
#
#   bash scripts/stop.sh
pkill -f "scripts/start.sh" 2>/dev/null
pkill -f "cloudflared tunnel --no-autoupdate run" 2>/dev/null # 밖에서 접속하는 터널도
if pkill -f "uvicorn app:app" 2>/dev/null; then
  echo "서버를 멈췄습니다."
else
  echo "실행 중인 서버가 없습니다."
fi
command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
exit 0
