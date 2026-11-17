#!/data/data/com.termux/files/usr/bin/bash
# AI 메모 서버를 안드로이드 휴대폰(Termux)에 설치한다.
#
#   pkg install -y git && git clone https://github.com/sscrribble/ai_memo ~/ai_memo && bash ~/ai_memo/scripts/termux-install.sh
#
# 다시 실행하면 최신 코드로 업데이트한다 (비밀번호 등 설정은 그대로 둔다).
set -Eeuo pipefail

REPO="${AI_MEMO_REPO:-https://github.com/sscrribble/ai_memo}"
APP_DIR="${AI_MEMO_DIR:-$HOME/ai_memo}"
# Termux 용으로 미리 빌드해 둔 파이썬 패키지 저장소 (TUR). 있으면 휴대폰에서 직접 빌드하지 않아도 된다.
TUR_INDEX="${AI_MEMO_PIP_INDEX-https://termux-user-repository.github.io/pypi/}"
INTERACTIVE=1
[ "${AI_MEMO_NONINTERACTIVE:-}" = 1 ] && INTERACTIVE=0
{ true </dev/tty; } 2>/dev/null || INTERACTIVE=0

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
on_termux() { case "${PREFIX:-}" in *com.termux*) return 0 ;; *) return 1 ;; esac; }

# 질문해서 변수에 담는다. 환경변수로 이미 정해져 있으면 묻지 않는다.
ask() { # ask 변수이름 "질문" [secret]
  local name=$1 prompt=$2 secret=${3:-} value=""
  declare -p "$name" >/dev/null 2>&1 && return 0
  if [ "$INTERACTIVE" = 1 ]; then
    if [ -n "$secret" ]; then read -rsp "$prompt" value </dev/tty; echo; else read -rp "$prompt" value </dev/tty; fi
  fi
  printf -v "$name" '%s' "$value"
}

pip_install() {
  local args=(--disable-pip-version-check)
  [ -n "$TUR_INDEX" ] && args+=(--extra-index-url "$TUR_INDEX")
  python -m pip install "${args[@]}" "$@"
}

# 미리 빌드된 파일이 없을 때만: 휴대폰에서 직접 빌드할 도구 설치
use_rust() {
  command -v cargo >/dev/null 2>&1 && return 0
  warn "미리 빌드된 파일이 없어 휴대폰에서 직접 빌드합니다. 10~20분 걸릴 수 있습니다."
  pkg install -y rust binutils
  if on_termux; then
    case "$(uname -m)" in
      aarch64) export CARGO_BUILD_TARGET=aarch64-linux-android ;;
      armv7l | armv8l) export CARGO_BUILD_TARGET=armv7-linux-androideabi ;;
      x86_64) export CARGO_BUILD_TARGET=x86_64-linux-android ;;
      i686) export CARGO_BUILD_TARGET=i686-linux-android ;;
    esac
  fi
}

# 실행 중에 git pull 로 이 파일이 바뀌어도 안전하도록 전체를 함수로 감싸 먼저 읽어 둔다
main() {
  trap 'warn "설치 중에 문제가 생겼습니다. 위의 메시지를 확인한 뒤 같은 명령을 다시 실행해 보세요."' ERR
  on_termux || warn "Termux 가 아닌 환경으로 보입니다. 그래도 계속합니다."

  say "1/5 Termux 패키지 설치"
  pkg update -y
  (set +o pipefail; yes | pkg upgrade -y) || warn "일부 패키지를 업데이트하지 못했습니다. 계속합니다."
  pkg install -y python git nano
  pkg install -y python-pip >/dev/null 2>&1 || true
  python -m pip --version >/dev/null 2>&1 || python -m ensurepip
  # 웹 푸시용 암호화(cryptography)와 휴대폰 알림(termux-api)은 없어도 앱은 동작한다
  pkg install -y python-cryptography || warn "python-cryptography 가 없어 웹 푸시 알림은 꺼집니다."
  pkg install -y termux-api || warn "termux-api 가 없어 이 휴대폰에 알림을 띄울 수 없습니다."

  say "2/5 파이썬 패키지 설치 (처음엔 몇 분 걸립니다)"
  if ! pip_install --only-binary=pydantic-core fastapi uvicorn tzdata; then
    use_rust
    pip_install fastapi uvicorn tzdata
  fi
  if ! pip_install --only-binary=pydantic-core,jiter anthropic; then
    use_rust
    pip_install anthropic || warn "AI 라이브러리(anthropic)를 설치하지 못했습니다. 키워드 규칙으로 분류합니다."
  fi

  say "3/5 앱 내려받기"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  else
    git clone --depth 1 "$REPO" "$APP_DIR"
  fi
  mkdir -p "$APP_DIR/data"

  say "4/5 설정"
  local env_file="$APP_DIR/.env"
  if [ -f "$env_file" ]; then
    echo "기존 설정을 그대로 씁니다: $env_file"
  else
    ask MEMO_PASSWORD "접속 비밀번호를 정하세요 (다른 기기에서 로그인할 때 씁니다): " secret
    while [ -z "$MEMO_PASSWORD" ] && [ "$INTERACTIVE" = 1 ]; do
      unset MEMO_PASSWORD
      ask MEMO_PASSWORD "비밀번호는 비워 둘 수 없습니다. 다시 입력하세요: " secret
    done
    [ -n "$MEMO_PASSWORD" ] || warn "비밀번호 없이 설치합니다. 주소를 아는 누구나 접속할 수 있습니다."
    ask ANTHROPIC_API_KEY "Claude API 키 (없으면 그냥 Enter. 나중에 넣어도 됩니다): " secret
    local backup_dir=""
    if on_termux && [ "$INTERACTIVE" = 1 ]; then
      echo "백업을 휴대폰 공용 폴더(Documents)에 저장하려면 곧 뜨는 권한 창에서 '허용'을 누르세요."
      termux-setup-storage || true
      read -rp "허용했거나 건너뛰려면 Enter: " _ </dev/tty || true
    fi
    if [ -d "$HOME/storage/shared" ]; then
      backup_dir="$HOME/storage/shared/Documents/ai-memo-backup"
      mkdir -p "$backup_dir" || backup_dir=""
    fi
    {
      echo "# AI 메모 설정 (termux-install.sh 가 만듦). 바꾼 뒤에는 서버를 다시 시작하세요."
      printf 'MEMO_PASSWORD=%q\n' "$MEMO_PASSWORD"
      printf 'ANTHROPIC_API_KEY=%q\n' "$ANTHROPIC_API_KEY"
      echo "MEMO_TZ=Asia/Seoul"
      if [ -n "$backup_dir" ]; then printf 'MEMO_BACKUP_DIR=%q\n' "$backup_dir"; fi
    } >"$env_file"
    chmod 600 "$env_file"
    echo "설정을 저장했습니다: $env_file"
  fi

  say "5/5 휴대폰을 켜면 자동으로 시작하도록 설정"
  mkdir -p "$HOME/.termux/boot"
  cat >"$HOME/.termux/boot/ai-memo" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
# 휴대폰을 켜면 AI 메모 서버를 시작한다 (Termux:Boot 앱이 실행). 기록: $APP_DIR/data/server.log
termux-wake-lock
exec bash "$APP_DIR/scripts/start.sh" >>"$APP_DIR/data/server.log" 2>&1
EOF
  chmod +x "$HOME/.termux/boot/ai-memo"
  echo "Termux:Boot 앱을 설치하고 한 번 열어 두면, 휴대폰을 다시 켤 때 서버도 자동으로 켜집니다."

  say "설치 끝"
  cat <<EOF
  서버 시작:   bash $APP_DIR/scripts/start.sh
  서버 멈춤:   bash $APP_DIR/scripts/stop.sh
  업데이트:    bash $APP_DIR/scripts/termux-install.sh   (설정은 그대로)
  설정 바꾸기: nano $APP_DIR/.env   (바꾼 뒤 서버 다시 시작)

  꼭 해 주세요: 휴대폰 설정 → 애플리케이션 → Termux → 배터리 → '제한 없음'
  (그래야 화면이 꺼져도 서버가 멈추지 않습니다)
EOF
  trap - ERR
  local answer="n"
  [ "$INTERACTIVE" = 1 ] && read -rp $'\n지금 서버를 시작할까요? [Y/n] ' answer </dev/tty
  case "${answer:-y}" in
    [nN]*) ;;
    *) exec bash "$APP_DIR/scripts/start.sh" ;;
  esac
}

main "$@"
