// 반복 일정 계산. 서버의 server/recurrence.py 와 같은 규칙을 쓴다.
// 날짜는 "YYYY-MM-DD" 문자열로 주고받고, 계산은 시간대 영향이 없는 UTC 로 한다.
(function (root) {
  "use strict";
  const DAY = 86400000;
  const WD = "월화수목금토일";
  const pad = (n) => String(n).padStart(2, "0");
  const parse = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const fmt = (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const weekday = (t) => (new Date(t).getUTCDay() + 6) % 7; // 0=월
  const week = (t) => Math.floor((Math.round(t / DAY) - 4) / 7); // 1970-01-05(월) 기준 주 번호
  const clamp = (y, m, d) => Date.UTC(y, m - 1, Math.min(d, new Date(Date.UTC(y, m, 0)).getUTCDate()));
  const validDays = (rule) => (Array.isArray(rule.weekdays) ? rule.weekdays.filter((d) => d >= 0 && d <= 6) : []);

  function next(rule, t) {
    const n = rule.interval || 1;
    if (rule.freq === "daily") return t + n * DAY;
    if (rule.freq === "weekly") {
      const days = validDays(rule);
      if (!days.length) return t + 7 * n * DAY;
      const w0 = week(t);
      let c = t + DAY;
      for (let i = 0; i < 7 * n + 7; i++, c += DAY) {
        if (days.includes(weekday(c)) && (week(c) - w0) % n === 0) return c;
      }
      return t + 7 * n * DAY;
    }
    const d = new Date(t);
    if (rule.freq === "monthly") {
      const months = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
      return clamp(Math.floor(months / 12), (months % 12) + 1, rule.day || d.getUTCDate());
    }
    return clamp(d.getUTCFullYear() + n, rule.month || d.getUTCMonth() + 1, rule.day || d.getUTCDate());
  }

  // 다음 반복 날짜
  const nextAfter = (rule, s) => fmt(next(rule, parse(s)));

  // 이번 회차를 끝냈을 때 다음 날짜: 오늘보다 뒤의 첫 반복 날짜
  function afterDone(rule, due, today) {
    const limit = parse(today);
    let t = next(rule, parse(due));
    for (let i = 0; i < 10000 && t <= limit; i++) t = next(rule, t);
    return fmt(t);
  }

  // due 다음부터 반복되는 날짜 중 [from, to] 안에 드는 것 (캘린더 표시용)
  function occurrences(rule, due, from, to) {
    const lo = parse(from);
    const hi = parse(to);
    const out = [];
    let t = parse(due);
    for (let i = 0; i < 5000; i++) {
      t = next(rule, t);
      if (t > hi) break;
      if (t >= lo) out.push(fmt(t));
    }
    return out;
  }

  // "매주 월·수", "격주 화", "매달 25일" 같은 설명
  function label(rule, due) {
    if (!rule) return "";
    const n = rule.interval || 1;
    const t = due ? parse(due) : null;
    switch (rule.freq) {
      case "daily":
        return n === 1 ? "매일" : `${n}일마다`;
      case "weekly": {
        let days = validDays(rule);
        if (!days.length && t !== null) days = [weekday(t)];
        const key = days.join("");
        if (n === 1 && key === "01234") return "평일마다";
        if (n === 1 && key === "56") return "주말마다";
        const prefix = n === 1 ? "매주" : n === 2 ? "격주" : `${n}주마다`;
        return days.length ? `${prefix} ${days.map((d) => WD[d]).join("·")}` : prefix;
      }
      case "monthly": {
        const day = rule.day || (t !== null ? new Date(t).getUTCDate() : 0);
        return `${n === 1 ? "매달" : `${n}달마다`}${day ? ` ${day}일` : ""}`;
      }
      case "yearly": {
        const month = rule.month || (t !== null ? new Date(t).getUTCMonth() + 1 : 0);
        const day = rule.day || (t !== null ? new Date(t).getUTCDate() : 0);
        const when = month && day ? ` ${month}월 ${day}일` : "";
        return `${n === 1 ? "매년" : `${n}년마다`}${when}`;
      }
      default:
        return "";
    }
  }

  const api = { nextAfter, afterDone, occurrences, label };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Recur = api;
})(typeof self !== "undefined" ? self : this);
