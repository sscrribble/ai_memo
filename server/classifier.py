"""메모 내용을 AI(Claude)로 분류하고, 날짜·반복·장보기 항목을 추출한다.

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

import recurrence

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

# 장보기 항목을 마트 동선대로 묶는 구역
SECTIONS = ["채소·과일", "정육·수산", "냉장·유제품", "냉동", "쌀·면·가공", "양념·소스", "간식·음료", "생활용품", "기타"]
Section = Literal[tuple(SECTIONS)]


class Item(BaseModel):
    name: str = Field(description="물건 이름")
    quantity: Optional[str] = Field(description="수량/단위. 없으면 null")
    section: Section = Field(description="마트에서 이 물건을 찾을 구역")


class Repeat(BaseModel):
    freq: Literal["daily", "weekly", "monthly", "yearly"]
    interval: int = Field(description="몇 일·주·달·년마다인지. 보통 1, 격주는 2")
    weekdays: list[int] = Field(description="weekly 일 때 반복 요일 (0=월요일 … 6=일요일). 그 밖에는 빈 배열")
    day: Optional[int] = Field(description="monthly 일 때 반복 날짜 (1~31, 말일은 31). 그 밖에는 null")


class Classification(BaseModel):
    category: Category
    title: str = Field(description="메모를 요약한 20자 이내 제목")
    tags: list[str] = Field(description="핵심 키워드 0~4개")
    due_date: Optional[str] = Field(description="마감/일정 날짜 YYYY-MM-DD. 없으면 null")
    due_time: Optional[str] = Field(description="시각 HH:MM (24시간). 없으면 null")
    repeat: Optional[Repeat] = Field(description="반복 일정. 반복 표현이 없으면 null")
    items: list[Item] = Field(description="사야 할 물건 목록. 장보기가 아니면 빈 배열")


SYSTEM_PROMPT = """당신은 개인 메모 앱의 분류기입니다. 사용자가 쓴 메모 하나를 읽고 구조화된 정보를 돌려줍니다.

카테고리:
- todo: 해야 할 일, 일정, 약속, 마감이 있는 작업, 반복해서 할 일
- shopping: 사야 할 물건이 중심인 메모 (장보기, 구매 목록)
- idea: 아이디어, 기획, 나중에 해볼 것
- info: 참고 정보, 링크, 비밀번호가 아닌 사실 정보, 레시피 등
- diary: 일기, 감정, 생각 기록
- other: 위에 해당하지 않음

규칙:
- 사야 할 물건이 있으면 items에 하나씩 나눠 담습니다. "우유 2개, 계란" → [{우유, 2개}, {계란, null}].
- 각 물건의 section은 마트에서 그 물건을 찾을 구역입니다. 애매하면 "기타".
- "내일", "다음주 금요일", "3일 뒤" 같은 상대 날짜는 오늘 날짜 기준으로 실제 날짜로 바꿉니다.
- 날짜가 언급되지 않으면 due_date는 null입니다. 추측하지 마세요.
- 반복 표현(매일, 평일마다, 매주 월요일, 격주 화요일, 매달 25일, 매년 3월 5일 등)이 있으면 repeat를 채웁니다. 없으면 null.
  - 반복이 있으면 due_date는 오늘이나 그 뒤의 첫 번째 날짜입니다.
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
    c.items = [it for it in c.items if it.name.strip()]
    return c


# ---------------------------------------------------------------- 장보기 구역 추측 (규칙 기반)

_SECTION_WORDS = {
    "채소·과일": "채소 야채 대파 쪽파 파 양파 마늘 생강 감자 고구마 당근 무 배추 양배추 상추 깻잎 오이 호박 애호박 "
                "버섯 팽이버섯 표고 시금치 콩나물 숙주 고추 청양고추 피망 파프리카 브로콜리 토마토 방울토마토 가지 "
                "미나리 부추 샐러드 과일 사과 배 바나나 딸기 포도 귤 오렌지 레몬 수박 참외 복숭아 키위 블루베리 "
                "아보카도 망고 자몽",
    "정육·수산": "고기 소고기 쇠고기 한우 돼지고기 삼겹살 목살 앞다리 갈비 불고기 다짐육 닭 닭고기 닭가슴살 닭다리 "
                "오리 생선 고등어 갈치 연어 회 새우 오징어 낙지 쭈꾸미 조개 바지락 굴 전복 멸치 황태 다시마 미역",
    "냉장·유제품": "우유 계란 달걀 두부 치즈 요거트 요구르트 버터 생크림 햄 소시지 베이컨 어묵 김치 두유 크림치즈",
    "냉동": "냉동 만두 아이스크림 냉동피자 돈가스 동그랑땡 너겟 냉동새우 냉동밥",
    "쌀·면·가공": "쌀 현미 잡곡 라면 국수 소면 우동 파스타 스파게티 빵 식빵 베이글 시리얼 밀가루 부침가루 튀김가루 "
                 "빵가루 통조림 참치 참치캔 스팸 카레 짜장 떡 떡볶이 즉석밥 햇반 김 김밥김 누룽지 오트밀",
    "양념·소스": "간장 고추장 된장 쌈장 소금 설탕 후추 식용유 올리브유 참기름 들기름 식초 케첩 마요네즈 소스 "
                "굴소스 물엿 올리고당 다시다 맛술 고춧가루 깨 참깨 드레싱 와사비 머스타드",
    "간식·음료": "과자 초콜릿 사탕 젤리 쿠키 견과 커피 원두 믹스커피 차 녹차 주스 음료 탄산수 콜라 사이다 생수 물 "
                "맥주 소주 와인 막걸리 아이스티",
    "생활용품": "휴지 화장지 두루마리 키친타월 물티슈 세제 섬유유연제 주방세제 샴푸 린스 컨디셔너 바디워시 비누 "
               "치약 칫솔 면도기 생리대 기저귀 건전지 전구 쓰레기봉투 종량제 랩 호일 지퍼백 고무장갑 수세미 마스크 "
               "면봉 화장솜 로션",
}
_SECTION_INDEX = [(w, sec) for sec, words in _SECTION_WORDS.items() for w in words.split()]


def guess_section(name: str) -> str:
    """물건 이름으로 마트 구역을 추측한다. 가장 길게 맞는 낱말을 고른다 (물티슈 → 생활용품)."""
    key = re.sub(r"\s+", "", name)
    best, best_len = "기타", 0
    for word, sec in _SECTION_INDEX:
        # 한 글자 낱말(무·배·파·물…)은 이름 전체가 같을 때만 (배터리 ≠ 배)
        hit = key == word if len(word) == 1 else word in key
        if hit and len(word) > best_len:
            best, best_len = sec, len(word)
    return best


# ---------------------------------------------------------------- 반복 표현 (규칙 기반)

_DAYS = "월화수목금토일"
_DAY = r"[월화수목금토일](?:요일)?"
_DAY_END = r"(?=$|[\s,.!?)~/]|에|엔|마다|은|는|만|도|까지|부터|날|\d)"
_RE_WEEKLY_DAYS = re.compile(
    rf"(매\s*주|격\s*주|(\d+)\s*주\s*마다|매(?=\s*[월화수목금토일]요일))\s*"
    rf"((?:{_DAY}\s*[,·/와과]?\s*)*{_DAY}){_DAY_END}"
)


def parse_repeat(text: str) -> Optional[dict]:
    """'매주 월요일', '격주 화·목', '매달 25일', '매년 3월 5일', '평일마다' 같은 반복 표현을 찾는다."""
    m = re.search(r"매\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일", text)
    if m:
        return {"freq": "yearly", "interval": 1, "month": int(m[1]), "day": int(m[2])}
    if re.search(r"매\s*년|해\s*마다|매해", text):
        return {"freq": "yearly", "interval": 1}
    m = re.search(r"(?:매\s*(?:달|월)|(\d+)\s*(?:개월|달)\s*마다)\s*(\d{1,2}|말)\s*일", text)
    if m:
        return {"freq": "monthly", "interval": int(m[1] or 1), "day": 31 if m[2] == "말" else int(m[2])}
    m = re.search(r"매\s*(?:달|월)(?!\s*요일)|(\d+)\s*(?:개월|달)\s*마다|한\s*달\s*마다", text)
    if m:
        return {"freq": "monthly", "interval": int(m[1] or 1)}
    if re.search(r"주말\s*마다|매\s*주말", text):
        return {"freq": "weekly", "interval": 1, "weekdays": [5, 6]}
    if re.search(r"평일\s*마다|매\s*평일|평일(?:에|엔)?\s*매일|매일\s*평일", text):
        return {"freq": "weekly", "interval": 1, "weekdays": [0, 1, 2, 3, 4]}
    m = _RE_WEEKLY_DAYS.search(text)
    if m:
        days = sorted({_DAYS.index(c) for c in re.findall(r"[월화수목금토일]", m[3].replace("요일", ""))})
        interval = 2 if re.sub(r"\s", "", m[1]) == "격주" else int(m[2] or 1)
        return {"freq": "weekly", "interval": interval, "weekdays": days}
    m = re.search(r"매\s*주|격\s*주|(\d+)\s*주\s*마다|일주일\s*마다", text)
    if m:
        return {"freq": "weekly", "interval": 2 if "격" in m[0] else int(m[1] or 1)}
    m = re.search(r"(\d+)\s*일\s*마다", text)
    if m and int(m[1]) > 0:
        return {"freq": "daily", "interval": int(m[1])}
    if re.search(r"매\s*일(?!\s*요일)|날\s*마다", text):
        return {"freq": "daily", "interval": 1}
    return None


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
    head, sep, tail = re.sub("：", ":", text).partition(":")
    if sep and tail.strip() and "," not in head and "\n" not in head.strip():
        text = tail  # "엄마 생신 장보기: 케이크, 초" → 콜론 앞은 제목
    body = re.sub(r"(매\s*(?:일|주|달|월|년)|격\s*주|평일\s*마다|주말\s*마다|\d+\s*(?:일|주|달|개월)\s*마다)\s*", " ", text)
    body = re.sub(r"(다음\s*주|이번\s*주)?\s*[월화수목금토일]요일(에|엔|마다)?", " ", body)
    body = re.sub(r"\d{1,2}\s*월\s*\d{1,2}\s*일|(오전|오후|아침|저녁|밤)?\s*\d{1,2}\s*시(\s*반|\s*\d{1,2}\s*분)?|\d{1,2}:\d{2}", " ", body)
    body = re.sub(r"(내일|오늘|모레|마트|에서|가서|장보기|장 보기|사야\s*할\s*것|살\s*것)[:\s]*", " ", body)
    body = re.sub(r"\s*(사기|사야 함|사야함|사야 돼|사야돼|구매|사 오기|사오기)\s*", ",", body)
    items = []
    for part in re.split(r"[,\n·•/、:]|\s-\s|^-", body):
        part = part.strip(" -*.\t")
        if not part or len(part) > 30:
            continue
        m = re.match(r"(.+?)\s*(\d+\s*\S{0,3})$", part)
        name, qty = (m.group(1), m.group(2)) if m else (part, None)
        name = name.strip()
        items.append(Item(name=name, quantity=qty, section=guess_section(name)))
    return items[:30]


def rule_classify(content: str, today: date) -> Classification:
    text = content.strip()
    lower = text.lower()
    has = lambda words: any(w in lower for w in words)  # noqa: E731
    d = _parse_date(text, today)
    rep = parse_repeat(text)
    if rep is not None and (d is None or "day" in rep):
        d = recurrence.first_on_or_after(recurrence.clean(rep), d or today)
    if has(SHOP_WORDS):
        category = "shopping"
    elif has(TODO_WORDS) or d is not None or rep is not None:
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
        repeat=Repeat(freq=rep["freq"], interval=rep["interval"], weekdays=rep.get("weekdays", []),
                      day=rep.get("day") if rep["freq"] == "monthly" else None) if rep else None,
        items=_extract_items(text) if category == "shopping" else [],
    )
