#!/data/data/com.termux/files/usr/bin/bash
# Tailscale 없이 밖에서도 접속할 수 있게 Cloudflare 터널을 연결한다.
#
#   bash ~/ai_memo/scripts/termux-tunnel.sh
#
# 준비물: Cloudflare 계정과 Cloudflare 에 등록한 도메인 (README 의 '밖에서 접속하기' 참고).
# 다시 실행하면 토큰을 바꾸거나, 비워 두어 터널을 끌 수 있다.
set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
INTERACTIVE=1
[ "${AI_MEMO_NONINTERACTIVE:-}" = 1 ] && INTERACTIVE=0
{ true </dev/tty; } 2>/dev/null || INTERACTIVE=0

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
ask() { # ask 변수이름 "질문" — 환경변수로 이미 정해져 있으면 묻지 않는다
  local name=$1 prompt=$2 value=""
  declare -p "$name" >/dev/null 2>&1 && return 0
  [ "$INTERACTIVE" = 1 ] && read -rp "$prompt" value </dev/tty
  printf -v "$name" '%s' "$value"
}

# .env 에서 터널 설정 줄을 빼고 다시 쓴다
write_env() { # write_env [토큰 주소]
  local tmp="$ENV_FILE.new"
  grep -v -E '^(CLOUDFLARE_TUNNEL_TOKEN|MEMO_PUBLIC_URL)=' "$ENV_FILE" >"$tmp" || true
  if [ $# -eq 2 ]; then
    printf 'CLOUDFLARE_TUNNEL_TOKEN=%q\n' "$1" >>"$tmp"
    printf 'MEMO_PUBLIC_URL=%q\n' "$2" >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

main() {
  if [ ! -f "$ENV_FILE" ]; then
    warn "설정 파일이 없습니다. 먼저 설치하세요: bash $APP_DIR/scripts/termux-install.sh"
    exit 1
  fi

  say "1/3 cloudflared 설치"
  if command -v cloudflared >/dev/null 2>&1; then
    echo "이미 설치되어 있습니다."
  else
    pkg install -y cloudflared
  fi

  say "2/3 터널 토큰"
  echo "Cloudflare 에서 터널을 만들면 나오는 설치 명령을 통째로 붙여 넣으세요."
  echo "  예) cloudflared service install eyJhIjoiNjQ...   (토큰만 붙여 넣어도 됩니다)"
  echo "  아무것도 입력하지 않으면 터널을 끕니다."
  ask TUNNEL_INPUT "> "
  if [ -z "$TUNNEL_INPUT" ]; then
    write_env
    echo "터널을 껐습니다. 이제 같은 Wi-Fi 에서만 접속됩니다."
  else
    # 붙여 넣은 명령에서 토큰(eyJ 로 시작하는 긴 글자)만 골라낸다
    local token
    token=$(printf '%s\n' "$TUNNEL_INPUT" | tr ' ' '\n' | grep -E '^eyJ[A-Za-z0-9_=-]{20,}' | tail -n 1 || true)
    if [ -z "$token" ]; then
      warn "토큰을 찾지 못했습니다. 'eyJ' 로 시작하는 긴 글자가 들어 있어야 합니다."
      exit 1
    fi
    echo "그 터널에 연결한 주소를 입력하세요 (Cloudflare 의 Public Hostname)."
    ask PUBLIC_URL "  예) memo.example.com > "
    local url=${PUBLIC_URL%/}
    case "$url" in "" | http://* | https://*) ;; *) url="https://$url" ;; esac
    write_env "$token" "$url"
    echo "저장했습니다. 밖에서는 ${url:-Cloudflare 에 연결한 주소} 로 접속하세요."
  fi

  say "3/3 서버 다시 시작"
  local answer="n"
  [ "$INTERACTIVE" = 1 ] && read -rp "지금 서버를 다시 시작할까요? [Y/n] " answer </dev/tty
  case "${answer:-y}" in
    [nN]*) echo "나중에 다시 시작하면 적용됩니다: bash $APP_DIR/scripts/stop.sh 후 start.sh" ;;
    *)
      bash "$APP_DIR/scripts/stop.sh" >/dev/null
      sleep 1
      exec bash "$APP_DIR/scripts/start.sh"
      ;;
  esac
}

main "$@"
