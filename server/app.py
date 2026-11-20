"""AI 메모 서버: 메모 저장·동기화 API, 알림, 백업 + 웹앱 제공."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import classifier
import recurrence
import reminders

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("memo")


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, "") or default))
    except ValueError:
        return default


ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DB_PATH = Path(os.getenv("MEMO_DB", ROOT / "data" / "memo.db")).expanduser()
BACKUP_DIR = Path(os.getenv("MEMO_BACKUP_DIR", "") or DB_PATH.parent / "backups").expanduser()
BACKUP_KEEP = _env_int("MEMO_BACKUP_KEEP", 14)
TRASH_DAYS = 30
TZ = ZoneInfo(os.getenv("MEMO_TZ", "Asia/Seoul"))
PASSWORD = os.getenv("MEMO_PASSWORD", "")
SECRET = os.getenv("MEMO_SECRET", PASSWORD or "dev")
# 웹 푸시 서비스에 알리는 서버 운영자 연락처 (mailto: 또는 https: 주소)
CONTACT = os.getenv("MEMO_CONTACT", "mailto:admin@example.com")
TIME_RE = re.compile(r"([01]\d|2[0-3]):[0-5]\d")


# ---------------------------------------------------------------- DB

DB_PATH.parent.mkdir(parents=True, exist_ok=True)
_db = sqlite3.connect(DB_PATH, check_same_thread=False)
_db.row_factory = sqlite3.Row
_db.execute("PRAGMA journal_mode=WAL")
_db.execute("PRAGMA foreign_keys=ON")
_lock = threading.Lock()
_db.executescript("""
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'pending',
    category_locked INTEGER NOT NULL DEFAULT 0,
    due_locked INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    due_date TEXT,
    due_time TEXT,
    repeat TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    classified_by TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    quantity TEXT,
    section TEXT,
    checked INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders_sent (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notes_due ON notes(due_date);
CREATE INDEX IF NOT EXISTS idx_items_note ON items(note_id);
-- 수정될 때마다 rev 증가: 기기들이 오래된 응답으로 최신 상태를 덮어쓰지 않게 함
CREATE TRIGGER IF NOT EXISTS notes_rev AFTER UPDATE ON notes BEGIN
    UPDATE notes SET rev = OLD.rev + 1 WHERE id = NEW.id;
END;
""")
# 이전 버전에서 만든 DB 에 새 컬럼 추가
for _table, _column, _ddl in (
    ("notes", "due_locked", "INTEGER NOT NULL DEFAULT 0"),
    ("notes", "repeat", "TEXT"),
    ("notes", "pinned", "INTEGER NOT NULL DEFAULT 0"),
    ("notes", "deleted_at", "TEXT"),
    ("items", "section", "TEXT"),
    ("reminders_sent", "title", "TEXT"),
    ("reminders_sent", "body", "TEXT"),
    ("reminders_sent", "tag", "TEXT"),
):
    if _column not in {r["name"] for r in _db.execute(f"PRAGMA table_info({_table})")}:
        _db.execute(f"ALTER TABLE {_table} ADD COLUMN {_column} {_ddl}")
for _r in _db.execute("SELECT id, name FROM items WHERE section IS NULL").fetchall():
    _db.execute("UPDATE items SET section=? WHERE id=?", (classifier.guess_section(_r["name"]), _r["id"]))
_db.commit()


def now() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def today() -> date:
    return datetime.now(TZ).date()


def query(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return _db.execute(sql, args).fetchall()


def execute(sql: str, args: tuple = ()) -> int:
    with _lock:
        cur = _db.execute(sql, args)
        _db.commit()
        return cur.lastrowid


def parse_date(value) -> Optional[date]:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def load_rule(text) -> Optional[dict]:
    try:
        return recurrence.clean(json.loads(text)) if text else None
    except (ValueError, TypeError):
        return None


def items_by_note(note_id: Optional[int] = None) -> dict[int, list[dict]]:
    sql, args = "SELECT * FROM items", ()
    if note_id is not None:
        sql, args = sql + " WHERE note_id=?", (note_id,)
    out: dict[int, list[dict]] = {}
    for r in query(sql + " ORDER BY position, id", args):
        out.setdefault(r["note_id"], []).append({
            "id": r["id"], "name": r["name"], "quantity": r["quantity"],
            "section": r["section"] or "기타", "checked": bool(r["checked"]),
        })
    return out


def note_dict(row: sqlite3.Row, items: Optional[list] = None) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d["tags"] or "[]")
    d["repeat"] = load_rule(d["repeat"])
    for key in ("done", "category_locked", "due_locked", "pinned"):
        d[key] = bool(d[key])
    d["items"] = items if items is not None else items_by_note(d["id"]).get(d["id"], [])
    return d


def get_note(note_id: int, deleted: bool = False) -> dict:
    rows = query(f"SELECT * FROM notes WHERE id=? AND deleted_at IS {'NOT ' if deleted else ''}NULL", (note_id,))
    if not rows:
        raise HTTPException(404, "메모가 없습니다")
    return note_dict(rows[0])


def touch(note_id: int) -> None:
    """메모의 수정 시각(과 rev)을 올린다. 항목만 바뀌었을 때 쓴다."""
    execute("UPDATE notes SET updated_at=? WHERE id=?", (now(), note_id))


# ---------------------------------------------------------------- 실시간 동기화 (SSE)

_subscribers: set[asyncio.Queue] = set()


def broadcast(event: str, payload: dict) -> None:
    msg = f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
    for q in list(_subscribers):
        q.put_nowait(msg)


# ---------------------------------------------------------------- 인증

def make_token() -> str:
    return hmac.new(SECRET.encode(), b"ai-memo-v1", hashlib.sha256).hexdigest()


def require_auth(request: Request) -> None:
    if not PASSWORD:
        return
    header = request.headers.get("authorization", "")
    token = header.removeprefix("Bearer ").strip() or request.query_params.get("token", "")
    if not hmac.compare_digest(token.encode(), make_token().encode()):
        raise HTTPException(401, "로그인이 필요합니다")


def client_ip(request: Request) -> str:
    """접속한 기기의 주소. 같은 휴대폰의 터널(cloudflared 등)을 거쳐 온 요청이면 원래 주소를 쓴다."""
    ip = request.client.host if request.client else "?"
    if ip in ("127.0.0.1", "::1"):
        forwarded = (request.headers.get("cf-connecting-ip")
                     or request.headers.get("x-forwarded-for", "").split(",")[0].strip())
        if forwarded:
            return forwarded
    return ip


# 비밀번호 무차별 대입 막기: 10분 안에 5번 틀리면 5분 동안 잠금
LOGIN_MAX_FAILS, LOGIN_WINDOW, LOGIN_LOCK = 5, 600, 300
_login_fails: dict[str, list[float]] = {}


# ---------------------------------------------------------------- AI 분류 (백그라운드)

async def classify_note(note_id: int) -> None:
    rows = query("SELECT content FROM notes WHERE id=? AND deleted_at IS NULL", (note_id,))
    if not rows:
        return
    day = today()
    result, method = await classifier.classify(rows[0]["content"], day)
    rule, due = recurrence.normalize(result.repeat.model_dump() if result.repeat else None,
                                     parse_date(result.due_date), day)
    with _lock:
        # AI 응답을 기다리는 동안 사용자가 직접 고친 분류·날짜는 그대로 둔다
        cur = _db.execute(
            "SELECT category, category_locked, due_date, due_time, repeat, due_locked FROM notes WHERE id=?",
            (note_id,)).fetchone()
        if cur is None:
            return
        category = cur["category"] if cur["category_locked"] else result.category
        if cur["due_locked"]:
            due_date, due_time, repeat = cur["due_date"], cur["due_time"], cur["repeat"]
        else:
            due_date, due_time = (due.isoformat() if due else None), result.due_time
            repeat = json.dumps(rule) if rule else None
        _db.execute(
            "UPDATE notes SET title=?, category=?, tags=?, due_date=?, due_time=?, repeat=?, classified_by=?, "
            "updated_at=? WHERE id=?",
            (result.title, category, json.dumps(result.tags, ensure_ascii=False), due_date, due_time, repeat,
             method, now(), note_id),
        )
        # 체크 상태는 이름이 같은 항목끼리 유지
        checked = {r["name"] for r in _db.execute(
            "SELECT name FROM items WHERE note_id=? AND checked=1", (note_id,))}
        _db.execute("DELETE FROM items WHERE note_id=?", (note_id,))
        for i, it in enumerate(result.items):
            _db.execute(
                "INSERT INTO items (note_id, name, quantity, section, checked, position) VALUES (?,?,?,?,?,?)",
                (note_id, it.name.strip(), it.quantity, it.section, int(it.name in checked), i),
            )
        _db.commit()
    try:
        broadcast("note", get_note(note_id))
    except HTTPException:  # 그 사이 삭제됨
        pass


_tasks: set[asyncio.Task] = set()


def schedule_classification(note_id: int) -> None:
    task = asyncio.get_running_loop().create_task(classify_note(note_id))
    _tasks.add(task)  # 작업이 끝나기 전에 GC 되지 않도록 참조 유지
    task.add_done_callback(_tasks.discard)


# ---------------------------------------------------------------- 알림

def get_settings() -> dict:
    s = dict(reminders.DEFAULTS)
    s.update({r["key"]: r["value"] for r in query("SELECT key, value FROM settings") if r["key"] in s})
    return s


def save_settings(values: dict) -> None:
    for key, value in values.items():
        if key not in reminders.DEFAULTS or value is None:
            continue
        value = str(value).strip()
        ok = (value == "" or (value.isdigit() and int(value) <= 1440) if key == "lead"
              else value == "" or TIME_RE.fullmatch(value))
        if not ok:
            raise HTTPException(400, "잘못된 설정값")
        execute("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value))


_vapid: Optional["reminders.Vapid"] = None


def get_vapid() -> Optional["reminders.Vapid"]:
    """웹 푸시용 서버 키. 처음 한 번 만들어 DB에 보관한다."""
    global _vapid
    if _vapid is None and reminders.HAVE_CRYPTO:
        rows = query("SELECT value FROM settings WHERE key='vapid_private'")
        _vapid = reminders.Vapid(rows[0]["value"] if rows else None)
        if not rows:
            execute("INSERT INTO settings (key, value) VALUES ('vapid_private', ?)", (_vapid.private_b64,))
    return _vapid


async def deliver(rem: reminders.Reminder, sent_at: Optional[str] = None) -> int:
    """알림 하나를 모든 경로로 보낸다. 웹 푸시가 전달된 기기 수를 돌려준다."""
    log.info("알림: %s", rem.title)
    payload = {"title": rem.title, "body": rem.body, "tag": rem.tag, "key": rem.key, "sent_at": sent_at or now()}
    broadcast("reminder", payload)  # 앱을 열어 둔 기기에는 화면 안에서 표시
    delivered = 0
    subs = [dict(r) for r in query("SELECT * FROM push_subs")]
    vapid = get_vapid()
    if subs and vapid:
        data = json.dumps(payload, ensure_ascii=False).encode()
        results = await asyncio.gather(
            *(asyncio.to_thread(reminders.send_web_push, s, data, vapid, CONTACT) for s in subs),
            return_exceptions=True)
        for sub, res in zip(subs, results):
            if res in (404, 410):  # 기기에서 알림을 껐거나 구독이 만료됨
                execute("DELETE FROM push_subs WHERE endpoint=?", (sub["endpoint"],))
            elif isinstance(res, Exception) or res >= 400:
                log.warning("웹 푸시 실패 (%s): %s", sub["endpoint"][:60], res)
            else:
                delivered += 1
    await asyncio.to_thread(reminders.send_local, rem)
    return delivered


async def check_reminders() -> None:
    notes = [dict(r) for r in query(
        "SELECT id, title, due_date, due_time FROM notes "
        "WHERE done=0 AND due_date IS NOT NULL AND deleted_at IS NULL")]
    for rem in reminders.due_reminders(notes, datetime.now(TZ), get_settings()):
        if query("SELECT 1 FROM reminders_sent WHERE key=?", (rem.key,)):
            continue
        sent_at = now()
        execute("INSERT INTO reminders_sent (key, sent_at, title, body, tag) VALUES (?,?,?,?,?)",
                (rem.key, sent_at, rem.title, rem.body, rem.tag))
        await deliver(rem, sent_at)


# ---------------------------------------------------------------- 백업·정리

def backup_files() -> list[Path]:
    return sorted(BACKUP_DIR.glob("memo-*.db")) if BACKUP_DIR.is_dir() else []


def make_backup(force: bool = False) -> Optional[Path]:
    """오늘 날짜 백업 파일을 만든다 (하루 한 번). 오래된 백업은 BACKUP_KEEP 개만 남긴다."""
    target = BACKUP_DIR / f"memo-{today().isoformat()}.db"
    if target.exists() and not force:
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    dst = sqlite3.connect(tmp)
    try:
        with _lock:
            _db.backup(dst)  # 서버가 도는 중에도 안전하게 복사
    finally:
        dst.close()
    os.replace(tmp, target)
    for old in backup_files()[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)
    return target


_maintained: Optional[date] = None


async def daily_maintenance() -> None:
    """하루 한 번: 자동 백업, 30일 지난 휴지통·알림 기록 비우기."""
    global _maintained
    if _maintained == today():
        return
    _maintained = today()
    cutoff = (datetime.now(TZ) - timedelta(days=TRASH_DAYS)).isoformat(timespec="seconds")
    execute("DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))
    execute("DELETE FROM reminders_sent WHERE sent_at < ?",
            ((datetime.now(TZ) - timedelta(days=60)).isoformat(timespec="seconds"),))
    try:
        path = await asyncio.to_thread(make_backup)
        if path:
            log.info("자동 백업: %s", path)
    except Exception as e:
        log.warning("자동 백업 실패 (%s): %s", BACKUP_DIR, e)


async def background_loop() -> None:
    while True:
        try:
            await daily_maintenance()
            await check_reminders()
        except Exception:
            log.exception("백그라운드 작업 중 오류")
        await asyncio.sleep(30)


# ---------------------------------------------------------------- 앱

@asynccontextmanager
async def lifespan(_: FastAPI):
    if not PASSWORD:
        log.warning("MEMO_PASSWORD 가 설정되지 않아 누구나 접속할 수 있습니다. 외부 공개 시 반드시 설정하세요.")
    if classifier.ai_enabled():
        log.info("AI 분류: 사용 (%s)", classifier.MODEL)
    elif classifier.anthropic is None:
        log.info("AI 분류: 꺼짐 (anthropic 패키지가 설치되지 않음 → 키워드 규칙으로 분류)")
    else:
        log.info("AI 분류: 꺼짐 (ANTHROPIC_API_KEY 없음 → 키워드 규칙으로 분류)")
    log.info("웹 푸시: %s", "사용" if get_vapid() else "꺼짐 (cryptography 패키지 없음)")
    log.info("자동 백업 위치: %s (최근 %d개 보관)", BACKUP_DIR, BACKUP_KEEP)
    # 분류가 끝나지 않은 메모(서버 재시작 등) 다시 처리
    for r in query("SELECT id FROM notes WHERE category='pending' AND deleted_at IS NULL"):
        schedule_classification(r["id"])
    loop_task = asyncio.create_task(background_loop())
    yield
    loop_task.cancel()
    for task in list(_tasks):
        task.cancel()
    with _lock:
        _db.close()  # 쓰기 로그(-wal)를 DB 파일에 합쳐 두어 백업·복구가 안전하도록


app = FastAPI(title="AI 메모", lifespan=lifespan)
auth = [Depends(require_auth)]


class LoginIn(BaseModel):
    password: str


class NoteIn(BaseModel):
    content: str


class NotePatch(BaseModel):
    content: Optional[str] = None
    category: Optional[str] = None
    done: Optional[bool] = None
    pinned: Optional[bool] = None
    due_date: Optional[str] = None
    due_time: Optional[str] = None
    clear_due: Optional[bool] = None
    repeat: Optional[dict] = None  # null 을 보내면 반복 해제


class ItemPatch(BaseModel):
    checked: bool


class SettingsIn(BaseModel):
    morning: Optional[str] = None
    evening: Optional[str] = None
    lead: Optional[str] = None


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubIn(BaseModel):
    endpoint: str
    keys: PushKeys


class PushUnsubIn(BaseModel):
    endpoint: str


class ImportIn(BaseModel):
    notes: list[dict]
    settings: Optional[dict] = None


@app.get("/api/config")
async def config():
    return {"auth_required": bool(PASSWORD), "ai": classifier.ai_enabled(), "categories": classifier.CATEGORY_LABELS,
            "sections": classifier.SECTIONS, "push": get_vapid() is not None}


@app.post("/api/login")
async def login(body: LoginIn, request: Request):
    if not PASSWORD:
        return {"token": ""}
    ip = client_ip(request)
    t = time.monotonic()
    for key in [k for k, v in _login_fails.items() if t - v[-1] > LOGIN_WINDOW]:
        del _login_fails[key]
    fails = [f for f in _login_fails.get(ip, []) if t - f < LOGIN_WINDOW]
    if len(fails) >= LOGIN_MAX_FAILS and t - fails[-1] < LOGIN_LOCK:
        wait = math.ceil((LOGIN_LOCK - (t - fails[-1])) / 60)
        raise HTTPException(429, f"비밀번호를 여러 번 틀렸습니다. {wait}분 뒤에 다시 시도하세요")
    if not hmac.compare_digest(body.password.encode(), PASSWORD.encode()):
        _login_fails[ip] = fails + [t]
        await asyncio.sleep(1)
        raise HTTPException(401, "비밀번호가 틀렸습니다")
    _login_fails.pop(ip, None)
    return {"token": make_token()}


@app.get("/api/notes", dependencies=auth)
async def list_notes():
    items = items_by_note()
    rows = query("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC")
    return [note_dict(r, items.get(r["id"], [])) for r in rows]


@app.post("/api/notes", dependencies=auth, status_code=201)
async def create_note(body: NoteIn):
    content = body.content.strip()
    if not content:
        raise HTTPException(400, "내용을 입력하세요")
    ts = now()
    note_id = execute(
        "INSERT INTO notes (content, title, created_at, updated_at) VALUES (?,?,?,?)",
        (content, content.splitlines()[0][:40], ts, ts),
    )
    note = get_note(note_id)
    broadcast("note", note)
    schedule_classification(note_id)
    return note


@app.patch("/api/notes/{note_id}", dependencies=auth)
async def update_note(note_id: int, body: NotePatch):
    note = get_note(note_id)
    day = today()
    sets: dict[str, object] = {}
    if body.content is not None:
        content = body.content.strip()
        if not content:
            raise HTTPException(400, "내용을 입력하세요")
        sets["content"] = content
    if body.category is not None:
        if body.category not in classifier.CATEGORY_LABELS:
            raise HTTPException(400, "알 수 없는 분류")
        sets.update(category=body.category, category_locked=1)
    if body.pinned is not None:
        sets["pinned"] = int(body.pinned)

    # 날짜·시간·반복. 하나라도 직접 바꾸면 이후 AI 재분류가 덮어쓰지 않는다 (due_locked).
    due, due_time, rule = parse_date(note["due_date"]), note["due_time"], note["repeat"]
    schedule = False
    if body.clear_due:
        due = due_time = rule = None
        schedule = True
    else:
        if body.due_date is not None:
            if body.due_date and not parse_date(body.due_date):
                raise HTTPException(400, "날짜 형식은 YYYY-MM-DD 입니다")
            due, schedule = parse_date(body.due_date), True
        if body.due_time is not None:
            if body.due_time and not TIME_RE.fullmatch(body.due_time):
                raise HTTPException(400, "시간 형식은 HH:MM 입니다")
            due_time, schedule = body.due_time or None, True
        if "repeat" in body.model_fields_set:
            schedule = True
            rule = recurrence.clean(body.repeat)
            if rule:
                due = due or day
                if len(rule.get("weekdays", [])) > 1:  # 월·수·금처럼 여러 요일이면 그중 첫 날로
                    due = recurrence.first_on_or_after(rule, due)
                rule = recurrence.anchor(rule, due)
    if due is None:
        rule = None  # 반복에는 날짜가 필요
    if body.done is not None:
        if body.done and rule and due:
            due, schedule = recurrence.after_done(rule, due, day), True  # 반복 일정은 다음 회차로
            sets["done"] = 0
        else:
            sets["done"] = int(body.done)
    if schedule:
        sets.update(due_date=due.isoformat() if due else None, due_time=due_time,
                    repeat=json.dumps(rule) if rule else None, due_locked=1)
    if sets:
        sets["updated_at"] = now()
        execute(f"UPDATE notes SET {', '.join(f'{k}=?' for k in sets)} WHERE id=?", (*sets.values(), note_id))
    note = get_note(note_id)
    broadcast("note", note)
    if body.content is not None:
        schedule_classification(note_id)  # 내용이 바뀌면 다시 분류
    return note


@app.post("/api/notes/{note_id}/reclassify", dependencies=auth)
async def reclassify(note_id: int):
    get_note(note_id)
    execute("UPDATE notes SET category_locked=0, due_locked=0 WHERE id=?", (note_id,))
    schedule_classification(note_id)
    return {"ok": True}


@app.delete("/api/notes/{note_id}", dependencies=auth)
async def delete_note(note_id: int):
    """휴지통으로 옮긴다 (30일 뒤 영구 삭제)."""
    get_note(note_id)
    ts = now()
    execute("UPDATE notes SET deleted_at=?, updated_at=? WHERE id=?", (ts, ts, note_id))
    broadcast("delete", {"id": note_id})
    return {"ok": True}


@app.post("/api/notes/{note_id}/restore", dependencies=auth)
async def restore_note(note_id: int):
    get_note(note_id, deleted=True)
    execute("UPDATE notes SET deleted_at=NULL, updated_at=? WHERE id=?", (now(), note_id))
    note = get_note(note_id)
    broadcast("note", note)
    return note


@app.get("/api/trash", dependencies=auth)
async def list_trash():
    return [note_dict(r) for r in query("SELECT * FROM notes WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC")]


@app.delete("/api/trash", dependencies=auth)
async def empty_trash():
    execute("DELETE FROM notes WHERE deleted_at IS NOT NULL")
    return {"ok": True}


@app.patch("/api/items/{item_id}", dependencies=auth)
async def update_item(item_id: int, body: ItemPatch):
    rows = query("SELECT i.note_id FROM items i JOIN notes n ON n.id = i.note_id "
                 "WHERE i.id=? AND n.deleted_at IS NULL", (item_id,))
    if not rows:
        raise HTTPException(404, "항목이 없습니다")
    execute("UPDATE items SET checked=? WHERE id=?", (int(body.checked), item_id))
    note_id = rows[0]["note_id"]
    touch(note_id)
    note = get_note(note_id)
    broadcast("note", note)
    return note


@app.post("/api/shopping/clear-checked", dependencies=auth)
async def clear_checked():
    """체크된 장보기 항목 삭제. 항목이 모두 사라진 메모는 완료 처리.
    반복하는 장보기 목록은 지우지 않고 체크만 풀어 다음에 다시 쓴다."""
    rows = query("SELECT DISTINCT i.note_id, n.repeat FROM items i JOIN notes n ON n.id = i.note_id "
                 "WHERE i.checked=1 AND n.deleted_at IS NULL")
    for r in rows:
        nid = r["note_id"]
        if r["repeat"]:
            execute("UPDATE items SET checked=0 WHERE note_id=?", (nid,))
        else:
            execute("DELETE FROM items WHERE note_id=? AND checked=1", (nid,))
            if not query("SELECT 1 FROM items WHERE note_id=?", (nid,)):
                execute("UPDATE notes SET done=1 WHERE id=?", (nid,))
        touch(nid)
        broadcast("note", get_note(nid))
    return {"ok": True}


@app.get("/api/reminders", dependencies=auth)
async def recent_reminders(since: str = ""):
    """since(보낸 시각) 이후의 알림. 앱이 연결이 끊겼던 동안 놓친 알림을 다시 띄우는 데 쓴다 (최근 12시간까지)."""
    floor = (datetime.now(TZ) - timedelta(hours=12)).isoformat(timespec="seconds")
    rows = query("SELECT key, title, body, tag, sent_at FROM reminders_sent "
                 "WHERE sent_at >= ? AND title IS NOT NULL ORDER BY sent_at, key LIMIT 30", (max(since, floor),))
    return [dict(r) for r in rows]


@app.get("/api/settings", dependencies=auth)
async def read_settings():
    return get_settings()


@app.put("/api/settings", dependencies=auth)
async def write_settings(body: SettingsIn):
    save_settings(body.model_dump(exclude_none=True))
    settings = get_settings()
    broadcast("settings", settings)
    return settings


@app.get("/api/push/key", dependencies=auth)
async def push_key():
    vapid = get_vapid()
    if vapid is None:
        raise HTTPException(501, "서버에 cryptography 패키지가 없어 웹 푸시를 쓸 수 없습니다")
    return {"key": vapid.public_b64}


@app.post("/api/push/subscribe", dependencies=auth)
async def push_subscribe(body: PushSubIn):
    if not body.endpoint.startswith("https://"):
        raise HTTPException(400, "잘못된 구독 정보")
    execute(
        "INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?) "
        "ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth",
        (body.endpoint, body.keys.p256dh, body.keys.auth, now()))
    return {"ok": True}


@app.post("/api/push/unsubscribe", dependencies=auth)
async def push_unsubscribe(body: PushUnsubIn):
    execute("DELETE FROM push_subs WHERE endpoint=?", (body.endpoint,))
    return {"ok": True}


@app.post("/api/push/test", dependencies=auth)
async def push_test():
    delivered = await deliver(reminders.Reminder(
        key=f"test:{now()}", title="AI 메모 알림 테스트", body="이 알림이 보이면 잘 설정된 것입니다.", tag="test"))
    return {"devices": delivered}


# ---------------------------------------------------------------- 백업·내보내기·가져오기

def data_info() -> dict:
    files = backup_files()
    last = datetime.fromtimestamp(files[-1].stat().st_mtime, TZ).isoformat(timespec="seconds") if files else None
    trash = query("SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NOT NULL")[0]["n"]
    return {"backup_dir": str(BACKUP_DIR), "backup_keep": BACKUP_KEEP, "backups": len(files),
            "last_backup": last, "trash": trash, "trash_days": TRASH_DAYS}


@app.get("/api/data", dependencies=auth)
async def read_data_info():
    return data_info()


@app.post("/api/backup", dependencies=auth)
async def backup_now():
    try:
        await asyncio.to_thread(make_backup, True)
    except OSError as e:
        raise HTTPException(500, f"백업하지 못했습니다: {e}")
    return data_info()


EXPORT_FIELDS = ("content", "title", "category", "category_locked", "due_locked", "tags", "due_date", "due_time",
                 "repeat", "done", "pinned", "created_at", "updated_at")


@app.get("/api/export", dependencies=auth)
async def export_data():
    items = items_by_note()
    notes = []
    for r in query("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at, id"):
        d = note_dict(r, items.get(r["id"], []))
        notes.append({k: d[k] for k in EXPORT_FIELDS} | {
            "items": [{k: i[k] for k in ("name", "quantity", "section", "checked")} for i in d["items"]]})
    data = {"app": "ai-memo", "version": 2, "exported_at": now(), "settings": get_settings(), "notes": notes}
    name = f"ai-memo-{today().isoformat()}.json"
    return Response(json.dumps(data, ensure_ascii=False, indent=1), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/import", dependencies=auth)
async def import_data(body: ImportIn):
    """내보낸 파일을 가져온다. 내용과 작성 시각이 같은 메모는 이미 있는 것으로 보고 건너뛴다."""
    added = skipped = 0
    to_classify = []
    with _lock:
        for n in body.notes:
            content = str(n.get("content") or "").strip()
            created = str(n.get("created_at") or "") or now()
            if not content or _db.execute("SELECT 1 FROM notes WHERE content=? AND created_at=? AND deleted_at IS NULL",
                                          (content, created)).fetchone():
                skipped += 1
                continue
            category = n.get("category") if n.get("category") in classifier.CATEGORY_LABELS else "pending"
            due = parse_date(n.get("due_date"))
            due_time = n.get("due_time") if isinstance(n.get("due_time"), str) and TIME_RE.fullmatch(n["due_time"]) else None
            rule = recurrence.clean(n.get("repeat")) if due else None
            tags = [str(t)[:30] for t in n.get("tags") if isinstance(t, (str, int))][:10] if isinstance(n.get("tags"), list) else []
            title = str(n.get("title") or content.splitlines()[0])[:40]
            cur = _db.execute(
                "INSERT INTO notes (content, title, category, category_locked, due_locked, tags, due_date, due_time, "
                "repeat, done, pinned, classified_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (content, title, category, int(bool(n.get("category_locked"))), int(bool(n.get("due_locked"))),
                 json.dumps(tags, ensure_ascii=False), due.isoformat() if due else None, due_time,
                 json.dumps(rule) if rule else None, int(bool(n.get("done"))), int(bool(n.get("pinned"))),
                 "import", created, str(n.get("updated_at") or created)))
            items = n.get("items") if isinstance(n.get("items"), list) else []
            for i, it in enumerate(items):
                name = str(it.get("name") or "").strip() if isinstance(it, dict) else ""
                if not name:
                    continue
                section = it.get("section") if it.get("section") in classifier.SECTIONS else classifier.guess_section(name)
                _db.execute(
                    "INSERT INTO items (note_id, name, quantity, section, checked, position) VALUES (?,?,?,?,?,?)",
                    (cur.lastrowid, name[:100], str(it["quantity"])[:30] if it.get("quantity") else None, section,
                     int(bool(it.get("checked"))), i))
            added += 1
            if category == "pending":
                to_classify.append(cur.lastrowid)
        _db.commit()
    if body.settings:
        save_settings({k: v for k, v in body.settings.items() if k in reminders.DEFAULTS})
    for nid in to_classify:
        schedule_classification(nid)
    broadcast("reload", {})
    return {"added": added, "skipped": skipped}


# ---------------------------------------------------------------- 실시간 연결·화면

@app.get("/api/events", dependencies=auth)
async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)

    async def stream():
        try:
            yield f"event: hello\ndata: {json.dumps({'now': now()})}\n\n"
            while not await request.is_disconnected():
                try:
                    yield await asyncio.wait_for(q.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # 프록시가 연결을 끊지 않도록
        finally:
            _subscribers.discard(q)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/sw.js")
def service_worker():
    return FileResponse(WEB_DIR / "sw.js", media_type="application/javascript",
                        headers={"Service-Worker-Allowed": "/"})


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
