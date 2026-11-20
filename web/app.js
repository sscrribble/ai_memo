"use strict";

// ------------------------------------------------------------ 브라우저 저장소 (막혀 있어도 앱은 동작)
const store = {
  raw(key) { try { return localStorage.getItem(key); } catch { return null; } },
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

// 안드로이드 앱 안에서 열렸을 때 앱과 주고받는 창구 (브라우저에서는 없음)
const NATIVE = window.AIMemoApp || null;
function native(method, ...args) {
  try { return NATIVE && typeof NATIVE[method] === "function" ? NATIVE[method](...args) : undefined; } catch { return undefined; }
}

// ------------------------------------------------------------ 상태
const S = {
  token: store.raw("memo_token") || "",
  config: null,
  notes: new Map(),
  view: store.raw("memo_view") || "all",
  shopMode: store.raw("memo_shop") === "note" ? "note" : "section",
  filter: "",
  q: "",
  calMonth: firstOfMonth(new Date()),
  calSel: ymd(new Date()),
  editing: null,
  menu: null,
  showDone: false,
  pushOn: false,
  live: false,     // 실시간 연결됨
  offline: false,  // 서버에 닿지 않음
  es: null,
};
const VIEW_TITLES = { all: "모든 메모", todo: "할 일", calendar: "캘린더", shopping: "장보기" };
const DOW = "일월화수목금토";
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function pad(n) { return String(n).padStart(2, "0"); }

// ------------------------------------------------------------ 날짜
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
const todayStr = () => ymd(new Date());
const toDate = (s) => new Date(`${s}T00:00:00`);
function addDays(s, n) { const d = toDate(s); d.setDate(d.getDate() + n); return ymd(d); }
const dayDiff = (s) => Math.round((toDate(s) - toDate(todayStr())) / 86400000);
function fmtDay(s) {
  const d = toDate(s);
  const diff = dayDiff(s);
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  if (diff === -1) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
}
function ago(iso) {
  const d = new Date(iso);
  const min = Math.floor((Date.now() - d) / 60000);
  if (!(min >= 1)) return "방금";
  if (min < 60) return `${min}분 전`;
  if (min < 1440) return `${Math.floor(min / 60)}시간 전`;
  if (min < 10080) return `${Math.floor(min / 1440)}일 전`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

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
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  pin: '<path d="M9 3h6l-.8 6.2L17 12H7l2.8-2.8z"/><path d="M12 12v9"/>',
  repeat: '<path d="m17 2.5 3 3-3 3"/><path d="M4 11.5v-1a5 5 0 0 1 5-5h11"/><path d="m7 21.5-3-3 3-3"/><path d="M20 12.5v1a5 5 0 0 1-5 5H4"/>',
  offline: '<path d="m2 2 20 20"/><path d="M5.8 8.6A6 6 0 0 0 7 20h10.5"/><path d="M21.2 16.6A4.5 4.5 0 0 0 17.5 10h-.9A6.5 6.5 0 0 0 10 4.3"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};
$$("[data-icon]").forEach((el) => (el.innerHTML = svg(ICON[el.dataset.icon], el.closest(".search") ? 16 : 19)));

// ------------------------------------------------------------ 테마 (기본: 다크)
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set("memo_theme", theme);
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0d0d10" : "#f7f7f9";
  $$(".theme-toggle").forEach((b) => (b.innerHTML = svg(theme === "dark" ? ICON.sun : ICON.moon)));
  native("setTheme", theme === "dark"); // 앱의 상단·하단 막대 색도 맞춘다
}
$$(".theme-toggle").forEach((b) => b.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")));
applyTheme(document.documentElement.dataset.theme || "dark");

// ------------------------------------------------------------ 서버 API
class Offline extends Error {
  constructor() { super("서버에 연결할 수 없습니다"); this.offline = true; }
}

async function api(path, { method = "GET", body, timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Offline();
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && path !== "/api/login") { logout(); throw new Error("다시 로그인해 주세요"); }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new Offline(); // 앞단 프록시가 '서버 꺼짐'을 알림
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(typeof data.detail === "string" ? data.detail : "요청을 처리할 수 없습니다");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------ 바꾼 내용 보내기 (오프라인이면 모아 두었다가 나중에)
// 바꾼 내용은 먼저 화면에 반영하고, 서버에는 순서대로 보낸다.
let tmpSeq = 0;
const tmpId = () => -(Date.now() * 100 + (tmpSeq++ % 100));
let queue = store.get("memo_queue", null);
if (!Array.isArray(queue)) {
  const old = store.get("memo_outbox", []); // 이전 버전의 '오프라인 메모'
  queue = (Array.isArray(old) ? old : []).filter((c) => typeof c === "string")
    .map((content) => ({ type: "create", content, tmp: tmpId(), at: new Date().toISOString() }));
  store.del("memo_outbox");
}
const saveQueue = () => store.set("memo_queue", queue);
let flushing = null;
let inflight = null;

function mutate(op) {
  applyLocal(op);
  queue.push(op);
  saveQueue();
  changed();
  return flushQueue();
}

function flushQueue() {
  if (flushing) return flushing;
  flushing = (async () => {
    let rejected = false;
    let sent = false;
    while (queue.length) {
      const op = (inflight = queue[0]);
      let res = null;
      try {
        res = await sendOp(op);
        sent = true;
      } catch (err) {
        if (err.offline) { setOffline(true); break; }
        rejected = true;
        if (err.status !== 404) toast(err.message);
      } finally {
        inflight = null;
      }
      queue = queue.filter((o) => o !== op);
      saveQueue();
      if (res) update(res);
    }
    if (sent && !queue.length) setOffline(false);
    changed();
    if (rejected) await reload();
  })().finally(() => { flushing = null; });
  return flushing;
}

async function sendOp(op) {
  switch (op.type) {
    case "create": {
      const note = await api("/api/notes", { method: "POST", body: { content: op.content } });
      S.notes.delete(op.tmp);
      return note;
    }
    case "note": return api(`/api/notes/${op.id}`, { method: "PATCH", body: op.body });
    case "item": return api(`/api/items/${op.id}`, { method: "PATCH", body: { checked: op.checked } });
    case "delete": await api(`/api/notes/${op.id}`, { method: "DELETE" }); return null;
    case "restore": return api(`/api/notes/${op.id}/restore`, { method: "POST" });
    case "clear": await api("/api/shopping/clear-checked", { method: "POST" }); return null;
    default: return null;
  }
}

// 서버에 보내기 전에 화면 쪽 데이터에 먼저 반영. 여러 번 적용해도 결과가 같게 만든다.
function applyLocal(op) {
  const n = S.notes.get(op.id);
  switch (op.type) {
    case "create":
      if (!S.notes.has(op.tmp)) {
        S.notes.set(op.tmp, {
          id: op.tmp, content: op.content, title: op.content.split("\n")[0].slice(0, 40), category: "pending",
          tags: [], items: [], due_date: null, due_time: null, repeat: null, done: false, pinned: false,
          created_at: op.at, rev: -1, tmp: true,
        });
      }
      break;
    case "note":
      if (n) patchLocal(n, op.body, op);
      break;
    case "item":
      for (const note of S.notes.values()) for (const it of note.items) if (it.id === op.id) it.checked = op.checked;
      break;
    case "delete":
      S.notes.delete(op.id);
      break;
    case "restore":
      if (op.note && !S.notes.has(op.id)) S.notes.set(op.id, op.note);
      break;
    case "clear":
      for (const note of S.notes.values()) {
        if (!note.items.some((i) => i.checked)) continue;
        if (note.repeat) note.items.forEach((i) => (i.checked = false));
        else {
          note.items = note.items.filter((i) => !i.checked);
          if (!note.items.length) note.done = true;
        }
      }
      break;
  }
}

function patchLocal(n, b, op) {
  if (b.content !== undefined) n.content = b.content;
  if (b.category !== undefined) { n.category = b.category; n.category_locked = true; }
  if (b.pinned !== undefined) n.pinned = b.pinned;
  if (b.clear_due) { n.due_date = n.due_time = null; n.repeat = null; }
  if (b.due_date !== undefined) n.due_date = b.due_date || null;
  if (b.due_time !== undefined) n.due_time = b.due_time || null;
  if ("repeat" in b) {
    n.repeat = b.repeat;
    if (b.repeat && !n.due_date) n.due_date = todayStr();
  }
  if (!n.due_date) n.repeat = null;
  if (b.done !== undefined) {
    if (b.done && n.repeat && n.due_date) {
      // 반복 일정은 다음 회차로. 이미 넘긴 상태(서버가 처리함)면 다시 넘기지 않는다.
      if (!op.from || n.due_date === op.from) n.due_date = Recur.afterDone(n.repeat, n.due_date, todayStr());
    } else n.done = b.done;
  }
}

// 지금 화면의 메모를 브라우저에 저장해 두었다가 다음에 (오프라인이어도) 바로 보여 준다
let cacheTimer = null;
function saveCache() {
  clearTimeout(cacheTimer);
  if (S.config) store.set("memo_cache", [...S.notes.values()]);
}
function changed() {
  render();
  renderStatus();
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(saveCache, 300);
}
window.addEventListener("pagehide", saveCache);

// 서버에서 온 메모로 바꾼다. 아직 못 보낸 변경은 그 위에 다시 얹는다.
function update(n) {
  const cur = S.notes.get(n.id);
  if (!cur || cur.rev <= n.rev) {
    S.notes.set(n.id, n);
    for (const op of queue) if (op.type !== "create") applyLocal(op);
  }
  changed();
}

async function reload() {
  try {
    const list = await api("/api/notes");
    S.notes = new Map(list.map((n) => [n.id, n]));
    for (const op of queue) applyLocal(op);
    if (!queue.length) setOffline(false);
    changed();
  } catch (err) {
    if (err.offline) setOffline(true);
    else toast(err.message);
  }
}

function setOffline(flag) {
  if (S.offline === flag) return;
  S.offline = flag;
  renderStatus();
}

function renderStatus() {
  const bar = $("#offline");
  bar.hidden = !S.offline;
  if (S.offline) {
    bar.innerHTML = `${svg(ICON.offline, 16)}<span>오프라인 — 저장해 둔 내용을 보여드려요${
      queue.length ? ` · 연결되면 변경 ${queue.length}건을 보냅니다` : ""}</span>`;
  }
  $$(".sync").forEach((el) => (el.className = `sync ${S.live ? "on" : "off"}`));
  $$(".sync-text").forEach((el) => (el.textContent = S.live ? "동기화됨" : S.offline ? "오프라인" : "연결 중"));
}

// ------------------------------------------------------------ 시작·로그인
async function boot() {
  $("#fatal").hidden = true;
  try {
    S.config = await api("/api/config");
    store.set("memo_config", S.config);
  } catch {
    S.config = store.get("memo_config", null); // 오프라인이면 지난번 설정으로 시작
    if (!S.config) { $("#fatal").hidden = false; return; }
    S.offline = true;
  }
  if (S.config.auth_required && !S.token) return showLogin();
  showApp();
}
$("#fatal-retry").addEventListener("click", () => boot());

function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#login-pw").focus();
}
function logout() {
  S.token = "";
  store.del("memo_token");
  S.es?.close();
  native("clearSession");
  showLogin();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const { token } = await api("/api/login", { method: "POST", body: { password: $("#login-pw").value } });
    S.token = token;
    store.set("memo_token", token);
    $("#login-err").textContent = "";
    $("#login-pw").value = "";
    showApp();
  } catch (err) {
    $("#login-err").textContent = err.message;
  }
});

let started = false;
async function showApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  native("setSession", S.token || ""); // 앱이 화면을 닫아도 알림을 받을 수 있게
  const hint = $("#ai-hint");
  hint.classList.toggle("ai", !!S.config.ai);
  hint.innerHTML = S.config.ai ? `${svg(ICON.sparkle, 15)}AI 자동 분류` : "키워드로 분류 (AI 키 없음)";
  const now = new Date();
  $("#today").textContent = `${now.getMonth() + 1}월 ${now.getDate()}일 ${DOW[now.getDay()]}요일`;
  if (!S.notes.size) {
    const cached = store.get("memo_cache", []); // 지난번 화면을 먼저 보여 준다 (오프라인에서도)
    if (Array.isArray(cached)) S.notes = new Map(cached.filter((n) => n && n.id != null).map((n) => [n.id, fixNote(n)]));
    for (const op of queue) applyLocal(op); // 아직 못 보낸 변경도 보이게
  }
  setView(S.view);
  renderStatus();
  if (!started) {
    started = true;
    setInterval(() => { if (queue.length) flushQueue(); }, 15000);
  }
  await flushQueue();
  await reload();
  connect();
  syncPush().catch(() => {});
}

function fixNote(n) {
  return { tags: [], items: [], repeat: null, pinned: false, done: false, ...n };
}

// ------------------------------------------------------------ 실시간 동기화
function connect() {
  S.es?.close();
  const es = new EventSource(`/api/events${S.token ? `?token=${encodeURIComponent(S.token)}` : ""}`);
  S.es = es;
  es.addEventListener("hello", async () => {
    S.live = true;
    setOffline(false);
    renderStatus();
    await flushQueue();
    await reload(); // 끊겼던 동안의 변경사항 반영
  });
  es.addEventListener("note", (e) => update(JSON.parse(e.data)));
  es.addEventListener("delete", (e) => { S.notes.delete(JSON.parse(e.data).id); changed(); });
  es.addEventListener("reload", () => reload());
  es.addEventListener("reminder", (e) => {
    // 푸시를 켠 기기는 시스템 알림으로 받으므로, 그렇지 않은 기기만 화면 안에 표시
    const r = JSON.parse(e.data);
    if (!S.pushOn && native("notificationStatus") !== "on") banner(r.title, r.body);
  });
  es.addEventListener("settings", (e) => { if ($("#settings").open) fillSettings(JSON.parse(e.data)); });
  es.onerror = () => { // 브라우저가 알아서 다시 연결한다
    S.live = false;
    S.offline = true;
    renderStatus();
  };
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || $("#app").hidden) return;
  if (!S.es || S.es.readyState === EventSource.CLOSED) connect();
  if (queue.length) flushQueue();
});
window.addEventListener("online", () => { if (!$("#app").hidden) { flushQueue(); connect(); } });
window.addEventListener("offline", () => setOffline(true));

// ------------------------------------------------------------ 입력·검색·화면 전환
const autoGrow = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

$("#compose").addEventListener("submit", (e) => {
  e.preventDefault();
  const ta = $("#compose-text");
  const content = ta.value.trim();
  if (!content) return;
  ta.value = "";
  ta.style.height = "";
  mutate({ type: "create", content, tmp: tmpId(), at: new Date().toISOString() });
});
$("#compose-text").addEventListener("input", (e) => autoGrow(e.target));
$("#compose-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#compose").requestSubmit();
});
if (/Mac|iPhone|iPad/.test(navigator.platform)) $(".kbd").textContent = "⌘ + Enter";

function setSearch(text) {
  $("#search").value = text;
  S.q = text.trim().toLowerCase();
  render();
}
$("#search").addEventListener("input", (e) => setSearch(e.target.value));

$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
});
function setView(v) {
  S.view = VIEW_TITLES[v] ? v : "all";
  S.menu = null;
  store.set("memo_view", S.view);
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === S.view));
  $("#view-title").textContent = VIEW_TITLES[S.view];
  render();
}

// ------------------------------------------------------------ 그리기
const catColor = (c) => `var(--c-${c === "pending" ? "other" : c})`;
const isTask = (n) => n.category === "todo" || (n.due_date && n.category !== "shopping");
const ts = (n) => Date.parse(n.created_at) || 0;

function matches(n) {
  if (!S.q) return true;
  return [n.content, n.title, ...n.tags, ...n.items.map((i) => i.name)].join(" ").toLowerCase().includes(S.q);
}
function sortedNotes() {
  return [...S.notes.values()].filter(matches).sort((a, b) => ts(b) - ts(a) || b.id - a.id);
}

// 링크는 누를 수 있게 (http/https 만)
function linkify(text) {
  return esc(text).replace(/https?:\/\/(?:(?!&quot;|&#39;|&lt;|&gt;)[^\s<])+/g, (url) => {
    const trail = url.match(/[.,;:!?)\]]+$/);
    const href = trail ? url.slice(0, -trail[0].length) : url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trail ? trail[0] : ""}`;
  });
}

function dueLabel(n) {
  if (!n.due_date) return "";
  const diff = dayDiff(n.due_date);
  const cls = n.done ? "" : diff < 0 ? "overdue" : diff === 0 ? "today" : "";
  return `<span class="due ${cls}">${svg(ICON.calendar, 13)}${fmtDay(n.due_date)}${n.due_time ? " " + n.due_time : ""}</span>`;
}
const repeatLabel = (n) =>
  n.repeat ? `<span class="rep">${svg(ICON.repeat, 13)}${esc(Recur.label(n.repeat, n.due_date))}</span>` : "";

function catPill(n) {
  if (n.tmp) return `<span class="cat pending">${svg(ICON.offline, 13)}연결되면 저장</span>`;
  if (n.category === "pending") return `<span class="cat pending"><span class="dot"></span>분류 중</span>`;
  const opts = Object.entries(S.config.categories)
    .map(([k, v]) => `<option value="${k}" ${k === n.category ? "selected" : ""}>${v}</option>`).join("");
  return `<span class="cat" style="--c:${catColor(n.category)}"><span class="dot"></span>${esc(S.config.categories[n.category] || n.category)}<select data-act="cat" aria-label="분류 바꾸기" title="분류 바꾸기">${opts}</select></span>`;
}

function itemList(items) {
  if (!items.length) return "";
  return `<ul class="items">${items.map((i) => `
    <li><label><input type="checkbox" class="check sq" data-item="${i.id}" ${i.checked ? "checked" : ""}>
    <span class="iname">${esc(i.name)}${i.quantity ? `<span class="qty">${esc(i.quantity)}</span>` : ""}</span></label></li>`).join("")}</ul>`;
}

// 제목이 본문 앞부분을 자른 것이면 본문을 두 번 보여 주지 않는다
function titleBody(n) {
  const lines = n.content.trim().split("\n");
  const dup = lines[0].startsWith(n.title.replace(/…$/, "").trim());
  return dup ? { title: lines[0], body: lines.slice(1).join("\n").trim() } : { title: n.title, body: n.content };
}

const REPEATS = [
  ["", "반복 안 함", null],
  ["daily", "매일", { freq: "daily", interval: 1 }],
  ["weekdays", "평일마다", { freq: "weekly", interval: 1, weekdays: [0, 1, 2, 3, 4] }],
  ["weekly", "매주", { freq: "weekly", interval: 1 }],
  ["biweekly", "격주", { freq: "weekly", interval: 2 }],
  ["monthly", "매달", { freq: "monthly", interval: 1 }],
  ["yearly", "매년", { freq: "yearly", interval: 1 }],
];
// 지금 규칙이 어느 선택지에 해당하는지 (기준 요일·날짜는 날짜에서 정해지므로 비교하지 않음)
function repeatKey(rule) {
  if (!rule) return "";
  const multi = (r) => (r.weekdays && r.weekdays.length > 1 ? r.weekdays.join() : "");
  const hit = REPEATS.find(([, , r]) => r && r.freq === rule.freq && r.interval === (rule.interval || 1) && multi(r) === multi(rule));
  return hit ? hit[0] : "keep";
}

function card(n) {
  if (S.editing === n.id) return editCard(n);
  const open = S.menu === n.id;
  const { title, body } = titleBody(n);
  const task = isTask(n) && !n.tmp;
  return `
  <article class="card ${n.done ? "done" : ""} ${open ? "menu-open" : ""} ${n.tmp ? "tmp" : ""}" data-id="${n.id}">
    ${task ? `<input type="checkbox" class="check" data-act="done" ${n.done ? "checked" : ""} aria-label="${n.repeat ? "이번 회차 완료" : "완료"}">` : ""}
    <div class="card-body">
      <div class="title">${n.pinned ? `<span class="pin" title="고정됨">${svg(ICON.pin, 14)}</span>` : ""}${linkify(title)}</div>
      ${body ? `<p class="content">${linkify(body)}</p>` : ""}
      ${itemList(n.items)}
      <div class="meta">
        ${catPill(n)}${dueLabel(n)}${repeatLabel(n)}
        ${n.tags.map((t) => `<button type="button" class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}
        <span class="ago">${ago(n.created_at)}</span>
      </div>
    </div>
    ${n.tmp ? "" : `<button class="icon-btn more" data-act="menu" aria-label="더보기" aria-expanded="${open}">${svg(ICON.more)}</button>`}
    ${open ? menu(n) : ""}
  </article>`;
}

function menu(n) {
  const entries = [
    ["edit", "편집 · 날짜 · 반복"],
    ["pin", n.pinned ? "고정 해제" : "맨 위에 고정"],
    isTask(n) && !n.done ? ["tomorrow", "내일로 미루기"] : null,
    ["reclassify", "AI로 다시 분류"],
    ["delete", "삭제", "danger"],
  ].filter(Boolean);
  return `<div class="menu" role="menu">${entries.map(([act, label, cls]) =>
    `<button data-act="${act}" role="menuitem" class="${cls || ""}">${label}</button>`).join("")}</div>`;
}

function editCard(n) {
  const key = repeatKey(n.repeat);
  const options = [...REPEATS.map(([k, label]) => [k, label]), ...(key === "keep" ? [["keep", Recur.label(n.repeat, n.due_date)]] : [])]
    .map(([k, label]) => `<option value="${k}" ${k === key ? "selected" : ""}>${esc(label)}</option>`).join("");
  return `
    <article class="card editing" data-id="${n.id}">
      <div class="card-body">
        <textarea class="edit-area" aria-label="메모 내용">${esc(n.content)}</textarea>
        <div class="edit-row">
          <input type="date" class="edit-date" value="${n.due_date || ""}" aria-label="날짜">
          <input type="time" class="edit-time" value="${n.due_time || ""}" aria-label="시간">
          <select class="edit-repeat" aria-label="반복">${options}</select>
          <span class="spacer"></span>
          <button class="btn ghost" data-act="cancel">취소</button>
          <button class="btn primary" data-act="save">저장</button>
        </div>
      </div>
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
    repeat: old.querySelector(".edit-repeat").value,
    sel: [old.querySelector(".edit-area").selectionStart, old.querySelector(".edit-area").selectionEnd],
    focused: document.activeElement === old.querySelector(".edit-area"),
  } : null;

  const views = { all: renderAll, todo: renderTodo, calendar: renderCalendar, shopping: renderShopping };
  v.innerHTML = views[S.view]();
  updateCounts();

  const ed = v.querySelector(".card.editing");
  if (ed) {
    const ta = ed.querySelector(".edit-area");
    if (keep) {
      ta.value = keep.text;
      ed.querySelector(".edit-date").value = keep.date;
      ed.querySelector(".edit-time").value = keep.time;
      ed.querySelector(".edit-repeat").value = keep.repeat;
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
  const list = notes.filter((n) => !S.filter || n.category === S.filter).sort((a, b) => !!b.pinned - !!a.pinned);
  return `${chips}<div class="list">${list.map(card).join("")}</div>`;
}

function renderTodo() {
  const today = todayStr();
  const tasks = sortedNotes().filter(isTask);
  const key = (n) => (n.due_date || "9999") + (n.due_time || "99");
  const open = tasks.filter((n) => !n.done).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const done = tasks.filter((n) => n.done);
  const groups = [
    ["지난 일", open.filter((n) => n.due_date && n.due_date < today)],
    ["오늘", open.filter((n) => n.due_date === today)],
    ["예정", open.filter((n) => n.due_date && n.due_date > today)],
    ["날짜 없음", open.filter((n) => !n.due_date)],
  ].filter(([, l]) => l.length);
  if (!groups.length && !done.length) return empty("check", S.q ? "검색 결과가 없습니다" : "할 일이 없습니다");
  return groups.map(([t, l]) =>
    `<div class="section-title">${t}<span>${l.length}</span></div><div class="list">${l.map(card).join("")}</div>`).join("")
    + (done.length ? `
    <button type="button" class="section-title toggle ${S.showDone ? "open" : ""}" data-act="toggle-done" aria-expanded="${S.showDone}">
      완료<span>${done.length}</span>${svg(ICON.chevron, 14)}</button>
    ${S.showDone ? `<div class="list">${done.map(card).join("")}</div>` : ""}` : "");
}

function renderCalendar() {
  const m = S.calMonth;
  const start = new Date(m.getFullYear(), m.getMonth(), 1 - m.getDay());
  const cells = Math.ceil((m.getDay() + new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) / 7) * 7;
  const gridStart = ymd(start);
  const gridEnd = ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + cells - 1));
  const today = todayStr();
  const byDate = {};
  const put = (key, n, ghost) => (byDate[key] ||= []).push({ n, ghost });
  for (const n of sortedNotes()) {
    if (!n.due_date) continue;
    put(n.due_date, n, false);
    // 반복 일정은 앞으로의 날짜도 흐리게 보여 준다
    if (n.repeat && !n.done) {
      for (const d of Recur.occurrences(n.repeat, n.due_date, gridStart > today ? gridStart : today, gridEnd)) put(d, n, true);
    }
  }
  const tkey = (e) => e.n.due_time || "99";
  Object.values(byDate).forEach((l) => l.sort((a, b) => (tkey(a) < tkey(b) ? -1 : tkey(a) > tkey(b) ? 1 : 0)));
  let html = DOW.split("").map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < cells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = ymd(d);
    const evs = byDate[key] || [];
    const cls = [d.getMonth() !== m.getMonth() && "other", key === today && "today", key === S.calSel && "sel"].filter(Boolean).join(" ");
    html += `<button class="day ${cls}" data-date="${key}" aria-label="${d.getMonth() + 1}월 ${d.getDate()}일, ${evs.length}건">
      <span class="num">${d.getDate()}</span>
      ${evs.slice(0, 3).map(({ n, ghost }) => `<span class="ev ${n.done ? "done" : ""} ${ghost ? "ghost" : ""}" style="--c:${catColor(n.category)}"><span>${esc(n.title)}</span></span>`).join("")}
      ${evs.length > 3 ? `<span class="more-ev">+${evs.length - 3}</span>` : ""}
      ${evs.length ? `<span class="dots">${evs.slice(0, 3).map(({ n, ghost }) => `<span class="dot ${ghost ? "ghost" : ""}" style="--c:${catColor(n.category)}"></span>`).join("")}</span>` : ""}
    </button>`;
  }
  const sel = byDate[S.calSel] || [];
  const real = sel.filter((e) => !e.ghost).map((e) => e.n);
  const ghosts = sel.filter((e) => e.ghost).map((e) => e.n);
  const selD = toDate(S.calSel);
  return `
    <div class="cal-head">
      <h2>${m.getFullYear()}년 ${m.getMonth() + 1}월</h2>
      <button class="btn ghost" data-cal="today">오늘</button>
      <button class="icon-btn" data-cal="-1" aria-label="이전 달">${svg(ICON.prev)}</button>
      <button class="icon-btn" data-cal="1" aria-label="다음 달">${svg(ICON.next)}</button>
    </div>
    <div class="cal">${html}</div>
    <div class="section-title">${selD.getMonth() + 1}월 ${selD.getDate()}일 ${DOW[selD.getDay()]}요일<span>${sel.length || ""}</span></div>
    ${sel.length ? `<div class="list">${real.map(card).join("")}${ghosts.map((n) => `
      <div class="ghost-row" style="--c:${catColor(n.category)}">${svg(ICON.repeat, 16)}
        <div><strong>${esc(n.title)}</strong><p>${esc(Recur.label(n.repeat, n.due_date))} 반복 · 다음 일정 ${fmtDay(n.due_date)}</p></div>
      </div>`).join("")}</div>` : empty("calendar", "일정이 없습니다")}`;
}

function renderShopping() {
  const notes = sortedNotes().filter((n) => n.items.length || (n.category === "shopping" && !n.done));
  if (!notes.length) return empty("cart", S.q ? "검색 결과가 없습니다" : "살 것이 없습니다");
  const all = notes.flatMap((n) => n.items);
  const total = all.length;
  const done = all.filter((i) => i.checked).length;
  const byChecked = (a, b) => a.checked - b.checked;
  const head = `
    <div class="shop-bar">
      <div class="seg" role="group" aria-label="보기 방식">
        <button type="button" data-shopmode="section" class="${S.shopMode === "section" ? "on" : ""}">구역별</button>
        <button type="button" data-shopmode="note" class="${S.shopMode === "note" ? "on" : ""}">메모별</button>
      </div>
      <button class="btn ghost" data-act="clear-checked" ${done ? "" : "disabled"}>완료 항목 지우기</button>
    </div>
    ${total ? `<div class="progress">
      <div class="progress-head"><strong>${total - done}개 남음</strong><span>${total}개 중 ${done}개 완료</span></div>
      <div class="bar"><i style="width:${Math.round((done / total) * 100)}%"></i></div>
    </div>` : ""}`;
  const memoOnly = notes.filter((n) => !n.items.length).map((n) => `
    <div class="shop-group" data-id="${n.id}"><h3>${esc(n.title)}${dueLabel(n)}</h3><p class="content">${linkify(n.content)}</p></div>`).join("");
  if (S.shopMode === "note") {
    return head + `<div class="list">${notes.filter((n) => n.items.length).map((n) => `
      <div class="shop-group" data-id="${n.id}">
        <h3>${esc(n.title)}${dueLabel(n)}${repeatLabel(n)}</h3>
        ${itemList([...n.items].sort(byChecked))}
      </div>`).join("")}${memoOnly}</div>`;
  }
  // 구역별: 마트 동선대로 (채소 → 정육 → 냉장 …)
  const sections = S.config.sections || ["기타"];
  const groups = sections
    .map((sec) => [sec, all.filter((i) => (sections.includes(i.section) ? i.section : "기타") === sec)])
    .filter(([, l]) => l.length);
  return head + `<div class="list">${groups.map(([sec, l]) => `
    <div class="shop-group"><h3>${esc(sec)}<span class="count">${l.filter((i) => !i.checked).length || ""}</span></h3>${itemList([...l].sort(byChecked))}</div>`).join("")}${memoOnly}</div>`;
}

// ------------------------------------------------------------ 동작
$("#view").addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("a")) return; // 링크는 그대로 열기
  const chip = t.closest("[data-filter]");
  if (chip) { S.filter = chip.dataset.filter; return render(); }
  const tag = t.closest("[data-tag]");
  if (tag) return setSearch(tag.dataset.tag);
  const mode = t.closest("[data-shopmode]");
  if (mode) { S.shopMode = mode.dataset.shopmode; store.set("memo_shop", S.shopMode); return render(); }
  const calBtn = t.closest("[data-cal]");
  if (calBtn) {
    const c = calBtn.dataset.cal;
    if (c === "today") { S.calMonth = firstOfMonth(new Date()); S.calSel = todayStr(); }
    else S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + Number(c), 1);
    return render();
  }
  const day = t.closest("[data-date]");
  if (day) { S.calSel = day.dataset.date; return render(); }

  const actEl = t.closest("[data-act]");
  if (!actEl) return;
  const act = actEl.dataset.act;
  if (act === "cat" || act === "done") return; // change 이벤트에서 처리
  if (act === "toggle-done") { S.showDone = !S.showDone; return render(); }
  if (act === "clear-checked") {
    if (confirm("체크한 항목을 지울까요? 반복하는 장보기 목록은 체크만 풀립니다.")) mutate({ type: "clear" });
    return;
  }
  const el = actEl.closest("[data-id]");
  const n = el && S.notes.get(Number(el.dataset.id));
  if (!n) return;
  switch (act) {
    case "menu": S.menu = S.menu === n.id ? null : n.id; return render();
    case "edit": S.menu = null; S.editing = n.id; return render();
    case "cancel": S.editing = null; return render();
    case "save": return saveEdit(el, n);
    case "pin": S.menu = null; mutate({ type: "note", id: n.id, body: { pinned: !n.pinned } }); return;
    case "tomorrow": return postpone(n);
    case "reclassify": S.menu = null; render(); return reclassify(n);
    case "delete": return removeNote(n);
  }
});

$("#view").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.item) return mutate({ type: "item", id: Number(t.dataset.item), checked: t.checked });
  const el = t.closest("[data-id]");
  const n = el && S.notes.get(Number(el.dataset.id));
  if (!n) return;
  if (t.dataset.act === "done") return toggleDone(n, t.checked);
  if (t.dataset.act === "cat") return mutate({ type: "note", id: n.id, body: { category: t.value } });
});

$("#view").addEventListener("input", (e) => { if (e.target.classList.contains("edit-area")) autoGrow(e.target); });
$("#view").addEventListener("keydown", (e) => {
  if (e.target.classList.contains("edit-area") && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.target.closest(".card").querySelector('[data-act="save"]').click();
  }
});

function saveEdit(el, n) {
  const content = el.querySelector(".edit-area").value.trim();
  const date = el.querySelector(".edit-date").value;
  const time = date ? el.querySelector(".edit-time").value : "";
  const rep = el.querySelector(".edit-repeat").value;
  if (!content) return toast("내용을 입력하세요");
  const body = {};
  if (content !== n.content) body.content = content;
  if (date !== (n.due_date || "") || time !== (n.due_time || "") || rep !== repeatKey(n.repeat)) {
    if (!date && !rep) body.clear_due = true;
    else {
      body.due_date = date;
      body.due_time = time;
      body.repeat = rep === "keep" ? n.repeat : rep ? REPEATS.find(([k]) => k === rep)[2] : null;
    }
  }
  S.editing = null;
  if (Object.keys(body).length) mutate({ type: "note", id: n.id, body });
  else render();
}

function toggleDone(n, done) {
  if (done && n.repeat && n.due_date) {
    const prev = n.due_date;
    mutate({ type: "note", id: n.id, body: { done: true }, from: prev });
    toast(`완료! 다음 일정은 ${fmtDay(n.due_date)}`, {
      action: "되돌리기", onAction: () => mutate({ type: "note", id: n.id, body: { due_date: prev } }),
    });
  } else mutate({ type: "note", id: n.id, body: { done } });
}

function postpone(n) {
  S.menu = null;
  const prev = n.due_date;
  mutate({ type: "note", id: n.id, body: { due_date: addDays(todayStr(), 1) } });
  toast("내일로 미뤘습니다", {
    action: "되돌리기",
    onAction: () => mutate({ type: "note", id: n.id, body: prev ? { due_date: prev } : { clear_due: true } }),
  });
}

function removeNote(n) {
  S.menu = null;
  const snapshot = JSON.parse(JSON.stringify(n));
  mutate({ type: "delete", id: n.id });
  toast("휴지통으로 옮겼습니다", {
    action: "되돌리기",
    onAction: () => {
      const i = queue.findIndex((o) => o.type === "delete" && o.id === n.id);
      if (i >= 0 && queue[i] !== inflight) { // 아직 안 보냈으면 취소만
        queue.splice(i, 1);
        saveQueue();
        S.notes.set(n.id, snapshot);
        changed();
      } else mutate({ type: "restore", id: n.id, note: snapshot });
    },
  });
}

async function reclassify(n) {
  try {
    await api(`/api/notes/${n.id}/reclassify`, { method: "POST" });
    toast("다시 분류하는 중…");
  } catch (err) {
    toast(err.offline ? "연결된 뒤에 다시 시도해 주세요" : err.message);
  }
}

// 메뉴 바깥을 누르거나 Esc 로 닫기
document.addEventListener("click", (e) => {
  if (S.menu !== null && !e.target.closest('.menu, [data-act="menu"]')) { S.menu = null; render(); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || $("#settings").open) return;
  if (S.menu !== null) { S.menu = null; render(); }
  else if (S.editing !== null) { S.editing = null; render(); }
});

// ------------------------------------------------------------ 설정: 알림
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
  if (NATIVE) { // 앱은 자체 알림을 쓴다
    const on = native("notificationStatus") === "on";
    status.textContent = on ? "켜짐 — 앱을 닫아도 일정·마감 알림이 옵니다." : "꺼져 있습니다. '알림 설정'에서 켜 주세요.";
    btn.hidden = false;
    btn.textContent = "알림 설정";
    btn.classList.toggle("primary", !on);
    return;
  }
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
  if (NATIVE) return native("openNotificationSettings");
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
$("#push-test").addEventListener("click", async () => {
  try {
    const { devices } = await api("/api/push/test", { method: "POST" });
    toast(devices ? `알림을 켠 기기 ${devices}대로 보냈습니다` : "알림을 켠 기기가 없어 화면 안에만 표시했습니다");
  } catch (err) { toast(err.message); }
});

// ------------------------------------------------------------ 설정: 백업·휴지통
$("#open-settings").addEventListener("click", async () => {
  try {
    const [settings, data, trash] = await Promise.all([api("/api/settings"), api("/api/data"), api("/api/trash")]);
    fillSettings(settings);
    renderPushState();
    renderData(data);
    renderTrash(trash);
    renderAppSection();
    $("#settings").showModal();
  } catch (err) {
    toast(err.offline ? "오프라인에서는 설정을 열 수 없습니다" : err.message);
  }
});
$("#settings-close").addEventListener("click", () => $("#settings").close());

// 앱 전용: 서버 주소, 배터리 사용 제한
function renderAppSection() {
  $("#sec-app").hidden = !NATIVE;
  if (!NATIVE) return;
  $("#app-server").textContent = native("serverUrl") || location.origin;
  $("#app-battery-row").hidden = native("batteryOptimized") !== true;
}
$("#app-change-server").addEventListener("click", () => native("changeServer"));
$("#app-battery").addEventListener("click", () => native("requestBatteryException"));
// 휴대폰 설정 화면에서 돌아오면 상태를 다시 표시
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && NATIVE && $("#settings").open) { renderPushState(); renderAppSection(); }
});

// 안드로이드 뒤로 가기: 열린 창·메뉴부터 닫는다. 처리했으면 true (아니면 앱이 닫힘)
window.AIMemoBack = () => {
  if ($("#settings").open) { $("#settings").close(); return true; }
  if (S.menu !== null || S.editing !== null) { S.menu = null; S.editing = null; render(); return true; }
  if (!$("#app").hidden && S.view !== "all") { setView("all"); return true; }
  return false;
};
$("#settings").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function renderData(d) {
  const last = d.last_backup ? new Date(d.last_backup) : null;
  $("#backup-status").textContent = `매일 한 번, 최근 ${d.backup_keep}개 보관 · ${
    last ? `마지막 ${last.getMonth() + 1}월 ${last.getDate()}일 ${pad(last.getHours())}:${pad(last.getMinutes())}` : "아직 없음"}`;
  $("#backup-dir").textContent = d.backup_dir;
}
$("#backup-now").addEventListener("click", async () => {
  try { renderData(await api("/api/backup", { method: "POST", timeout: 60000 })); toast("백업했습니다"); }
  catch (err) { toast(err.message); }
});

$("#export").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/export", { headers: S.token ? { Authorization: `Bearer ${S.token}` } : {} });
    if (!res.ok) throw new Error();
    const name = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || "ai-memo.json";
    if (NATIVE) return toast(native("saveFile", name, await res.text()) || "저장하지 못했습니다"); // 앱은 다운로드 폴더에 저장
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await res.blob()), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch {
    toast("내보내지 못했습니다");
  }
});
$("#import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data = null;
  try { data = JSON.parse(await file.text()); } catch {}
  if (!data || !Array.isArray(data.notes)) return toast("AI 메모에서 내보낸 파일이 아닙니다");
  if (!confirm(`메모 ${data.notes.length}개를 가져올까요? 이미 있는 메모는 건너뜁니다.`)) return;
  try {
    const r = await api("/api/import", { method: "POST", body: { notes: data.notes, settings: data.settings || null }, timeout: 120000 });
    toast(`${r.added}개를 가져왔습니다${r.skipped ? ` (${r.skipped}개는 건너뜀)` : ""}`);
    renderData(await api("/api/data"));
    reload();
  } catch (err) { toast(err.message); }
});

function renderTrash(list) {
  const box = $("#trash");
  if (!list.length) {
    box.innerHTML = `<p class="muted">비어 있습니다. 삭제한 메모는 30일 동안 여기에 보관됩니다.</p>`;
    return;
  }
  box.innerHTML = `<ul class="trash">${list.map((n) => `
    <li><div><strong>${esc(n.title)}</strong><p>${ago(n.deleted_at)} 삭제</p></div>
    <button class="btn" type="button" data-restore="${n.id}">복원</button></li>`).join("")}</ul>
    <button class="btn ghost danger" type="button" id="trash-empty">휴지통 비우기</button>`;
}
$("#trash").addEventListener("click", async (e) => {
  const r = e.target.closest("[data-restore]");
  try {
    if (r) {
      update(await api(`/api/notes/${r.dataset.restore}/restore`, { method: "POST" }));
      renderTrash(await api("/api/trash"));
      toast("복원했습니다");
    } else if (e.target.closest("#trash-empty") && confirm("휴지통의 메모를 모두 영구 삭제할까요?")) {
      await api("/api/trash", { method: "DELETE" });
      renderTrash([]);
      toast("휴지통을 비웠습니다");
    }
  } catch (err) { toast(err.message); }
});

// ------------------------------------------------------------ 알림 배너·토스트
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

function toast(msg, { action, onAction, duration } = {}) {
  const t = $("#toast");
  ($("#settings").open ? $("#settings") : document.body).append(t); // 설정 창이 열려 있으면 그 위에 표시
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
  if (action) {
    t.querySelector("button").addEventListener("click", () => {
      t.hidden = true;
      clearTimeout(toast.timer);
      onAction();
    });
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), duration || (action ? 6000 : 2400));
}

// ------------------------------------------------------------ PWA
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
