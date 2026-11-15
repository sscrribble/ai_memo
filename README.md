# AI 메모

적기만 하면 AI가 알아서 분류하는 메모 앱. 서버 하나에 휴대폰·태블릿·노트북·PC가 모두 접속해 실시간으로 동기화됩니다.

## 기능

- **AI 자동 분류**: 할 일 / 장보기 / 아이디어 / 정보·참고 / 일기·생각 / 기타
  - 제목·태그를 자동으로 만들고, "내일 3시", "다음주 금요일" 같은 날짜를 실제 날짜로 바꿉니다
  - 장보기 메모는 물건별 체크리스트로 나눕니다 ("우유 2개, 계란" → 우유(2개), 계란)
  - 분류가 틀리면 배지를 눌러 직접 바꾸면 됩니다 (이후 AI가 덮어쓰지 않음)
- **할 일**: 지난 일 / 오늘 / 예정 / 날짜 없음 / 완료로 묶어서 보기
- **캘린더**: 날짜가 있는 메모를 월간 달력으로 보기
- **장보기**: 모든 장보기 항목을 한곳에서 체크하고, 체크한 항목은 한 번에 지우기
- **실시간 동기화**: 한 기기에서 고치면 다른 기기 화면에 바로 반영
- **앱처럼 설치**: 휴대폰/태블릿에서 "홈 화면에 추가"하면 앱처럼 실행됩니다. 오프라인일 때 쓴 메모는 연결되면 자동 저장
- API 키가 없으면 키워드 규칙으로 분류합니다 (정확도는 떨어짐)

## 실행

### Docker (권장)

```bash
cp .env.example .env   # 비밀번호와 ANTHROPIC_API_KEY 입력
docker compose up -d --build
```

### 직접 실행

```bash
pip install -r requirements.txt
cd server
MEMO_PASSWORD=비밀번호 ANTHROPIC_API_KEY=sk-ant-... uvicorn app:app --host 0.0.0.0 --port 8000
```

브라우저에서 `http://서버주소:8000` 접속. 데이터는 `data/memo.db`(SQLite) 하나에 저장되니 이 파일만 백업하면 됩니다.

## 여러 기기에서 접속하려면

- **집 안에서만**: 서버 PC의 내부 IP(예: `http://192.168.0.10:8000`)로 접속
- **밖에서도**: 클라우드 VPS(AWS Lightsail, Oracle Cloud 무료 등)에 올리거나, 집 PC에 [Tailscale](https://tailscale.com)을 설치해 기기끼리 연결
- 인터넷에 공개할 땐 반드시 `MEMO_PASSWORD`를 설정하고 HTTPS(Caddy, Cloudflare Tunnel 등)를 앞에 두세요. 휴대폰 "홈 화면에 추가"도 HTTPS여야 제대로 동작합니다

## 설정 (환경변수)

| 이름 | 설명 | 기본값 |
|---|---|---|
| `MEMO_PASSWORD` | 로그인 비밀번호. 비우면 로그인 없이 접속 | 없음 |
| `ANTHROPIC_API_KEY` | Claude API 키 ([발급](https://console.anthropic.com)) | 없음 → 규칙 기반 |
| `MEMO_MODEL` | 분류에 쓸 Claude 모델 | `claude-opus-5-5` |
| `MEMO_TZ` | "오늘/내일" 계산 기준 시간대 | `Asia/Seoul` |
| `MEMO_DB` | DB 파일 경로 | `data/memo.db` |

AI 호출은 메모를 저장하거나 수정할 때만 한 번씩 합니다. 비용을 더 줄이려면 `MEMO_MODEL=claude-haiku-5-5`로 바꾸세요.

## 구조

```
server/app.py         FastAPI 서버: REST API, SSE 실시간 동기화, 로그인
server/classifier.py  Claude 분류(구조화 출력) + 규칙 기반 대체 분류
web/                  웹앱(PWA): 바닐라 JS, 빌드 과정 없음
```
