"""알림: 언제 무엇을 알릴지 계산하고(순수 함수), 여러 경로로 보낸다.

보내는 경로
- 웹 푸시: 브라우저/홈 화면 앱으로 직접 (HTTPS 접속 필요, 내용은 기기까지 암호화됨)
- Termux: 서버가 안드로이드 Termux 에서 돌면 그 휴대폰에 바로 알림
- ntfy: MEMO_NTFY_URL 을 설정한 경우에만 (ntfy 앱으로 수신)
"""
from __future__ import annotations

import base64
import json
import logging
import math
import os
import shutil
import struct
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from urllib.parse import urlsplit

log = logging.getLogger("reminders")

try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    HAVE_CRYPTO = True
except ImportError:  # 웹 푸시만 꺼지고 나머지는 동작
    HAVE_CRYPTO = False

# 설정 기본값. 빈 문자열이면 해당 알림을 끈다.
DEFAULTS = {
    "morning": "08:00",  # 아침 요약: 오늘 할 일 + 지난 일
    "evening": "20:00",  # 전날 알림: 내일 일정·마감
    "lead": "30",        # 시간이 정해진 일정을 몇 분 전에 알릴지
}
DIGEST_WINDOW = timedelta(hours=3)  # 요약 시각에 서버가 꺼져 있었다면 이 시간 안에만 뒤늦게 보냄
MAX_LINES = 5


@dataclass
class Reminder:
    key: str    # 같은 알림을 두 번 보내지 않기 위한 고유값
    title: str
    body: str
    tag: str    # 같은 tag 의 알림은 기기에서 서로 덮어씀


# ---------------------------------------------------------------- 무엇을 알릴지

def _hhmm(value: str):
    try:
        return datetime.strptime(value, "%H:%M").time()
    except (ValueError, TypeError):
        return None


def _in_words(minutes: int) -> str:
    if minutes <= 0:
        return "지금"
    if minutes < 60:
        return f"{minutes}분 뒤"
    h, m = divmod(minutes, 60)
    return f"{h}시간 {m}분 뒤" if m else f"{h}시간 뒤"


def _lines(notes: list[dict]) -> list[str]:
    notes = sorted(notes, key=lambda n: n.get("due_time") or "99:99")
    out = [f"{n['due_time']} {n['title']}" if n.get("due_time") else n["title"] for n in notes[:MAX_LINES]]
    if len(notes) > MAX_LINES:
        out.append(f"외 {len(notes) - MAX_LINES}건")
    return out


def due_reminders(notes: list[dict], now: datetime, settings: dict) -> list[Reminder]:
    """지금 보내야 할 알림 목록. notes 는 완료되지 않았고 날짜가 있는 메모들."""
    out: list[Reminder] = []
    today = now.date()
    dated: list[tuple[date, dict]] = []
    for n in notes:
        try:
            dated.append((date.fromisoformat(n["due_date"]), n))
        except (ValueError, TypeError):
            continue

    # 1) 시간이 정해진 일정: lead 분 전에 한 번
    lead_raw = str(settings.get("lead", ""))
    if lead_raw.isdigit():
        lead = int(lead_raw)
        for d, n in dated:
            t = _hhmm(n.get("due_time"))
            if t is None:
                continue
            due = datetime.combine(d, t, tzinfo=now.tzinfo)
            if due - timedelta(minutes=lead) <= now <= due + timedelta(minutes=1):
                left = math.ceil((due - now).total_seconds() / 60)
                day = "오늘" if d == today else "내일" if d == today + timedelta(days=1) else f"{d.month}월 {d.day}일"
                out.append(Reminder(
                    key=f"item:{n['id']}:{n['due_date']}T{n['due_time']}",
                    title=f"{_in_words(left)} · {n['title']}",
                    body=f"{day} {n['due_time']}",
                    tag=f"note-{n['id']}",
                ))

    # 2) 아침 요약: 오늘 할 일 + 지난 일
    t = _hhmm(settings.get("morning"))
    if t and timedelta(0) <= now - datetime.combine(today, t, tzinfo=now.tzinfo) < DIGEST_WINDOW:
        todays = [n for d, n in dated if d == today]
        overdue = [n for d, n in dated if d < today]
        if todays or overdue:
            lines = _lines(todays)
            if overdue:
                lines.append(f"지난 일 {len(overdue)}건이 남아 있어요")
            out.append(Reminder(
                key=f"morning:{today}",
                title=f"오늘 할 일 {len(todays)}건" if todays else f"지난 일 {len(overdue)}건",
                body="\n".join(lines),
                tag="digest-morning",
            ))

    # 3) 전날 알림: 내일 일정·마감
    t = _hhmm(settings.get("evening"))
    if t and timedelta(0) <= now - datetime.combine(today, t, tzinfo=now.tzinfo) < DIGEST_WINDOW:
        tomorrows = [n for d, n in dated if d == today + timedelta(days=1)]
        if tomorrows:
            out.append(Reminder(
                key=f"evening:{today}",
                title=f"내일 일정 {len(tomorrows)}건",
                body="\n".join(_lines(tomorrows)),
                tag="digest-evening",
            ))
    return out


# ---------------------------------------------------------------- 웹 푸시 (RFC 8291 + VAPID)

def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Vapid:
    """서버 신원 키. 푸시 서비스가 '이 서버가 보낸 것'임을 확인하는 데 쓴다."""

    def __init__(self, private_b64: str | None = None):
        if private_b64:
            self._key = ec.derive_private_key(int.from_bytes(_unb64(private_b64), "big"), ec.SECP256R1())
        else:
            self._key = ec.generate_private_key(ec.SECP256R1())

    @property
    def private_b64(self) -> str:
        return _b64(self._key.private_numbers().private_value.to_bytes(32, "big"))

    @property
    def public_b64(self) -> str:
        return _b64(self._key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))

    def authorization(self, endpoint: str, contact: str) -> str:
        u = urlsplit(endpoint)
        header = _b64(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
        claims = _b64(json.dumps(
            {"aud": f"{u.scheme}://{u.netloc}", "exp": int(time.time()) + 12 * 3600, "sub": contact},
            separators=(",", ":")).encode())
        r, s = decode_dss_signature(self._key.sign(f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
        signature = _b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
        return f"vapid t={header}.{claims}.{signature}, k={self.public_b64}"


def encrypt_push(payload: bytes, p256dh: str, auth: str) -> bytes:
    """받는 기기만 풀 수 있게 암호화 (aes128gcm). 푸시 서비스는 내용을 볼 수 없다."""
    ua_public_bytes = _unb64(p256dh)
    ua_public = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public_bytes)
    as_private = ec.generate_private_key(ec.SECP256R1())
    as_public = as_private.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    shared = as_private.exchange(ec.ECDH(), ua_public)
    ikm = HKDF(hashes.SHA256(), 32, _unb64(auth), b"WebPush: info\x00" + ua_public_bytes + as_public).derive(shared)
    salt = os.urandom(16)
    cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    ciphertext = AESGCM(cek).encrypt(nonce, payload + b"\x02", None)
    return salt + struct.pack(">I", 4096) + bytes([len(as_public)]) + as_public + ciphertext


def send_web_push(sub: dict, payload: bytes, vapid: Vapid, contact: str) -> int:
    """구독 하나에 전송하고 HTTP 상태 코드를 돌려준다. 404/410 이면 구독이 만료된 것."""
    req = urllib.request.Request(
        sub["endpoint"],
        data=encrypt_push(payload, sub["p256dh"], sub["auth"]),
        method="POST",
        headers={
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "TTL": "3600",
            "Urgency": "high",
            "Authorization": vapid.authorization(sub["endpoint"], contact),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status
    except urllib.error.HTTPError as e:
        return e.code


# ---------------------------------------------------------------- 그 밖의 경로

NTFY_URL = os.getenv("MEMO_NTFY_URL", "").strip()


def send_termux(rem: Reminder) -> bool:
    """서버가 Termux(안드로이드)에서 돌고 있으면 그 휴대폰에 알림을 띄운다."""
    exe = shutil.which("termux-notification")
    if not exe:
        return False
    subprocess.run([exe, "--title", rem.title, "--content", rem.body, "--id", rem.tag, "--group", "ai-memo"],
                   timeout=15, check=False)
    return True


def send_ntfy(rem: Reminder) -> bool:
    if not NTFY_URL:
        return False
    base, _, topic = NTFY_URL.rstrip("/").rpartition("/")
    req = urllib.request.Request(
        base + "/", method="POST", headers={"Content-Type": "application/json"},
        data=json.dumps({"topic": topic, "title": rem.title, "message": rem.body or rem.title}).encode(),
    )
    with urllib.request.urlopen(req, timeout=15):
        return True


def send_local(rem: Reminder) -> None:
    for name, fn in (("termux", send_termux), ("ntfy", send_ntfy)):
        try:
            fn(rem)
        except Exception as e:  # 한 경로가 실패해도 나머지는 계속
            log.warning("%s 알림 실패: %s", name, e)
