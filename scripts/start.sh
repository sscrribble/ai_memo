#!/usr/bin/env bash
# AI 메모 서버를 시작한다 (휴대폰 Termux·리눅스·맥 공통). 멈추면 5초 뒤 다시 시작한다.
#
#   bash scripts/start.sh
#
# 설정은 프로젝트 폴더의 .env 파일에서 읽는다 (.env.example 참고).
set -u
cd "$(dirname "$0")/.." || exit 1
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
PORT="${MEMO_PORT:-8000}"

# 이미 켜져 있으면 하나만 돌도록 끝낸다 (자동 시작과 겹칠 때)
if python -c "import socket,sys; s=socket.socket(); s.settimeout(1); sys.exit(0 if s.connect_ex(('127.0.0.1', $PORT)) == 0 else 1)" 2>/dev/null; then
  echo "이미 $PORT 포트에서 서버가 실행 중입니다. 멈추려면: bash scripts/stop.sh"
  exit 0
fi

command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock # 화면이 꺼져도 멈추지 않게

ip=$(python -c "import socket; s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80)); print(s.getsockname()[0])" 2>/dev/null || true)
echo "AI 메모 서버를 시작합니다."
echo "  이 기기에서:        http://localhost:$PORT"
[ -n "$ip" ] && echo "  같은 Wi-Fi 기기에서: http://$ip:$PORT"

# 밖에서도 접속: Cloudflare 터널 (scripts/termux-tunnel.sh 로 설정). 끊기면 10초 뒤 다시 연결한다.
tunnel_pid=""
cleanup() {
  [ -n "$tunnel_pid" ] && kill "$tunnel_pid" 2>/dev/null
  pkill -f "cloudflared tunnel --no-autoupdate run" 2>/dev/null
}
trap cleanup EXIT
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    mkdir -p data
    (
      while true; do
        TUNNEL_TOKEN="$CLOUDFLARE_TUNNEL_TOKEN" cloudflared tunnel --no-autoupdate run >>data/tunnel.log 2>&1
        sleep 10
      done
    ) &
    tunnel_pid=$!
    echo "  밖에서:             ${MEMO_PUBLIC_URL:-Cloudflare 에 연결한 주소}  (터널 기록: data/tunnel.log)"
  else
    echo "  ! cloudflared 가 없어 밖에서 접속하는 터널을 켜지 못했습니다. 설치: pkg install cloudflared"
  fi
fi
echo "  멈추려면 Ctrl+C 를 두 번 누르세요."

cd server || exit 1
while true; do
  python -m uvicorn app:app --host 0.0.0.0 --port "$PORT"
  echo "서버가 멈췄습니다. 5초 뒤 다시 시작합니다."
  sleep 5
done
