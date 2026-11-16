"use strict";

// ------------------------------------------------------------ 상태
const S = {
  token: localStorage.getItem("memo_token") || "",
  config: null,
  notes: new Map(),
  view: localStorage.getItem("memo_view") || "all",
  filter: "",
  q: "",
  calMonth: firstOfMonth(new Date()),
  calSel: ymd(new Date()),
  editing: null,
  menu: null,
  pushOn: false,
  es: null,
};
const OUTBOX_KEY = "memo_outbox";
const VIEW_TITLES = { all: "모든 메모", todo: "할 일", calendar: "캘린더", shopping: "장보기" };
const DOW = "일월화수목금토";
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

// ------------------------------------------------------------ 아이콘
const svg = (body, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  notes: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  cart: '<circle cx="9" cy="20" r="1.2"/><circle cx="18" cy="20" r="1.2"/><path d="M2.5 3h2.2l2.5 11.4a1.8 1.8 0 0 0 1.8 1.4h8.5a1.8 1.8 0 0 0 1.8-1.4L20.8 7H5.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  sparkle: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16v4M17 18h4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
};
$$("[data-icon]").forEach((el) => (el.innerHTML = svg(ICON[el.dataset.icon], el.closest(".search") ? 16 : 19)));

// ------------------------------------------------------------ 테마 (기본: 다크)
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("memo_theme", theme); } catch {}
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0d0d10" : "#f7f7f9";
  $$(".theme-toggle").forEach((b) => (b.innerHTML = svg(theme === "dark" ? ICON.sun : ICON.moon)));
}
$$(".theme-toggle").forEach((b) => b.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")));
applyTheme(document.documentElement.dataset.theme || "dark");

// ------------------------------------------------------------ API
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error("로그인이 필요합니다"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `오류 ${res.status}`);
  return res.json();
}

function toast(msg) {
  const t = $("#toast");
  ($("#notify").open ? $("#notify") : document.body).append(t); // 설정 창이 열려 있으면 그 위에 표시
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

// ------------------------------------------------------------ 로그인
async function boot() {
  S.config = await fetch("/api/config").then((r) => r.json());
  if (S.config.auth_required && !S.token) return showLogin();
  showApp();
}
function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-pw").focus();
}
function logout() {
  S.token = "";
  localStorage.removeItem("memo_token");
  S.es?.close();
  showLogin();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { token } = await api("/api/login", { method: "POST", body: { password: $("#login-pw").value } });
    S.token = token;
    localStorage.setItem("memo_token", token);
    $("#login-err").textContent = "";
    showApp();
  } catch (err) {
    $("#login-err").textContent = err.message;
  }
});

async function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  const hint = $("#ai-hint");
  hint.classList.toggle("ai", S.config.ai);
  hint.innerHTML = S.config.ai ? `${svg(ICON.sparkle, 15)}AI 자동 분류` : "키워드로 분류 (AI 키 없음)";
  const now = new Date();
  $("#today").textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 ${DOW[now.getDay()]}요일`;
  setView(S.view);
  await reload();
  connect();
  syncPush().catch(() => {});
}

async function reload() {
  try {
    const list = await api("/api/notes");
    S.notes = new Map(list.map((n) => [n.id, n]));
    render();
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------ 실시간 동기화
function setSync(on) {
  $$(".sync").forEach((el) => (el.className = `sync ${on ? "on" : "off"}`));
  $$(".sync-text").forEach((el) => (el.textContent = on ? "동기화됨" : "연결 끊김"));
}
function connect() {
  S.es?.close();
  const es = new EventSource(`/api/events${S.token ? `?token=${encodeURIComponent(S.token)}` : ""}`);
  S.es = es;
  es.addEventListener("hello", () => {
    setSync(true);
    flushOutbox();
    reload(); // 끊겼던 동안의 변경사항 반영
  });
  es.addEventListener("note", (e) => update(JSON.parse(e.data)));
  es.addEventListener("reminder", (e) => {
    // 푸시를 켠 기기는 시스템 알림으로 받으므로, 그렇지 않은 기기만 화면 안에 표시
    const r = JSON.parse(e.data);
    if (!S.pushOn) banner(r.title, r.body);
  });
  es.addEventListener("settings", (e) => { if ($("#notify").open) fillSettings(JSON.parse(e.data)); });
  es.addEventListener("delete", (e) => {
    S.notes.delete(JSON.parse(e.data).id);
    render();
  });
  es.onerror = () => setSync(false); // 브라우저가 자동 재연결
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("#app").hidden) {
    if (!S.es || S.es.readyState === EventSource.CLOSED) connect();
  }
});
window.addEventListener("online", () => { if (!$("#app").hidden) { flushOutbox(); connect(); } });

// ------------------------------------------------------------ 오프라인 보관함
function outbox() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch { return []; } }
function saveOutbox(list) { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); }
async function flushOutbox() {
  const list = outbox();
  if (!list.length) return;
  const remain = [];
  for (const content of list) {
    try { await api("/api/notes", { method: "POST", body: { content } }); } catch { remain.push(content); }
  }
  saveOutbox(remain);
  if (list.length > remain.length) toast(`오프라인 메모 ${list.length - remain.length}개 동기화됨`);
}

// ------------------------------------------------------------ 입력
const autoGrow = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

$("#compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ta = $("#compose-text");
  const content = ta.value.trim();
  if (!content) return;
  ta.value = "";
  ta.style.height = "";
  try {
    update(await api("/api/notes", { method: "POST", body: { content } }));
  } catch (err) {
    if (err instanceof TypeError || !navigator.onLine) {
      saveOutbox([...outbox(), content]);
      toast("오프라인: 연결되면 자동 저장됩니다");
    } else {
      ta.value = content;
      toast(err.message);
    }
  }
});
$("#compose-text").addEventListener("input", (e) => autoGrow(e.target));
$("#compose-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#compose").requestSubmit();
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) $(".kbd").textContent = "⌘ + Enter";

$("#search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); render(); });

$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
});
function setView(v) {
  S.view = VIEW_TITLES[v] ? v : "all";
  S.menu = null;
  localStorage.setItem("memo_view", S.view);
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === S.view));
  $("#view-title").textContent = VIEW_TITLES[S.view];
  render();
}

// ------------------------------------------------------------ 렌더링
const catColor = (c) => `var(--c-${c === "pending" ? "other" : c})`;
const isTask = (n) => n.category === "todo" || (n.due_date && n.category !== "shopping");

function matches(n) {
  if (!S.q) return true;
  return [n.content, n.title, ...n.tags, ...n.items.map((i) => i.name)].join(" ").toLowerCase().includes(S.q);
}
function sortedNotes() {
  return [...S.notes.values()].filter(matches).sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : b.id - a.id));
}

function ago(iso) {
  const d = new Date(iso);
  const min = Math.floor((Date.now() - d) / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  if (min < 1440) return `${Math.floor(min / 60)}시간 전`;
  if (min < 10080) return `${Math.floor(min / 1440)}일 전`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function dueLabel(n) {
  if (!n.due_date) return "";
  const d = new Date(n.due_date + "T00:00:00");
  const diff = Math.round((d - new Date(ymd(new Date()) + "T00:00:00")) / 86400000);
  const word = diff === 0 ? "오늘" : diff === 1 ? "내일" : diff === -1 ? "어제" : `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  const cls = n.done ? "" : diff < 0 ? "overdue" : diff === 0 ? "today" : "";
  return `<span class="due ${cls}">${svg(ICON.calendar, 13)}${word}${n.due_time ? " " + n.due_time : ""}</span>`;
}

function catPill(n) {
  if (n.category === "pending") return `<span class="cat pending"><span class="dot"></span>분류 중</span>`;
  const opts = Object.entries(S.config.categories)
    .map(([k, v]) => `<option value="${k}" ${k === n.category ? "selected" : ""}>${v}</option>`).join("");
  return `<span class="cat" style="--c:${catColor(n.category)}"><span class="dot"></span>${S.config.categories[n.category] || n.category}<select data-act="cat" aria-label="분류 바꾸기" title="분류 바꾸기">${opts}</select></span>`;
}

function itemList(items) {
  if (!items.length) return "";
  return `<ul class="items">${items.map((i) => `
    <li><label><input type="checkbox" class="check sq" data-item="${i.id}" ${i.checked ? "checked" : ""}>
    <span>${esc(i.name)}${i.quantity ? `<span class="qty">${esc(i.quantity)}</span>` : ""}</span></label></li>`).join("")}</ul>`;
}

function card(n) {
  if (S.editing === n.id) {
    return `
    <article class="card editing" data-id="${n.id}">
      <div class="card-body">
        <textarea class="edit-area" aria-label="메모 내용">${esc(n.content)}</textarea>
        <div class="edit-row">
          <input type="date" class="edit-date" value="${n.due_date || ""}" aria-label="날짜">
          <input type="time" class="edit-time" value="${n.due_time || ""}" aria-label="시간">
          <span class="spacer"></span>
          <button class="btn ghost" data-act="cancel">취소</button>
          <button class="btn primary" data-act="save">저장</button>
        </div>
      </div>
    </article>`;
  }
  const open = S.menu === n.id;
  // 제목이 본문 앞부분을 자른 것이면 본문을 두 번 보여주지 않는다
  const lines = n.content.trim().split("\n");
  const dup = lines[0].startsWith(n.title.replace(/…$/, "").trim());
  const title = dup ? lines[0] : n.title;
  const body = dup ? lines.slice(1).join("\n").trim() : n.content;
  return `
  <article class="card ${n.done ? "done" : ""} ${open ? "menu-open" : ""}" data-id="${n.id}">
    ${isTask(n) ? `<input type="checkbox" class="check" data-act="done" ${n.done ? "checked" : ""} aria-label="완료">` : ""}
    <div class="card-body">
      <div class="title">${esc(title)}</div>
      ${body ? `<p class="content">${esc(body)}</p>` : ""}
      ${itemList(n.items)}
      <div class="meta">
        ${catPill(n)}${dueLabel(n)}
        ${n.tags.map((t) => `<span>#${esc(t)}</span>`).join("")}
        <span class="ago">${ago(n.created_at)}</span>
      </div>
    </div>
    <button class="icon-btn more" data-act="menu" aria-label="더보기" aria-expanded="${open}">${svg(ICON.more)}</button>
    ${open ? `<div class="menu" role="menu">
      <button data-act="edit" role="menuitem">편집 · 날짜 변경</button>
      <button data-act="reclassify" role="menuitem">AI로 다시 분류</button>
      <button data-act="delete" role="menuitem" class="danger">삭제</button>
    </div>` : ""}
  </article>`;
}

const empty = (icon, text) => `<div class="empty">${svg(ICON[icon], 30)}<p>${text}</p></div>`;

function render() {
  if (!S.config) return;
  const v = $("#view");

  // 편집 중에 다른 기기의 변경이 들어와도 입력하던 내용이 사라지지 않게 보존
  const old = v.querySelector(".card.editing");
  const keep = old && Number(old.dataset.id) === S.editing ? {
    text: old.querySelector(".edit-area").value,
    date: old.querySelector(".edit-date").value,
    time: old.querySelector(".edit-time").value,
    sel: [old.querySelector(".edit-area").selectionStart, old.querySelector(".edit-area").selectionEnd],
    focused: document.activeElement === old.querySelector(".edit-area"),
  } : null;

  const fns = { all: renderAll, todo: renderTodo, calendar: renderCalendar, shopping: renderShopping };
  v.innerHTML = fns[S.view]();
  updateCounts();

  const ed = v.querySelector(".card.editing");
  if (ed) {
    const ta = ed.querySelector(".edit-area");
    if (keep) {
      ta.value = keep.text;
      ed.querySelector(".edit-date").value = keep.date;
      ed.querySelector(".edit-time").value = keep.time;
    }
    autoGrow(ta);
    if (!keep || keep.focused) {
      ta.focus();
      ta.setSelectionRange(...(keep ? keep.sel : [ta.value.length, ta.value.length]));
    }
  }
}

function updateCounts() {
  const all = [...S.notes.values()];
  const counts = {
    todo: all.filter((n) => isTask(n) && !n.done).length,
    shopping: all.reduce((a, n) => a + n.items.filter((i) => !i.checked).length, 0),
  };
  $$("[data-count]").forEach((el) => (el.textContent = counts[el.dataset.count] || ""));
}

function renderAll() {
  const notes = sortedNotes();
  if (!notes.length) return empty("notes", S.q ? "검색 결과가 없습니다" : "첫 메모를 적어보세요");
  const counts = {};
  notes.forEach((n) => (counts[n.category] = (counts[n.category] || 0) + 1));
  if (S.filter && !counts[S.filter]) S.filter = "";
  const cats = Object.entries(S.config.categories).filter(([k]) => counts[k]);
  const chips = cats.length < 2 ? "" : `<div class="chips">
    <button class="chip ${S.filter ? "" : "active"}" data-filter="">전체 <b>${notes.length}</b></button>
    ${cats.map(([k, label]) => `<button class="chip ${S.filter === k ? "active" : ""}" data-filter="${k}">
      <span class="dot" style="--c:${catColor(k)}"></span>${label} <b>${counts[k]}</b></button>`).join("")}
  </div>`;
  const list = notes.filter((n) => !S.filter || n.category === S.filter);
  return `${chips}<div class="list">${list.map(card).join("")}</div>`;
}

function renderTodo() {
  const today = ymd(new Date());
  const tasks = sortedNotes().filter(isTask);
  const key = (n) => (n.due_date || "9999") + (n.due_time || "99");
  const open = tasks.filter((n) => !n.done).sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const groups = [
    ["지난 일", open.filter((n) => n.due_date && n.due_date < today)],
    ["오늘", open.filter((n) => n.due_date === today)],
    ["예정", open.filter((n) => n.due_date && n.due_date > today)],
    ["날짜 없음", open.filter((n) => !n.due_date)],
    ["완료", tasks.filter((n) => n.done)],
  ].filter(([, l]) => l.length);
  if (!groups.length) return empty("check", S.q ? "검색 결과가 없습니다" : "할 일이 없습니다");
  return groups.map(([t, l]) =>
    `<div class="section-title">${t}<span>${l.length}</span></div><div class="list">${l.map(card).join("")}</div>`).join("");
}

function renderCalendar() {
  const m = S.calMonth;
  const start = new Date(m.getFullYear(), m.getMonth(), 1 - m.getDay());
  const today = ymd(new Date());
  const byDate = {};
  sortedNotes().filter((n) => n.due_date).forEach((n) => (byDate[n.due_date] ||= []).push(n));
  Object.values(byDate).forEach((l) => l.sort((a, b) => ((a.due_time || "99") < (b.due_time || "99") ? -1 : 1)));
  let cells = DOW.split("").map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i === 35 && d.getMonth() !== m.getMonth()) break;
    const key = ymd(d);
    const evs = byDate[key] || [];
    const cls = [d.getMonth() !== m.getMonth() && "other", key === today && "today", key === S.calSel && "sel"].filter(Boolean).join(" ");
    cells += `<button class="day ${cls}" data-date="${key}" aria-label="${d.getMonth() + 1}월 ${d.getDate()}일, ${evs.length}건">
      <span class="num">${d.getDate()}</span>
      ${evs.slice(0, 3).map((n) => `<span class="ev ${n.done ? "done" : ""}" style="--c:${catColor(n.category)}"><span>${esc(n.title)}</span></span>`).join("")}
      ${evs.length > 3 ? `<span class="more-ev">+${evs.length - 3}</span>` : ""}
      ${evs.length ? `<span class="dots">${evs.slice(0, 3).map((n) => `<span class="dot" style="--c:${catColor(n.category)}"></span>`).join("")}</span>` : ""}
    </button>`;
  }
  const sel = byDate[S.calSel] || [];
  const selD = new Date(S.calSel + "T00:00:00");
  return `
    <div class="cal-head">
      <h2>${m.getFullYear()}년 ${m.getMonth() + 1}월</h2>
      <button class="btn ghost" data-cal="today">오늘</button>
      <button class="icon-btn" data-cal="-1" aria-label="이전 달">${svg(ICON.prev)}</button>
      <button class="icon-btn" data-cal="1" aria-label="다음 달">${svg(ICON.next)}</button>
    </div>
    <div class="cal">${cells}</div>
    <div class="section-title">${selD.getMonth() + 1}월 ${selD.getDate()}일 ${DOW[selD.getDay()]}요일<span>${sel.length || ""}</span></div>
    ${sel.length ? `<div class="list">${sel.map(card).join("")}</div>` : empty("calendar", "일정이 없습니다")}`;
}

function renderShopping() {
  const notes = sortedNotes().filter((n) => n.items.length || (n.category === "shopping" && !n.done));
  if (!notes.length) return empty("cart", S.q ? "검색 결과가 없습니다" : "살 것이 없습니다");
  const total = notes.reduce((a, n) => a + n.items.length, 0);
  const done = notes.reduce((a, n) => a + n.items.filter((i) => i.checked).length, 0);
  const groups = notes.map((n) => `
    <div class="shop-group" data-id="${n.id}">
      <h3>${esc(n.title)}${dueLabel(n)}</h3>
      ${n.items.length ? itemList([...n.items].sort((a, b) => a.checked - b.checked)) : `<p class="content">${esc(n.content)}</p>`}
    </div>`).join("");
  return `
    <div class="progress">
      <div class="progress-head">
        <strong>${total - done}개 남음</strong><span>${total}개 중 ${done}개 완료</span>
        <button class="btn ghost" data-act="clear-checked" ${done ? "" : "disabled"}>완료 항목 지우기</button>
      </div>
      <div class="bar"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
    </div>
    <div class="list">${groups}</div>`;
}

// ------------------------------------------------------------ 동작
$("#view").addEventListener("click", async (e) => {
  const t = e.target;
  const chip = t.closest("[data-filter]");
  if (chip) { S.filter = chip.dataset.filter; return render(); }
  const calBtn = t.closest("[data-cal]");
  if (calBtn) {
    const c = calBtn.dataset.cal;
    if (c === "today") { S.calMonth = firstOfMonth(new Date()); S.calSel = ymd(new Date()); }
    else S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + Number(c), 1);
    return render();
  }
  const day = t.closest("[data-date]");
  if (day) { S.calSel = day.dataset.date; return render(); }

  const actEl = t.closest("[data-act]");
  if (!actEl) return;
  const act = actEl.dataset.act;
  if (act === "cat" || act === "done") return; // change 이벤트에서 처리
  if (act === "clear-checked") {
    if (confirm("완료한 항목을 지울까요?")) await api("/api/shopping/clear-checked", { method: "POST" }).catch((err) => toast(err.message));
    return;
  }
  const el = actEl.closest("[data-id]");
  if (!el) return;
  const id = Number(el.dataset.id);
  const n = S.notes.get(id);
  try {
    if (act === "menu") { S.menu = S.menu === id ? null : id; render(); }
    else if (act === "edit") { S.menu = null; S.editing = id; render(); }
    else if (act === "cancel") { S.editing = null; render(); }
    else if (act === "save") {
      const content = el.querySelector(".edit-area").value.trim();
      const date = el.querySelector(".edit-date").value;
      const time = date ? el.querySelector(".edit-time").value : "";
      if (!content) return toast("내용을 입력하세요");
      const body = {};
      if (content !== n.content) body.content = content;
      if (date !== (n.due_date || "") || time !== (n.due_time || "")) {
        Object.assign(body, date ? { due_date: date, due_time: time } : { clear_due: true });
      }
      S.editing = null;
      if (Object.keys(body).length) update(await api(`/api/notes/${id}`, { method: "PATCH", body }));
      else render();
    } else if (act === "delete") {
      S.menu = null;
      if (!confirm("이 메모를 삭제할까요?")) return render();
      await api(`/api/notes/${id}`, { method: "DELETE" });
      S.notes.delete(id);
      render();
    } else if (act === "reclassify") {
      S.menu = null;
      render();
      await api(`/api/notes/${id}/reclassify`, { method: "POST" });
      toast("다시 분류하는 중…");
    }
  } catch (err) { toast(err.message); render(); }
});

$("#view").addEventListener("change", async (e) => {
  const t = e.target;
  try {
    if (t.dataset.item) {
      update(await api(`/api/items/${t.dataset.item}`, { method: "PATCH", body: { checked: t.checked } }));
      return;
    }
    const el = t.closest("[data-id]");
    if (!el) return;
    const id = Number(el.dataset.id);
    if (t.dataset.act === "done") update(await api(`/api/notes/${id}`, { method: "PATCH", body: { done: t.checked } }));
    if (t.dataset.act === "cat") update(await api(`/api/notes/${id}`, { method: "PATCH", body: { category: t.value } }));
  } catch (err) { toast(err.message); render(); }
});

$("#view").addEventListener("input", (e) => { if (e.target.classList.contains("edit-area")) autoGrow(e.target); });
$("#view").addEventListener("keydown", (e) => {
  if (e.target.classList.contains("edit-area") && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.target.closest(".card").querySelector('[data-act="save"]').click();
  }
});

// 메뉴 바깥을 누르거나 Esc 로 닫기
document.addEventListener("click", (e) => {
  if (S.menu !== null && !e.target.closest('.menu, [data-act="menu"]')) { S.menu = null; render(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (S.menu !== null) { S.menu = null; render(); }
  else if (S.editing !== null) { S.editing = null; render(); }
});

// 더 최신(rev 큰) 상태만 반영
function update(n) {
  const cur = S.notes.get(n.id);
  if (!cur || cur.rev <= n.rev) S.notes.set(n.id, n);
  render();
}

// ------------------------------------------------------------ 알림
const pushSupported = () =>
  window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytesToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function currentSub() {
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}

// 이 기기를 서버에 등록한다. 서버 키가 바뀌었으면(DB를 새로 만든 경우) 구독을 다시 만든다.
async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api("/api/push/key");
  let sub = await reg.pushManager.getSubscription();
  if (sub && (!sub.options.applicationServerKey || bytesToB64(sub.options.applicationServerKey) !== key)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
  S.pushOn = true;
}

// 앱을 열 때: 전에 알림을 켠 기기면 등록 상태를 다시 맞춘다
async function syncPush() {
  if (!S.config.push || !pushSupported() || Notification.permission !== "granted") return;
  if (await currentSub()) await subscribePush();
}

function renderPushState() {
  const status = $("#push-status");
  const btn = $("#push-toggle");
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  let msg = "";
  if (!S.config.push) msg = "서버에 웹 푸시가 설정되지 않았습니다.";
  else if (!window.isSecureContext) msg = "HTTPS 주소로 접속해야 켤 수 있습니다. 지금은 앱을 열어 둔 동안에만 화면 안에서 알려드립니다.";
  else if (!pushSupported()) msg = ios ? "공유 버튼 → '홈 화면에 추가'로 설치한 뒤, 설치한 앱에서 켤 수 있습니다." : "이 브라우저는 알림을 지원하지 않습니다.";
  else if (Notification.permission === "denied") msg = "알림이 차단되어 있습니다. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.";
  btn.hidden = !!msg;
  status.textContent = msg || (S.pushOn ? "앱을 닫아도 알림이 옵니다." : "앱을 닫아도 일정과 마감을 알려드립니다.");
  btn.textContent = S.pushOn ? "끄기" : "켜기";
  btn.classList.toggle("primary", !S.pushOn);
}

$("#push-toggle").addEventListener("click", async () => {
  try {
    if (S.pushOn) {
      const sub = await currentSub();
      if (sub) {
        await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      S.pushOn = false;
    } else if ((await Notification.requestPermission()) === "granted") {
      await subscribePush();
      toast("이 기기에서 알림을 받습니다");
    }
  } catch (err) {
    toast(`알림을 켤 수 없습니다: ${err.message}`);
  }
  renderPushState();
});

const SET_OPTS = {
  morning: [["", "끄기"], ...["06:00", "07:00", "08:00", "09:00", "10:00"].map((t) => [t, t])],
  evening: [["", "끄기"], ...["18:00", "19:00", "20:00", "21:00", "22:00"].map((t) => [t, t])],
  lead: [["", "끄기"], ["0", "정각"], ["10", "10분 전"], ["30", "30분 전"], ["60", "1시간 전"], ["120", "2시간 전"]],
};
function fillSettings(s) {
  for (const [key, base] of Object.entries(SET_OPTS)) {
    const opts = base.some(([v]) => v === s[key]) ? base : [...base, [s[key], s[key]]];
    const sel = $(`#set-${key}`);
    sel.innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
    sel.value = s[key];
  }
}
for (const key of Object.keys(SET_OPTS)) {
  $(`#set-${key}`).addEventListener("change", async (e) => {
    try { await api("/api/settings", { method: "PUT", body: { [key]: e.target.value } }); toast("저장했습니다"); }
    catch (err) { toast(err.message); }
  });
}

$("#bell").addEventListener("click", async () => {
  try {
    fillSettings(await api("/api/settings"));
    renderPushState();
    $("#notify").showModal();
  } catch (err) { toast(err.message); }
});
$("#notify-close").addEventListener("click", () => $("#notify").close());
$("#notify").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("#push-test").addEventListener("click", async () => {
  try {
    const { devices } = await api("/api/push/test", { method: "POST" });
    toast(devices ? `알림을 켠 기기 ${devices}대로 보냈습니다` : "알림을 켠 기기가 없어 화면 안에만 표시했습니다");
  } catch (err) { toast(err.message); }
});

function banner(title, body) {
  const el = document.createElement("div");
  el.className = "banner";
  el.setAttribute("role", "status");
  el.innerHTML = `${svg(ICON.bell)}<div><strong>${esc(title)}</strong>${body ? `<p>${esc(body)}</p>` : ""}</div>
    <button class="icon-btn" aria-label="닫기">${svg(ICON.close, 16)}</button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  // 놓치지 않도록 닫을 때까지 남겨 두되, 너무 쌓이면 오래된 것부터 지운다
  $("#banners").prepend(el);
  [...$("#banners").children].slice(4).forEach((old) => old.remove());
}

// ------------------------------------------------------------ PWA
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot().catch(() => toast("서버에 연결할 수 없습니다"));
