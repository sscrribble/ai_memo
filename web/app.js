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
  es: null,
};
const OUTBOX_KEY = "memo_outbox";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

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
  $("#ai-hint").textContent = S.config.ai ? "✨ AI 자동 분류" : "규칙 기반 분류 (AI 키 없음)";
  setView(S.view);
  await reload();
  connect();
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
function connect() {
  S.es?.close();
  const es = new EventSource(`/api/events${S.token ? `?token=${encodeURIComponent(S.token)}` : ""}`);
  S.es = es;
  es.addEventListener("hello", () => {
    $("#sync").className = "sync on";
    flushOutbox();
    reload(); // 끊겼던 동안의 변경사항 반영
  });
  es.addEventListener("note", (e) => update(JSON.parse(e.data)));
  es.addEventListener("delete", (e) => {
    S.notes.delete(JSON.parse(e.data).id);
    render();
  });
  es.onerror = () => { $("#sync").className = "sync off"; }; // 브라우저가 자동 재연결
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.token !== null && !$("#app").hidden) {
    if (!S.es || S.es.readyState === EventSource.CLOSED) connect();
  }
});
window.addEventListener("online", () => { flushOutbox(); connect(); });

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
$("#compose-text").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = e.target.scrollHeight + "px";
});
$("#compose-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#compose").requestSubmit();
});

$("#search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); render(); });

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
});
function setView(v) {
  S.view = v;
  localStorage.setItem("memo_view", v);
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  render();
}

// ------------------------------------------------------------ 렌더링
const CAT_COLOR = (c) => `var(--c-${c === "pending" ? "other" : c})`;

function matches(n) {
  if (!S.q) return true;
  return [n.content, n.title, ...n.tags, ...n.items.map((i) => i.name)].join(" ").toLowerCase().includes(S.q);
}
function sortedNotes() {
  return [...S.notes.values()].filter(matches).sort((a, b) => (b.created_at > a.created_at ? 1 : b.created_at < a.created_at ? -1 : b.id - a.id));
}

function dueLabel(n) {
  if (!n.due_date) return "";
  const today = ymd(new Date());
  const d = new Date(n.due_date + "T00:00:00");
  const diff = Math.round((d - new Date(today + "T00:00:00")) / 86400000);
  const word = diff === 0 ? "오늘" : diff === 1 ? "내일" : diff === -1 ? "어제" : `${d.getMonth() + 1}/${d.getDate()}(${"일월화수목금토"[d.getDay()]})`;
  const cls = n.done ? "" : diff < 0 ? "overdue" : diff === 0 ? "today" : "";
  return `<span class="due ${cls}">📅 ${word}${n.due_time ? " " + n.due_time : ""}</span>`;
}

function badge(n) {
  if (n.category === "pending") return `<span class="badge pending">AI 분류 중…</span>`;
  const opts = Object.entries(S.config.categories)
    .map(([k, v]) => `<option value="${k}" ${k === n.category ? "selected" : ""}>${v}</option>`).join("");
  return `<select class="badge" data-act="cat" style="--c:${CAT_COLOR(n.category)}" title="분류 바꾸기">${opts}</select>`;
}

function card(n) {
  const isTask = n.category === "todo" || (n.due_date && n.category !== "shopping");
  const editing = S.editing === n.id;
  const items = n.items.length ? `<ul class="items">${n.items.map((i) => `
      <li><label><input type="checkbox" class="check" data-item="${i.id}" ${i.checked ? "checked" : ""}>
      <span>${esc(i.name)} ${i.quantity ? `<span class="qty">${esc(i.quantity)}</span>` : ""}</span></label></li>`).join("")}</ul>` : "";
  return `
  <article class="card ${n.done ? "done" : ""}" data-id="${n.id}">
    <div class="card-head">
      ${isTask ? `<input type="checkbox" class="check" data-act="done" ${n.done ? "checked" : ""} title="완료">` : ""}
      ${badge(n)}
      <span class="title">${esc(n.title)}</span>
      ${dueLabel(n)}
    </div>
    ${editing
      ? `<textarea class="edit-area">${esc(n.content)}</textarea>
         <div class="actions"><button data-act="cancel">취소</button><button data-act="save" class="btn small primary">저장</button></div>`
      : `${n.content !== n.title ? `<p class="content">${esc(n.content)}</p>` : ""}
         ${items}
         ${n.tags.length ? `<div class="tags">${n.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
         <div class="actions">
           <button data-act="edit">편집</button>
           <button data-act="date">날짜</button>
           <button data-act="reclassify" title="AI로 다시 분류">재분류</button>
           <button data-act="delete" class="del">삭제</button>
         </div>`}
  </article>`;
}

function render() {
  if (!S.config) return;
  const v = $("#view");
  const fns = { all: renderAll, todo: renderTodo, calendar: renderCalendar, shopping: renderShopping };
  v.innerHTML = (fns[S.view] || renderAll)();
  if (S.editing) v.querySelector(".edit-area")?.focus();
}

function renderAll() {
  const notes = sortedNotes();
  const counts = {};
  notes.forEach((n) => (counts[n.category] = (counts[n.category] || 0) + 1));
  const chips = [["", `전체 ${notes.length}`], ...Object.entries(S.config.categories)
    .filter(([k]) => counts[k]).map(([k, label]) => [k, `${label} ${counts[k]}`])]
    .map(([k, label]) => `<button class="chip ${S.filter === k ? "active" : ""}" data-filter="${k}">${label}</button>`).join("");
  const list = notes.filter((n) => !S.filter || n.category === S.filter);
  return `<div class="chips">${chips}</div>
    ${list.length ? `<div class="list">${list.map(card).join("")}</div>` : `<div class="empty">메모가 없습니다</div>`}`;
}

function renderTodo() {
  const today = ymd(new Date());
  const tasks = sortedNotes().filter((n) => n.category === "todo" || (n.due_date && n.category !== "shopping"));
  const open = tasks.filter((n) => !n.done).sort((a, b) =>
    (a.due_date || "9999") + (a.due_time || "99") < (b.due_date || "9999") + (b.due_time || "99") ? -1 : 1);
  const groups = [
    ["지난 일", open.filter((n) => n.due_date && n.due_date < today)],
    ["오늘", open.filter((n) => n.due_date === today)],
    ["예정", open.filter((n) => n.due_date && n.due_date > today)],
    ["날짜 없음", open.filter((n) => !n.due_date)],
    ["완료", tasks.filter((n) => n.done)],
  ].filter(([, l]) => l.length);
  if (!groups.length) return `<div class="empty">할 일이 없습니다 🎉</div>`;
  return groups.map(([t, l]) => `<div class="section-title">${t} · ${l.length}</div><div class="list">${l.map(card).join("")}</div>`).join("");
}

function renderCalendar() {
  const m = S.calMonth;
  const start = new Date(m.getFullYear(), m.getMonth(), 1 - m.getDay());
  const today = ymd(new Date());
  const byDate = {};
  sortedNotes().filter((n) => n.due_date).forEach((n) => (byDate[n.due_date] ||= []).push(n));
  Object.values(byDate).forEach((l) => l.sort((a, b) => (a.due_time || "99") < (b.due_time || "99") ? -1 : 1));
  let cells = "일월화수목금토".split("").map((d) => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    if (i === 35 && d.getMonth() !== m.getMonth()) break;
    const key = ymd(d);
    const evs = byDate[key] || [];
    cells += `<button class="day ${d.getMonth() !== m.getMonth() ? "other" : ""} ${key === today ? "today" : ""} ${key === S.calSel ? "sel" : ""}" data-date="${key}">
      <span class="num">${d.getDate()}</span>
      ${evs.slice(0, 3).map((n) => `<span class="ev ${n.done ? "done" : ""}" style="--c:${CAT_COLOR(n.category)}">${n.due_time ? n.due_time + " " : ""}${esc(n.title)}</span>`).join("")}
      ${evs.length > 3 ? `<span class="more">+${evs.length - 3}</span>` : ""}
      ${evs.length ? `<span class="dots">${evs.slice(0, 4).map((n) => `<i style="--c:${CAT_COLOR(n.category)}"></i>`).join("")}</span>` : ""}
    </button>`;
  }
  const sel = byDate[S.calSel] || [];
  const selD = new Date(S.calSel + "T00:00:00");
  return `
    <div class="cal-head">
      <button class="btn" data-cal="-1" aria-label="이전 달">‹</button>
      <h2>${m.getFullYear()}년 ${m.getMonth() + 1}월</h2>
      <div><button class="btn small" data-cal="today">오늘</button> <button class="btn" data-cal="1" aria-label="다음 달">›</button></div>
    </div>
    <div class="cal">${cells}</div>
    <div class="section-title">${selD.getMonth() + 1}월 ${selD.getDate()}일 (${"일월화수목금토"[selD.getDay()]}) · ${sel.length}건</div>
    ${sel.length ? `<div class="list">${sel.map(card).join("")}</div>` : `<div class="empty">일정이 없습니다</div>`}`;
}

function renderShopping() {
  const notes = sortedNotes().filter((n) => n.items.length || (n.category === "shopping" && !n.done));
  const total = notes.reduce((a, n) => a + n.items.length, 0);
  const left = notes.reduce((a, n) => a + n.items.filter((i) => !i.checked).length, 0);
  if (!notes.length) return `<div class="empty">살 것이 없습니다</div>`;
  const groups = notes.map((n) => `
    <div class="shop-group" data-id="${n.id}">
      <h3>${esc(n.title)} ${dueLabel(n)}</h3>
      ${n.items.length ? `<ul class="items">${[...n.items].sort((a, b) => a.checked - b.checked).map((i) => `
        <li><label><input type="checkbox" class="check" data-item="${i.id}" ${i.checked ? "checked" : ""}>
        <span>${esc(i.name)} ${i.quantity ? `<span class="qty">${esc(i.quantity)}</span>` : ""}</span></label></li>`).join("")}</ul>`
        : `<p class="content">${esc(n.content)}</p>`}
    </div>`).join("");
  return `
    <div class="shop-bar">
      <span class="hint">남은 항목 ${left} / ${total}</span>
      <button class="btn small" data-act="clear-checked" ${total - left ? "" : "disabled"}>체크한 항목 지우기</button>
    </div>
    <div class="list">${groups}</div>`;
}

// ------------------------------------------------------------ 동작
$("#view").addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset.filter !== undefined) { S.filter = t.dataset.filter; return render(); }
  const calBtn = t.closest("[data-cal]");
  if (calBtn) {
    const c = calBtn.dataset.cal;
    if (c === "today") { S.calMonth = firstOfMonth(new Date()); S.calSel = ymd(new Date()); }
    else S.calMonth = new Date(S.calMonth.getFullYear(), S.calMonth.getMonth() + Number(c), 1);
    return render();
  }
  const day = t.closest("[data-date]");
  if (day) { S.calSel = day.dataset.date; return render(); }

  const act = t.dataset.act;
  if (act === "clear-checked") {
    if (confirm("체크한 항목을 지울까요?")) await api("/api/shopping/clear-checked", { method: "POST" }).catch((err) => toast(err.message));
    return;
  }
  const el = t.closest("[data-id]");
  if (!el || !act || act === "cat" || act === "done") return;
  const id = Number(el.dataset.id);
  const n = S.notes.get(id);
  try {
    if (act === "edit") { S.editing = id; render(); }
    else if (act === "cancel") { S.editing = null; render(); }
    else if (act === "save") {
      const content = el.querySelector(".edit-area").value;
      S.editing = null;
      update(await api(`/api/notes/${id}`, { method: "PATCH", body: { content } }));
    } else if (act === "delete") {
      if (!confirm("이 메모를 삭제할까요?")) return;
      await api(`/api/notes/${id}`, { method: "DELETE" });
      S.notes.delete(id);
      render();
    } else if (act === "reclassify") {
      await api(`/api/notes/${id}/reclassify`, { method: "POST" });
      toast("다시 분류하는 중…");
    } else if (act === "date") {
      const cur = n.due_date ? `${n.due_date}${n.due_time ? " " + n.due_time : ""}` : "";
      const input = prompt("날짜 (예: 2026-12-24 14:00). 비우면 날짜 삭제", cur);
      if (input === null) return;
      const m = input.trim().match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?$/);
      if (input.trim() && !m) return toast("형식: YYYY-MM-DD HH:MM");
      const body = m ? { due_date: m[1], due_time: m[2] ? m[2].padStart(5, "0") : "" } : { clear_due: true };
      update(await api(`/api/notes/${id}`, { method: "PATCH", body }));
    }
  } catch (err) { toast(err.message); }
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

// 더 최신(rev 큰) 상태만 반영
function update(n) {
  const cur = S.notes.get(n.id);
  if (cur && cur.rev > n.rev) return;
  S.notes.set(n.id, n);
  render();
}

// ------------------------------------------------------------ PWA
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot().catch(() => toast("서버에 연결할 수 없습니다"));
