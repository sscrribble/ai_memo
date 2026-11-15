"""메모 내용을 AI(Claude)로 분류하고, 날짜·장보기 항목을 추출한다.

API 키가 없거나 호출이 실패하면 키워드 기반 규칙으로 대신 분류한다.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import date, timedelta
from typing import Literal, Optional

import anthropic
from pydantic import BaseModel, Field

log = logging.getLogger("classifier")

MODEL = os.getenv("MEMO_MODEL", "claude-opus-5-5")

Category = Literal["todo", "shopping", "idea", "info", "diary", "other"]
CATEGORY_LABELS = {
    "todo": "할 일",
    "shopping": "장보기",
    "idea": "아이디어",
    "info": "정보·참고",
    "diary": "일기·생각",
    "other": "기타",
}


class Item(BaseModel):
    name: str = Field(description="물건 이름")
    quantity: Optional[str] = Field(description="수량/단위. 없으면 null")


class Classification(BaseModel):
    category: Category
    title: str = Field(description="메모를 요약한 20자 이내 제목")
    tags: list[str] = Field(description="핵심 키워드 0~4개")
    due_date: Optional[str] = Field(description="마감/일정 날짜 YYYY-MM-DD. 없으면 null")
    due_time: Optional[str] = Field(description="시각 HH:MM (24시간). 없으면 null")
    items: list[Item] = Field(description="사야 할 물건 목록. 장보기가 아니면 빈 배열")


SYSTEM_PROMPT = """당신은 개인 메모 앱의 분류기입니다. 사용자가 쓴 메모 하나를 읽고 구조화된 정보를 돌려줍니다.

카테고리:
- todo: 해야 할 일, 일정, 약속, 마감이 있는 작업
- shopping: 사야 할 물건이 중심인 메모 (장보기, 구매 목록)
- idea: 아이디어, 기획, 나중에 해볼 것
- info: 참고 정보, 링크, 비밀번호가 아닌 사실 정보, 레시피 등
- diary: 일기, 감정, 생각 기록
- other: 위에 해당하지 않음

규칙:
- 사야 할 물건이 있으면 items에 하나씩 나눠 담습니다. "우유 2개, 계란" → [{우유, 2개}, {계란, null}].
- "내일", "다음주 금요일", "3일 뒤" 같은 상대 날짜는 오늘 날짜 기준으로 실제 날짜로 바꿉니다.
- 날짜가 언급되지 않으면 due_date는 null입니다. 추측하지 마세요.
- 제목과 태그는 메모와 같은 언어로 씁니다."""

_client: Optional[anthropic.AsyncAnthropic] = None


def _get_client() -> Optional[anthropic.AsyncAnthropic]:
    global _client
    if _client is None and (os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")):
        _client = anthropic.AsyncAnthropic()
    return _client


def ai_enabled() -> bool:
    return _get_client() is not None


async def classify(content: str, today: date) -> tuple[Classification, str]:
    """(분류 결과, 분류 방식 'ai' | 'rule') 을 돌려준다."""
    client = _get_client()
    if client is not None:
        try:
            weekday = "월화수목금토일"[today.weekday()]
            response = await client.beta.messages.parse(
                model=MODEL,
                max_tokens=4000,
                # 안전 분류기가 거절하면 서버가 다른 모델로 자동 재시도
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                output_config={"effort": "low"},
                system=SYSTEM_PROMPT,
                messages=[{
                    "role": "user",
                    "content": f"오늘: {today.isoformat()} ({weekday}요일)\n\n메모:\n{content}",
                }],
                output_format=Classification,
            )
            if response.stop_reason == "refusal" or response.parsed_output is None:
                log.warning("AI 분류 불가 (stop_reason=%s), 규칙 기반으로 대체", response.stop_reason)
            else:
                return _normalize(response.parsed_output), "ai"
        except anthropic.RateLimitError:
            log.warning("AI 호출 한도 초과, 규칙 기반으로 대체")
        except anthropic.APIStatusError as e:
            log.warning("AI API 오류 %s: %s", e.status_code, e.message)
        except anthropic.APIConnectionError:
            log.warning("AI 서버 연결 실패, 규칙 기반으로 대체")
    return rule_classify(content, today), "rule"


def _normalize(c: Classification) -> Classification:
    if c.due_date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", c.due_date):
        c.due_date = None
    if c.due_time and not re.fullmatch(r"\d{2}:\d{2}", c.due_time):
        c.due_time = None
    c.title = c.title.strip()[:40]
    c.tags = [t.strip().lstrip("#") for t in c.tags if t.strip()][:4]
    return c


# ---------------------------------------------------------------- 규칙 기반 대체 분류

SHOP_WORDS = ("사기", "사야", "구매", "장보기", "장 보기", "마트", "주문", "쇼핑", "살 것", "살것", "사 오기", "사오기")
TODO_WORDS = ("해야", "하기", "까지", "마감", "회의", "미팅", "약속", "예약", "제출", "연락", "전화", "병원", "할 일", "할일", "일정")
IDEA_WORDS = ("아이디어", "기획", "해보면", "만들어보", "구상")
DIARY_WORDS = ("오늘은", "기분", "느꼈", "행복", "슬펐", "일기")
WEEKDAYS = "월화수목금토일"


def _parse_date(text: str, today: date) -> Optional[date]:
    if "모레" in text:
        return today + timedelta(days=2)
    if "내일" in text:
        return today + timedelta(days=1)
    if "오늘" in text:
        return today
    m = re.search(r"(\d+)\s*일\s*(뒤|후)", text)
    if m:
        return today + timedelta(days=int(m.group(1)))
    m = re.search(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    m = re.search(r"(\d{1,2})\s*월\s*(\d{1,2})\s*일", text) or re.search(r"\b(\d{1,2})/(\d{1,2})\b", text)
    if m:
        try:
            d = date(today.year, int(m.group(1)), int(m.group(2)))
            return d if d >= today - timedelta(days=30) else date(today.year + 1, d.month, d.day)
        except ValueError:
            pass
    m = re.search(r"(이번\s*주|다음\s*주|다다음\s*주)?\s*([월화수목금토일])요일", text)
    if m:
        target = WEEKDAYS.index(m.group(2))
        week = (m.group(1) or "").replace(" ", "")
        monday = today - timedelta(days=today.weekday())
        offset = {"다음주": 7, "다다음주": 14}.get(week, 0)
        d = monday + timedelta(days=offset + target)
        if not week and d < today:
            d += timedelta(days=7)
        return d
    return None


def _parse_time(text: str) -> Optional[str]:
    m = re.search(r"(\d{1,2}):(\d{2})", text)
    if m and int(m.group(1)) < 24:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    m = re.search(r"(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시\s*(반|(\d{1,2})\s*분)?", text)
    if m:
        h = int(m.group(2))
        if m.group(1) in ("오후", "저녁", "밤") and h < 12:
            h += 12
        minute = 30 if m.group(3) == "반" else int(m.group(4) or 0)
        if h < 24:
            return f"{h:02d}:{minute:02d}"
    return None


def _extract_items(text: str) -> list[Item]:
    body = re.sub(r"(내일|오늘|모레|마트|에서|가서|장보기|장 보기|사야\s*할\s*것|살\s*것)[:\s]*", " ", text)
    body = re.sub(r"\s*(사기|사야 함|사야함|사야 돼|사야돼|구매|사 오기|사오기)\s*", ",", body)
    items = []
    for part in re.split(r"[,\n·•/、]|\s-\s|^-", body):
        part = part.strip(" -*.\t")
        if not part or len(part) > 30:
            continue
        m = re.match(r"(.+?)\s*(\d+\s*\S{0,3})$", part)
        name, qty = (m.group(1), m.group(2)) if m else (part, None)
        items.append(Item(name=name.strip(), quantity=qty))
    return items[:30]


def rule_classify(content: str, today: date) -> Classification:
    text = content.strip()
    lower = text.lower()
    has = lambda words: any(w in lower for w in words)  # noqa: E731
    d = _parse_date(text, today)
    if has(SHOP_WORDS):
        category = "shopping"
    elif has(TODO_WORDS) or d is not None:
        category = "todo"
    elif has(IDEA_WORDS):
        category = "idea"
    elif re.search(r"https?://", text):
        category = "info"
    elif has(DIARY_WORDS):
        category = "diary"
    else:
        category = "other"
    first_line = text.splitlines()[0] if text else ""
    return Classification(
        category=category,
        title=first_line[:20] + ("…" if len(first_line) > 20 else ""),
        tags=re.findall(r"#(\w+)", text)[:4],
        due_date=d.isoformat() if d else None,
        due_time=_parse_time(text),
        items=_extract_items(text) if category == "shopping" else [],
    )
