"""반복 일정 계산. 화면 쪽 web/recur.js 와 같은 규칙을 쓴다.

규칙 형식 (DB 에는 JSON 으로 저장)
  freq      "daily" | "weekly" | "monthly" | "yearly"
  interval  1~99: 몇 일·주·달·년마다 (격주 = weekly 2)
  weekdays  weekly 의 반복 요일 (0=월 … 6=일)
  day       monthly·yearly 의 기준 날짜 (31일 → 2월엔 말일, 3월엔 다시 31일)
  month     yearly 의 기준 달
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Optional

FREQS = ("daily", "weekly", "monthly", "yearly")
_MONDAY = date(1970, 1, 5)
_MAX_STEPS = 10000


def _int(value, lo: int, hi: int) -> Optional[int]:
    try:
        value = int(value)
    except (TypeError, ValueError):
        return None
    return value if lo <= value <= hi else None


def clean(rule) -> Optional[dict]:
    """밖(AI·화면·파일)에서 온 규칙을 검사해 정리한다. 쓸 수 없으면 None."""
    if not isinstance(rule, dict) or rule.get("freq") not in FREQS:
        return None
    out = {"freq": rule["freq"], "interval": _int(rule.get("interval"), 1, 99) or 1}
    if out["freq"] == "weekly":
        raw = rule.get("weekdays")
        days = sorted({d for d in (_int(x, 0, 6) for x in (raw if isinstance(raw, list) else [])) if d is not None})
        if days:
            out["weekdays"] = days
    if out["freq"] in ("monthly", "yearly") and _int(rule.get("day"), 1, 31):
        out["day"] = _int(rule.get("day"), 1, 31)
    if out["freq"] == "yearly" and _int(rule.get("month"), 1, 12):
        out["month"] = _int(rule.get("month"), 1, 12)
    return out


def _clamp(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _week(d: date) -> int:
    return (d - _MONDAY).days // 7


def next_after(rule: dict, d: date) -> date:
    """d 다음 반복 날짜."""
    freq, n = rule["freq"], rule.get("interval", 1)
    if freq == "daily":
        return d + timedelta(days=n)
    if freq == "weekly":
        days = rule.get("weekdays")
        if not days:
            return d + timedelta(weeks=n)
        c = d + timedelta(days=1)
        while c.weekday() not in days or (_week(c) - _week(d)) % n:
            c += timedelta(days=1)
        return c
    if freq == "monthly":
        months = d.year * 12 + d.month - 1 + n
        return _clamp(months // 12, months % 12 + 1, rule.get("day", d.day))
    return _clamp(d.year + n, rule.get("month", d.month), rule.get("day", d.day))


def first_on_or_after(rule: dict, start: date) -> date:
    """start 와 같거나 뒤인 첫 반복 날짜 (요일·날짜가 정해져 있을 때)."""
    freq = rule["freq"]
    if freq == "weekly" and rule.get("weekdays"):
        c = start
        while c.weekday() not in rule["weekdays"]:
            c += timedelta(days=1)
        return c
    if freq == "monthly" and rule.get("day"):
        c = _clamp(start.year, start.month, rule["day"])
        if c < start:
            months = start.year * 12 + start.month  # 다음 달
            c = _clamp(months // 12, months % 12 + 1, rule["day"])
        return c
    if freq == "yearly" and rule.get("month") and rule.get("day"):
        c = _clamp(start.year, rule["month"], rule["day"])
        return c if c >= start else _clamp(start.year + 1, rule["month"], rule["day"])
    return start


def anchor(rule: dict, due: date) -> dict:
    """due 를 기준 요일·날짜로 삼는다. 날짜를 새로 정했을 때 부른다.

    규칙의 기준 날짜가 due 와 맞으면(매달 31일 ↔ 11월 30일) 그대로 둔다. 그래야 '말일'이 유지된다.
    """
    out = dict(rule)
    freq = out["freq"]
    if freq == "weekly" and len(out.get("weekdays", [])) <= 1:
        out["weekdays"] = [due.weekday()]
    elif freq == "monthly":
        if not (out.get("day") and _clamp(due.year, due.month, out["day"]) == due):
            out["day"] = due.day
    elif freq == "yearly":
        if not (out.get("month") == due.month and out.get("day") and _clamp(due.year, due.month, out["day"]) == due):
            out["month"], out["day"] = due.month, due.day
    return out


def roll_forward(rule: dict, due: date, today: date) -> date:
    """due 가 지났으면 오늘이나 그 뒤의 첫 반복 날짜로."""
    try:
        for _ in range(_MAX_STEPS):
            if due >= today:
                break
            due = next_after(rule, due)
    except (ValueError, OverflowError):
        pass
    return due


def after_done(rule: dict, due: date, today: date) -> date:
    """이번 회차를 끝냈을 때 다음 날짜: 오늘보다 뒤의 첫 반복 날짜."""
    try:
        nxt = next_after(rule, due)
        for _ in range(_MAX_STEPS):
            if nxt > today:
                break
            nxt = next_after(rule, nxt)
        return nxt
    except (ValueError, OverflowError):
        return max(due, today) + timedelta(days=1)


def normalize(rule, due: Optional[date], today: date) -> tuple[Optional[dict], Optional[date]]:
    """새로 분류한 반복 규칙과 첫 날짜를 맞춘다. 규칙이 없거나 잘못되면 (None, due)."""
    rule = clean(rule)
    if rule is None:
        return None, due
    try:
        due = first_on_or_after(rule, due or today)
        rule = anchor(rule, due)
        return rule, roll_forward(rule, due, today)
    except (ValueError, OverflowError):
        return None, due
