"""AI 메모 서버: 메모 저장·동기화 API + 웹앱 제공."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import threading
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import classifier

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("memo")

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DB_PATH = Path(os.getenv("MEMO_DB", ROOT / "data" / "memo.db"))
TZ = ZoneInfo(os.getenv("MEMO_TZ", "Asia/Seoul"))
PASSWORD = os.getenv("MEMO_PASSWORD", "")
SECRET = os.getenv("MEMO_SECRET", PASSWORD or "dev")


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
    done INTEGER NOT NULL DEFAULT 0,
    classified_by TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    quantity TEXT,
    checked INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_due ON notes(due_date);
CREATE INDEX IF NOT EXISTS idx_items_note ON items(note_id);
-- 수정될 때마다 rev 증가: 기기들이 오래된 응답으로 최신 상태를 덮어쓰지 않게 함
CREATE TRIGGER IF NOT EXISTS notes_rev AFTER UPDATE ON notes BEGIN
    UPDATE notes SET rev = OLD.rev + 1 WHERE id = NEW.id;
END;
""")
# 이전 버전에서 만든 DB에 새 컬럼 추가
if "due_locked" not in {r["name"] for r in _db.execute("PRAGMA table_info(notes)")}:
    _db.execute("ALTER TABLE notes ADD COLUMN due_locked INTEGER NOT NULL DEFAULT 0")
    _db.commit()


def now() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def query(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return _db.execute(sql, args).fetchall()


def execute(sql: str, args: tuple = ()) -> int:
    with _lock:
        cur = _db.execute(sql, args)
        _db.commit()
        return cur.lastrowid


def note_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d["tags"])
    d["done"] = bool(d["done"])
    d["category_locked"] = bool(d["category_locked"])
    d["items"] = [
        {"id": r["id"], "name": r["name"], "quantity": r["quantity"], "checked": bool(r["checked"])}
        for r in query("SELECT * FROM items WHERE note_id=? ORDER BY position, id", (d["id"],))
    ]
    return d


def get_note(note_id: int) -> dict:
    rows = query("SELECT * FROM notes WHERE id=?", (note_id,))
    if not rows:
        raise HTTPException(404, "메모가 없습니다")
    return note_dict(rows[0])


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
    if not hmac.compare_digest(token, make_token()):
        raise HTTPException(401, "로그인이 필요합니다")


# ---------------------------------------------------------------- AI 분류 (백그라운드)

async def classify_note(note_id: int) -> None:
    rows = query("SELECT content FROM notes WHERE id=?", (note_id,))
    if not rows:
        return
    result, method = await classifier.classify(rows[0]["content"], datetime.now(TZ).date())
    with _lock:
        # AI 응답을 기다리는 동안 사용자가 직접 고친 분류·날짜는 그대로 둔다
        cur = _db.execute(
            "SELECT category, category_locked, due_date, due_time, due_locked FROM notes WHERE id=?",
            (note_id,)).fetchone()
        if cur is None:
            return
        category = cur["category"] if cur["category_locked"] else result.category
        due_date, due_time = ((cur["due_date"], cur["due_time"]) if cur["due_locked"]
                              else (result.due_date, result.due_time))
        _db.execute(
            "UPDATE notes SET title=?, category=?, tags=?, due_date=?, due_time=?, classified_by=?, updated_at=? WHERE id=?",
            (result.title, category, json.dumps(result.tags, ensure_ascii=False),
             due_date, due_time, method, now(), note_id),
        )
        # 체크 상태는 이름이 같은 항목끼리 유지
        checked = {r["name"] for r in _db.execute(
            "SELECT name FROM items WHERE note_id=? AND checked=1", (note_id,))}
        _db.execute("DELETE FROM items WHERE note_id=?", (note_id,))
        for i, it in enumerate(result.items):
            _db.execute(
                "INSERT INTO items (note_id, name, quantity, checked, position) VALUES (?,?,?,?,?)",
                (note_id, it.name, it.quantity, int(it.name in checked), i),
            )
        _db.commit()
    broadcast("note", get_note(note_id))


_tasks: set[asyncio.Task] = set()


def schedule_classification(note_id: int) -> None:
    task = asyncio.get_running_loop().create_task(classify_note(note_id))
    _tasks.add(task)  # 작업이 끝나기 전에 GC 되지 않도록 참조 유지
    task.add_done_callback(_tasks.discard)


# ---------------------------------------------------------------- 앱

@asynccontextmanager
async def lifespan(_: FastAPI):
    if not PASSWORD:
        log.warning("MEMO_PASSWORD 가 설정되지 않아 누구나 접속할 수 있습니다. 외부 공개 시 반드시 설정하세요.")
    log.info("AI 분류: %s", f"사용 ({classifier.MODEL})" if classifier.ai_enabled() else "꺼짐 (ANTHROPIC_API_KEY 없음 → 규칙 기반)")
    # 분류가 끝나지 않은 메모(서버 재시작 등) 다시 처리
    for r in query("SELECT id FROM notes WHERE category='pending'"):
        schedule_classification(r["id"])
    yield


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
    due_date: Optional[str] = None
    due_time: Optional[str] = None
    clear_due: Optional[bool] = None


class ItemPatch(BaseModel):
    checked: bool


@app.get("/api/config")
async def config():
    return {"auth_required": bool(PASSWORD), "ai": classifier.ai_enabled(), "categories": classifier.CATEGORY_LABELS}


@app.post("/api/login")
async def login(body: LoginIn):
    if not PASSWORD:
        return {"token": ""}
    if not hmac.compare_digest(body.password, PASSWORD):
        raise HTTPException(401, "비밀번호가 틀렸습니다")
    return {"token": make_token()}


@app.get("/api/notes", dependencies=auth)
async def list_notes(category: Optional[str] = None, q: Optional[str] = None):
    sql, args = "SELECT * FROM notes WHERE 1=1", []
    if category:
        sql += " AND category=?"
        args.append(category)
    if q:
        sql += " AND (content LIKE ? OR title LIKE ? OR tags LIKE ?)"
        args += [f"%{q}%"] * 3
    sql += " ORDER BY created_at DESC, id DESC"
    return [note_dict(r) for r in query(sql, tuple(args))]


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
    get_note(note_id)
    sets, args = [], []
    if body.content is not None:
        if not body.content.strip():
            raise HTTPException(400, "내용을 입력하세요")
        sets.append("content=?")
        args.append(body.content.strip())
    if body.category is not None:
        if body.category not in classifier.CATEGORY_LABELS:
            raise HTTPException(400, "알 수 없는 분류")
        sets += ["category=?", "category_locked=1"]
        args.append(body.category)
    if body.done is not None:
        sets.append("done=?")
        args.append(int(body.done))
    if body.clear_due:
        sets += ["due_date=NULL", "due_time=NULL", "due_locked=1"]
    elif body.due_date is not None or body.due_time is not None:
        sets.append("due_locked=1")  # 직접 정한 날짜는 AI가 덮어쓰지 않음
        if body.due_date is not None:
            sets.append("due_date=?")
            args.append(body.due_date or None)
        if body.due_time is not None:
            sets.append("due_time=?")
            args.append(body.due_time or None)
    if sets:
        sets.append("updated_at=?")
        args.append(now())
        execute(f"UPDATE notes SET {', '.join(sets)} WHERE id=?", (*args, note_id))
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
    get_note(note_id)
    execute("DELETE FROM notes WHERE id=?", (note_id,))
    broadcast("delete", {"id": note_id})
    return {"ok": True}


@app.patch("/api/items/{item_id}", dependencies=auth)
async def update_item(item_id: int, body: ItemPatch):
    rows = query("SELECT note_id FROM items WHERE id=?", (item_id,))
    if not rows:
        raise HTTPException(404, "항목이 없습니다")
    execute("UPDATE items SET checked=? WHERE id=?", (int(body.checked), item_id))
    note_id = rows[0]["note_id"]
    execute("UPDATE notes SET updated_at=? WHERE id=?", (now(), note_id))
    note = get_note(note_id)
    broadcast("note", note)
    return note


@app.post("/api/shopping/clear-checked", dependencies=auth)
async def clear_checked():
    """체크된 장보기 항목 삭제. 항목이 모두 사라진 장보기 메모는 완료 처리."""
    note_ids = [r["note_id"] for r in query("SELECT DISTINCT note_id FROM items WHERE checked=1")]
    execute("DELETE FROM items WHERE checked=1")
    for nid in note_ids:
        if not query("SELECT 1 FROM items WHERE note_id=?", (nid,)):
            execute("UPDATE notes SET done=1, updated_at=? WHERE id=?", (now(), nid))
        broadcast("note", get_note(nid))
    return {"ok": True}


@app.get("/api/events", dependencies=auth)
async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)

    async def stream():
        try:
            yield "event: hello\ndata: {}\n\n"
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
