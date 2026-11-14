'use strict';
/* 情報処理安全確保支援士 午後問題 演習アプリ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const DATA_CACHE = 'sc-data-v1';
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------------ IndexedDB (解答・マーキングの保存) */
const DB = (() => {
  let dbp = null;
  const mem = new Map();
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const rq = indexedDB.open('sc-pm', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
      } catch { res(null); }
    });
    return dbp;
  }
  async function get(key) {
    const db = await open();
    if (!db) return mem.get(key);
    return new Promise((res) => {
      const rq = db.transaction('kv').objectStore('kv').get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(undefined);
    });
  }
  async function set(key, val) {
    const db = await open();
    if (!db) { mem.set(key, val); return; }
    return new Promise((res) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
  return { get, set };
})();

/* ------------------------------------------------------------------ 状態 */
let EXAMS = [];
const cur = {
  exam: null, session: null, problem: null,
  answers: {}, limits: {}, marks: {}, scores: {},
  pages: [],            // {name, el, canvas, ctx, active}
  undo: [],
  tool: 'none', color: '#ffe74a',
  zoom: 1,
  showAnswer: false, showReview: false, showScore: false, showOriginal: false,
};
let fingerDraw = LS.get('fingerDraw', true);
let fingerPrefSet = LS.get('fingerPrefSet', false);

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => { t.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ TOP 画面 */
function fillSelect(sel, items, value) {
  sel.innerHTML = '';
  for (const [v, label] of items) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
  if (value != null && items.some(([v]) => String(v) === String(value))) sel.value = value;
}
const selExam = () => EXAMS.find((e) => e.id === $('#selExam').value);
const selSession = () => selExam().sessions.find((s) => s.id === $('#selSession').value);

function initHome() {
  const last = LS.get('last', {});
  fillSelect($('#selExam'), EXAMS.map((e) => [e.id, e.label]), last.exam);
  const onExam = () => {
    fillSelect($('#selSession'), selExam().sessions.map((s) => [s.id, s.label]), last.session);
    onSession();
  };
  const onSession = () => {
    fillSelect($('#selProblem'), selSession().problems.map((p) => [p.no, `問${p.no}`]), last.no);
    refreshProblemStatus();
  };
  $('#selExam').onchange = onExam;
  $('#selSession').onchange = onSession;
  $('#selProblem').onchange = refreshProblemStatus;
  onExam();
  if (last.session) {
    const f = findSession(last.session);
    if (f) $('#resumeInfo').textContent = `前回: ${f.exam.label} ${f.session.label} 問${last.no}`;
  }
  $('#btnStart').onclick = () => {
    location.hash = `#${$('#selSession').value}/${$('#selProblem').value}`;
  };
  $('#btnSaveExam').onclick = () => saveOffline(selExam().sessions);
  $('#btnSaveAll').onclick = () => {
    const total = EXAMS.flatMap((e) => e.sessions).reduce((a, s) => a + s.bytes, 0);
    if (confirm(`全年度の問題データ (約 ${(total / 1e6).toFixed(0)} MB) を保存します。Wi-Fi 接続での実行をおすすめします。`)) {
      saveOffline(EXAMS.flatMap((e) => e.sessions));
    }
  };
  $('#btnClearOffline').onclick = async () => {
    if (!confirm('保存した問題データを削除します (解答とマーキングは消えません)。')) return;
    await caches.delete(DATA_CACHE);
    refreshOffline();
  };
  const net = () => { $('#netState').textContent = navigator.onLine ? '' : '現在オフラインです'; };
  addEventListener('online', net); addEventListener('offline', net); net();
  refreshOffline();
}

/* 選択中の区分の各問について、解答状況を選択肢と状況欄に表示する */
async function refreshProblemStatus() {
  const session = selSession();
  const sel = $('#selProblem');
  const stats = await Promise.all(session.problems.map(async (p) => {
    const key = `${session.id}:${p.no}`;
    const [a, sc] = await Promise.all([DB.get('a:' + key), DB.get('s:' + key)]);
    const filled = p.fields.filter((_, i) => a && (a[i] || '').trim()).length;
    let earned = 0, total = 0, judged = 0;
    for (const v of Object.values(sc || {})) {
      total += v.p || 0;
      if (v.j) judged++;
      earned += earnedOf(v);
    }
    return { no: p.no, filled, all: p.fields.length, earned, total, judged };
  }));
  if (selSession() !== session) return;           // 待っている間に選択が変わった
  for (const st of stats) {
    const o = [...sel.options].find((x) => +x.value === st.no);
    if (!o) continue;
    const mark = st.filled === 0 ? '' : st.filled === st.all ? '　✔ 解答済み' : `　✎ 解答中 ${st.filled}/${st.all}`;
    o.textContent = `問${st.no}${mark}`;
  }
  const st = stats.find((x) => x.no === +sel.value);
  const box = $('#probStatus');
  if (!st) { box.textContent = ''; return; }
  const score = st.judged || st.total ? ` ／ 得点 ${st.earned} / ${st.total} 点` : '';
  box.className = 'status' + (st.filled === 0 ? '' : st.filled === st.all ? ' done' : ' part');
  box.textContent = (st.filled === 0 ? `未解答 (解答欄 ${st.all})`
    : st.filled === st.all ? `✔ 解答済み (${st.all}/${st.all} 欄)`
      : `✎ 解答中 (${st.filled}/${st.all} 欄に入力済み)`) + score;
}

function findSession(sid) {
  for (const exam of EXAMS) for (const session of exam.sessions) if (session.id === sid) return { exam, session };
  return null;
}

/* ------------------------------------------------------------------ オフライン保存 */
const dataUrl = (sid, name) => new URL(`data/${sid}/${name}`, location.href).href;

async function cachedUrls() {
  if (!('caches' in window)) return null;
  const c = await caches.open(DATA_CACHE);
  return new Set((await c.keys()).map((r) => r.url));
}

async function refreshOffline() {
  const set = await cachedUrls();
  const ul = $('#offlineList');
  ul.innerHTML = '';
  if (!set) {
    $('#dlStatus').textContent = 'この接続ではオフライン保存を利用できません (HTTPS または localhost で開いてください)。';
    $('#btnSaveExam').disabled = $('#btnSaveAll').disabled = true;
    return;
  }
  let done = 0, all = 0;
  for (const e of EXAMS) {
    let have = 0, total = 0;
    for (const s of e.sessions) for (const f of s.files) { total++; if (set.has(dataUrl(s.id, f))) have++; }
    all += total; done += have;
    const li = document.createElement('li');
    const st = have === total ? '保存済み' : have ? `一部 (${have}/${total})` : '未保存';
    li.innerHTML = `<span>${e.label}</span><span class="${have === total ? 'ok' : have ? 'part' : ''}">${st}</span>`;
    ul.appendChild(li);
  }
  let usage = '';
  if (navigator.storage && navigator.storage.estimate) {
    try { const est = await navigator.storage.estimate(); usage = ` / 使用量 約 ${(est.usage / 1e6).toFixed(0)} MB`; } catch { /* ignore */ }
  }
  $('#dlStatus').textContent = `保存済みページ: ${done} / ${all}${usage}`;
}

let saving = false;
async function saveOffline(sessions) {
  if (saving) return;
  if (!('caches' in window)) { toast('この接続ではオフライン保存を利用できません'); return; }
  saving = true;
  $('#btnSaveExam').disabled = $('#btnSaveAll').disabled = true;
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const cache = await caches.open(DATA_CACHE);
    const have = await cachedUrls();
    const todo = [];
    for (const s of sessions) for (const f of s.files) { const u = dataUrl(s.id, f); if (!have.has(u)) todo.push(u); }
    const bar = $('#dlProgress');
    bar.hidden = false;
    let n = 0, fail = 0;
    const step = () => {
      bar.firstElementChild.style.width = `${todo.length ? (n / todo.length) * 100 : 100}%`;
      $('#dlStatus').textContent = `保存中… ${n} / ${todo.length}`;
    };
    step();
    const queue = todo.slice();
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          const r = await fetch(u, { cache: 'no-cache' });
          if (!r.ok) throw new Error(r.status);
          await cache.put(u, r);
        } catch { fail++; }
        n++; step();
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    bar.hidden = true;
    toast(fail ? `${fail} 件の保存に失敗しました。通信環境を確認して再実行してください` : '保存が完了しました', 3500);
  } finally {
    saving = false;
    $('#btnSaveExam').disabled = $('#btnSaveAll').disabled = false;
    refreshOffline();
  }
}

/* ------------------------------------------------------------------ 画面切り替え */
function route() {
  const m = location.hash.match(/^#([\w-]+)\/(\d+)$/);
  const f = m && findSession(m[1]);
  const p = f && f.session.problems.find((x) => x.no === +m[2]);
  if (p) openProblem(f.exam, f.session, p);
  else showHome();
}

async function showHome() {
  await flushSave();
  $('#exam').hidden = true;
  $('#home').hidden = false;
  document.title = '支援士 午後問題';
  const last = LS.get('last', {});
  const f = last.session && findSession(last.session);
  if (f) $('#resumeInfo').textContent = `前回: ${f.exam.label} ${f.session.label} 問${last.no}`;
  refreshProblemStatus();
  refreshOffline();
}

async function openProblem(exam, session, problem) {
  flushSave();
  Object.assign(cur, { exam, session, problem, undo: [], showAnswer: false, showReview: false });
  LS.set('last', { exam: exam.id, session: session.id, no: problem.no });
  const key = `${session.id}:${problem.no}`;
  const [a, m, l, sc] = await Promise.all(['a:', 'm:', 'l:', 's:'].map((p) => DB.get(p + key)));
  if (cur.problem !== problem) return;
  cur.answers = a || {}; cur.marks = m || {}; cur.limits = l || {}; cur.scores = sc || {};

  $('#home').hidden = true;
  $('#exam').hidden = false;
  const title = `${exam.label} ${session.label} 問${problem.no}`;
  $('#examTitle').textContent = title;
  document.title = title;
  const idx = session.problems.indexOf(problem);
  $('#btnPrev').disabled = idx === 0;
  $('#btnNext').disabled = idx === session.problems.length - 1;
  applySplit();
  buildPages();
  buildSheet();
  setTool('none');
}

/* ------------------------------------------------------------------ 左右(上下)分割 */
const isVertical = () => getComputedStyle($('#split')).flexDirection === 'column';
function applySplit() {
  const v = isVertical();
  const r = LS.get(v ? 'splitV' : 'splitH', v ? 55 : 58);
  $('#split').style.setProperty('--split', r + '%');
}
function initDivider() {
  const d = $('#divider');
  let dragging = false;
  d.addEventListener('pointerdown', (e) => {
    dragging = true; d.classList.add('drag'); d.setPointerCapture(e.pointerId); e.preventDefault();
  });
  d.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rc = $('#split').getBoundingClientRect();
    const v = isVertical();
    let r = v ? (e.clientY - rc.top) / rc.height : (e.clientX - rc.left) / rc.width;
    r = Math.min(85, Math.max(15, r * 100));
    $('#split').style.setProperty('--split', r.toFixed(1) + '%');
    LS.set(v ? 'splitV' : 'splitH', +r.toFixed(1));
  });
  const end = () => { dragging = false; d.classList.remove('drag'); };
  d.addEventListener('pointerup', end);
  d.addEventListener('pointercancel', end);
  addEventListener('resize', () => { if (!$('#exam').hidden) applySplit(); });
}

/* ------------------------------------------------------------------ 問題冊子ページ */
let io = null;
function buildPages() {
  const box = $('#pages');
  box.innerHTML = '';
  box.scrollTop = 0;
  cur.pages = [];
  if (io) io.disconnect();
  io = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const pg = cur.pages.find((p) => p.el === en.target);
      if (!pg) continue;
      pg.active = en.isIntersecting;
      if (pg.active) sizeCanvas(pg); else { pg.canvas.width = pg.canvas.height = 0; }
    }
  }, { root: box, rootMargin: '120% 0px' });
  cur.problem.pages.forEach((name, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    const img = new Image();
    img.decoding = 'async';
    img.loading = i < 2 ? 'eager' : 'lazy';
    img.alt = `問題 ${i + 1}ページ`;
    img.onload = () => { el.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`; };
    img.onerror = () => {
      if (!$('.err', el)) {
        const e = document.createElement('div');
        e.className = 'err';
        e.textContent = 'このページを読み込めません。オフラインの場合は、オンライン時に TOP 画面の「オフライン保存」を実行してください。';
        el.appendChild(e);
      }
    };
    img.src = `data/${cur.session.id}/${name}`;
    const canvas = document.createElement('canvas');
    const pno = document.createElement('span');
    pno.className = 'pno';
    pno.textContent = `${i + 1} / ${cur.problem.pages.length}`;
    el.append(img, canvas, pno);
    box.appendChild(el);
    const pg = { name, el, canvas, ctx: canvas.getContext('2d'), active: false };
    cur.pages.push(pg);
    io.observe(el);
  });
  setZoom(LS.get('zoom', 1), false);
}

function sizeCanvas(pg) {
  const w = pg.el.clientWidth, h = pg.el.clientHeight;
  if (!w || !h) return;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  const MAX = 5e6;                         // iOS のメモリ対策
  if (w * h * dpr * dpr > MAX) dpr = Math.sqrt(MAX / (w * h));
  const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
  if (pg.canvas.width !== cw || pg.canvas.height !== ch) { pg.canvas.width = cw; pg.canvas.height = ch; }
  drawPage(pg);
}

function drawPage(pg, live) {
  const { canvas: c, ctx } = pg;
  if (!c.width) return;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const W = c.width;
  const strokes = (cur.marks[pg.name] || []).concat(live ? [live] : []);
  for (const s of strokes) {
    ctx.strokeStyle = ctx.fillStyle = s.c;
    ctx.lineWidth = s.w * W;
    ctx.lineCap = s.k === 'm' ? 'butt' : 'round';
    const p = s.p;
    ctx.beginPath();
    if (p.length === 2) {
      ctx.arc(p[0] * W, p[1] * W, (s.w * W) / 2, 0, 7);
      ctx.fill();
      continue;
    }
    ctx.moveTo(p[0] * W, p[1] * W);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * W, p[i + 1] * W);
    ctx.stroke();
  }
}
function redrawAll() { for (const pg of cur.pages) if (pg.active) sizeCanvas(pg); }

function setZoom(z, keep = true) {
  z = Math.min(4, Math.max(0.5, z));
  const box = $('#pages');
  const ratio = z / cur.zoom;
  const cx = box.scrollLeft + box.clientWidth / 2, top = box.scrollTop;
  cur.zoom = z;
  for (const pg of cur.pages) pg.el.style.width = `${z * 100}%`;
  $('#zoomLabel').textContent = `${Math.round(z * 100)}%`;
  if (keep) {
    box.scrollTop = top * ratio;
    box.scrollLeft = cx * ratio - box.clientWidth / 2;
    LS.set('zoom', z);
  }
  clearTimeout(setZoom.tm);
  setZoom.tm = setTimeout(redrawAll, 120);
}

/* ------------------------------------------------------------------ マーキング */
const WIDTH = { marker: 0.021, pen: 0.0032 };
let stroke = null;   // {pg, s, id, erased}

function setTool(tool, color) {
  cur.tool = tool;
  if (color) cur.color = color;
  for (const b of $$('#markbar .tool')) {
    b.classList.toggle('on', b.dataset.tool === tool && (!b.dataset.color || b.dataset.color === cur.color || tool === 'eraser'));
  }
  $('#pages').classList.toggle('drawing', tool !== 'none');
}

function pagePoint(pg, x, y) {
  const r = pg.el.getBoundingClientRect();
  const nx = Math.min(1, Math.max(0, (x - r.left) / r.width));
  const ny = Math.min(r.height / r.width, Math.max(0, (y - r.top) / r.width));
  return [nx, ny];
}
function pushUndo(pg) {
  cur.undo.push({ name: pg.name, prev: (cur.marks[pg.name] || []).slice() });
  if (cur.undo.length > 100) cur.undo.shift();
}
function eraseAt(pg, x, y) {
  const list = cur.marks[pg.name];
  if (!list || !list.length) return;
  const keep = list.filter((s) => {
    const r = 0.012 + s.w / 2, p = s.p;
    if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y) > r;
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (distSeg(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= r) return false;
    }
    return true;
  });
  if (keep.length !== list.length) {
    if (!stroke.erased) { pushUndo(pg); stroke.erased = true; }
    cur.marks[pg.name] = keep;
    drawPage(pg);
    saveMarks();
  }
}
function distSeg(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function beginStroke(target, x, y, id) {
  const el = target.closest && target.closest('.page');
  const pg = el && cur.pages.find((p) => p.el === el);
  if (!pg) return false;
  if (!pg.canvas.width) sizeCanvas(pg);
  const [nx, ny] = pagePoint(pg, x, y);
  if (cur.tool === 'eraser') {
    stroke = { pg, id, erased: false };
    eraseAt(pg, nx, ny);
  } else {
    const k = cur.tool === 'marker' ? 'm' : 'p';
    stroke = { pg, id, s: { k, c: cur.color, w: WIDTH[cur.tool], p: [nx, ny] } };
    drawPage(pg, stroke.s);
  }
  return true;
}
function moveStroke(x, y) {
  if (!stroke) return;
  const [nx, ny] = pagePoint(stroke.pg, x, y);
  if (!stroke.s) { eraseAt(stroke.pg, nx, ny); return; }
  const p = stroke.s.p;
  if (stroke.s.k === 'm') {                // マーカーは常に直線 (水平・垂直に近ければ吸着)
    let ex = nx, ey = ny;
    const dx = Math.abs(nx - p[0]), dy = Math.abs(ny - p[1]);
    if (dy <= dx * 0.27) ey = p[1];
    else if (dx <= dy * 0.27) ex = p[0];
    p.length = 2;
    p.push(ex, ey);
    drawPage(stroke.pg, stroke.s);
    return;
  }
  if (Math.hypot(nx - p[p.length - 2], ny - p[p.length - 1]) < 0.0015) return;
  p.push(nx, ny);
  drawPage(stroke.pg, stroke.s);
}
function endStroke(cancel) {
  if (!stroke) return;
  const { pg, s } = stroke;
  stroke = null;
  if (!s) return;
  const tooShort = s.k === 'm' && (s.p.length < 4 || Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]) < 0.008);
  if (cancel || tooShort) { drawPage(pg); return; }
  s.p = s.p.map((v) => +v.toFixed(4));
  pushUndo(pg);
  (cur.marks[pg.name] = cur.marks[pg.name] || []).push(s);
  drawPage(pg);
  saveMarks();
}

function initMarking() {
  const box = $('#pages');
  for (const b of $$('#markbar .tool')) b.onclick = () => setTool(b.dataset.tool, b.dataset.color);
  const chk = $('#chkFinger');
  chk.checked = fingerDraw;
  chk.onchange = () => { fingerDraw = chk.checked; fingerPrefSet = true; LS.set('fingerDraw', fingerDraw); LS.set('fingerPrefSet', true); };

  // タッチ / Apple Pencil
  box.addEventListener('touchstart', (e) => {
    if (cur.tool === 'none') return;
    if (e.touches.length > 1) { endStroke(true); return; }
    const t = e.changedTouches[0];
    const stylus = t.touchType === 'stylus';
    if (stylus && !fingerPrefSet) {         // Pencil を検出したら指はスクロール専用に
      fingerPrefSet = true; fingerDraw = false; chk.checked = false;
      LS.set('fingerDraw', false); LS.set('fingerPrefSet', true);
      toast('Apple Pencil を検出しました。指はスクロール、Pencil で描画します');
    }
    if (!stylus && !fingerDraw) return;
    if (beginStroke(t.target, t.clientX, t.clientY, t.identifier)) e.preventDefault();
  }, { passive: false });
  box.addEventListener('touchmove', (e) => {
    if (!stroke) return;
    const t = [...e.touches].find((x) => x.identifier === stroke.id);
    if (!t) return;
    e.preventDefault();
    moveStroke(t.clientX, t.clientY);
  }, { passive: false });
  const tend = (e) => {
    if (stroke && [...e.changedTouches].some((x) => x.identifier === stroke.id)) endStroke(e.type === 'touchcancel');
  };
  box.addEventListener('touchend', tend);
  box.addEventListener('touchcancel', tend);

  // マウス (PC)
  const hasTouch = 'ontouchstart' in window;
  box.addEventListener('pointerdown', (e) => {
    if (cur.tool === 'none' || e.button !== 0) return;
    if (e.pointerType !== 'mouse' && (hasTouch || e.pointerType !== 'pen')) return;
    if (beginStroke(e.target, e.clientX, e.clientY, 'ptr' + e.pointerId)) e.preventDefault();
  });
  addEventListener('pointermove', (e) => { if (stroke && stroke.id === 'ptr' + e.pointerId) moveStroke(e.clientX, e.clientY); });
  addEventListener('pointerup', (e) => { if (stroke && stroke.id === 'ptr' + e.pointerId) endStroke(false); });

  $('#btnUndo').onclick = () => {
    const u = cur.undo.pop();
    if (!u) { toast('これ以上戻せません'); return; }
    cur.marks[u.name] = u.prev;
    const pg = cur.pages.find((p) => p.name === u.name);
    if (pg) drawPage(pg);
    saveMarks();
  };
  $('#btnClearMarks').onclick = () => {
    if (!Object.values(cur.marks).some((a) => a.length)) return;
    if (!confirm('この問のマーキングをすべて消去しますか？')) return;
    cur.marks = {}; cur.undo = [];
    redrawAll(); saveMarks();
  };

  // 拡大縮小
  $('#btnZoomIn').onclick = () => setZoom(cur.zoom * 1.2);
  $('#btnZoomOut').onclick = () => setZoom(cur.zoom / 1.2);
  $('#btnZoomFit').onclick = () => setZoom(1);
  let gz = 1;
  box.addEventListener('gesturestart', (e) => { e.preventDefault(); gz = cur.zoom; endStroke(true); });
  box.addEventListener('gesturechange', (e) => { e.preventDefault(); setZoom(gz * e.scale); });
  box.addEventListener('gestureend', (e) => { e.preventDefault(); });
  box.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(cur.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  new ResizeObserver(() => {
    clearTimeout(initMarking.tm);
    initMarking.tm = setTimeout(() => { redrawAll(); autosizeAll(); }, 100);
  }).observe($('#left'));
}

/* ------------------------------------------------------------------ 解答用紙 */
const countChars = (s) => [...s.replace(/[\r\n]/g, '')].length;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function limitOf(i) {
  if (i in cur.limits) return cur.limits[i] || 0;
  return cur.problem.fields[i].limit || 0;
}
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}
function autosizeAll() { for (const ta of $$('#fields textarea')) autosize(ta); }

function updateCount(i) {
  const f = $(`#fields .field[data-i="${i}"]`);
  const ta = $('textarea', f), btn = $('.count', f);
  const n = countChars(ta.value), lim = limitOf(i);
  btn.innerHTML = lim ? `<b>${n}</b> / ${lim}字` : `<b>${n}</b>字`;
  const over = lim > 0 && n > lim;
  btn.classList.toggle('over', over);
  ta.classList.toggle('over', over);
}

function buildSheet() {
  const p = cur.problem;
  const box = $('#fields');
  box.innerHTML = '';
  let group = null, lastS = null;
  p.fields.forEach((f, i) => {
    if (f.s !== lastS) {
      group = document.createElement('section');
      group.className = 'setsumon';
      group.innerHTML = `<h3>設問${f.s || ''}</h3>`;
      box.appendChild(group);
      lastS = f.s;
    }
    const d = document.createElement('div');
    d.className = 'field';
    d.dataset.i = i;
    const label = f.path.join(' ');
    const isText = f.ans && countChars(f.ans) > 8;
    const model = f.ans
      ? `<span class="tag">解答例</span>${esc(f.ans)}<small>${isText && !f.ans.includes('\n') ? countChars(f.ans) + '字' : ''}${f.note ? ' 備考: ' + esc(f.note) : ''}</small>`
      : '<span class="tag">解答例</span>(図・表などによる解答です。「解答原本」ボタンで確認してください)';
    d.innerHTML = `
      <div class="field-head">
        <span class="lbl">${esc(label)}</span>
        <button class="one" title="この欄の解答例だけ表示/非表示">答</button>
        <button class="count" title="タップで字数制限を変更"></button>
      </div>
      <textarea rows="1" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      <div class="model" hidden>${model}</div>
      <div class="score" hidden>
        <button class="judge o" data-j="o" title="正解">〇</button>
        <button class="judge t" data-j="t" title="部分点">△</button>
        <button class="judge x" data-j="x" title="不正解">×</button>
        <label class="partial" hidden>部分点 <input class="part" type="number" inputmode="decimal" min="0" max="100" step="0.5"></label>
        <label>配点 <input class="pts" type="number" inputmode="numeric" min="0" max="100" step="1"> 点</label>
      </div>`;
    const ta = $('textarea', d);
    ta.value = cur.answers[i] || '';
    ta.addEventListener('input', () => {
      cur.answers[i] = ta.value;
      autosize(ta); updateCount(i); saveAnswers();
    });
    $('.one', d).onclick = () => { const m = $('.model', d); m.hidden = !m.hidden; };
    $('.count', d).onclick = () => {
      const v = prompt('この欄の字数制限 (0 または空欄で制限なし)', limitOf(i) || '');
      if (v === null) return;
      const n = parseInt(v, 10);
      cur.limits[i] = Number.isFinite(n) && n > 0 ? n : 0;
      DB.set(`l:${cur.session.id}:${p.no}`, cur.limits);
      updateCount(i);
    };
    const pts = $('.pts', d);
    if ((cur.scores[i] || {}).p != null) pts.value = cur.scores[i].p;
    pts.addEventListener('input', () => {
      const v = parseFloat(pts.value);
      const sc = cur.scores[i] = cur.scores[i] || {};
      if (Number.isFinite(v) && v >= 0) sc.p = v; else delete sc.p;
      saveScores(); updateScore();
    });
    const part = $('.part', d);
    if ((cur.scores[i] || {}).e != null) part.value = cur.scores[i].e;
    part.addEventListener('input', () => {
      const v = parseFloat(part.value);
      const sc = cur.scores[i] = cur.scores[i] || {};
      if (Number.isFinite(v) && v >= 0) sc.e = v; else delete sc.e;   // 空欄なら配点の半分
      saveScores(); updateScore();
    });
    for (const b of $$('.judge', d)) {
      b.onclick = () => {
        const sc = cur.scores[i] = cur.scores[i] || {};
        if (sc.j === b.dataset.j) delete sc.j; else sc.j = b.dataset.j;   // もう一度押すと解除
        saveScores(); updateScore();
      };
    }
    group.appendChild(d);
    updateCount(i);
  });
  $('#purposeBox').innerHTML = p.purpose
    ? `<h3>出題趣旨</h3>${p.purpose.split('\n').map((t) => `<p>${esc(t)}</p>`).join('')}` : '';
  $('#reviewBox').innerHTML = `<h3>採点講評</h3>${p.review.length ? p.review.map((t) => `<p>${esc(t)}</p>`).join('') : '<p>(講評データがありません)</p>'}`;
  $('#ansImages').innerHTML = '';
  setAnswerShown(false);
  setReviewShown(false);
  setScoreShown(false);
  setOriginalShown(false);
  updateScore();
  $('#sheet').scrollTop = 0;
  requestAnimationFrame(autosizeAll);
}

function setAnswerShown(on) {
  cur.showAnswer = on;
  $('#btnAnswer').classList.toggle('on', on);
  $('#btnAnswer').textContent = on ? '解答を隠す' : '解答表示';
  for (const m of $$('#fields .model')) m.hidden = !on;
  $('#purposeBox').hidden = !on || !cur.problem.purpose;
}
function setReviewShown(on) {
  cur.showReview = on;
  $('#btnReview').classList.toggle('on', on);
  $('#btnReview').textContent = on ? '講評を隠す' : '採点講評';
  $('#reviewBox').hidden = !on;
  if (on) $('#sheet').scrollTop = 0;
}

function setScoreShown(on) {
  cur.showScore = on;
  $('#btnScore').classList.toggle('on', on);
  $('#scoreBar').hidden = !on;
  for (const s of $$('#fields .score')) s.hidden = !on;
}
function setOriginalShown(on) {
  cur.showOriginal = on;
  $('#btnOriginal').classList.toggle('on', on);
  $('#ansOriginal').hidden = !on;
  if (!on) return;
  const imgs = $('#ansImages');
  if (!imgs.childElementCount) {
    for (const name of cur.problem.ansPages) {
      const im = new Image();
      im.alt = '解答例の原本';
      im.src = `data/${cur.session.id}/${name}`;
      imgs.appendChild(im);
    }
  }
  $('#sheet').scrollTop = 0;
}
function updateScore() {
  let earned = 0, total = 0, o = 0, t = 0, x = 0;
  cur.problem.fields.forEach((_, i) => {
    const sc = cur.scores[i] || {};
    const p = sc.p || 0;
    total += p;
    earned += earnedOf(sc);
    if (sc.j === 'o') o++; else if (sc.j === 't') t++; else if (sc.j === 'x') x++;
    const f = $(`#fields .field[data-i="${i}"]`);
    if (!f) return;
    f.classList.toggle('j-o', sc.j === 'o');
    f.classList.toggle('j-t', sc.j === 't');
    f.classList.toggle('j-x', sc.j === 'x');
    for (const b of $$('.judge', f)) b.classList.toggle('on', b.dataset.j === sc.j);
    $('.partial', f).hidden = sc.j !== 't';
    $('.part', f).placeholder = p ? String(p / 2) : '';
  });
  const fmt = (n) => String(Math.round(n * 10) / 10);
  $('#scoreEarned').textContent = fmt(earned);
  $('#scoreTotal').textContent = fmt(total);
  $('#scoreCount').textContent = `〇${o} △${t} ×${x} 未判定${cur.problem.fields.length - o - t - x}`;
}
/* 1 欄の得点: 〇=配点、△=入力した部分点 (未入力なら配点の半分、配点を超えない)、×=0 */
function earnedOf(sc) {
  const p = sc.p || 0;
  if (sc.j === 'o') return p;
  if (sc.j === 't') return Math.min(p, sc.e != null ? sc.e : p / 2);
  return 0;
}

function initSheet() {
  $('#btnScore').onclick = () => setScoreShown(!cur.showScore);
  $('#btnOriginal').onclick = () => setOriginalShown(!cur.showOriginal);
  $('#btnResetScore').onclick = () => {
    if (!Object.keys(cur.scores).length) return;
    if (!confirm('この問の〇×判定と配点をすべて消去しますか？')) return;
    cur.scores = {};
    saveScores();
    for (const el of $$('#fields .pts, #fields .part')) el.value = '';
    updateScore();
  };
  $('#btnAnswer').onclick = () => setAnswerShown(!cur.showAnswer);
  $('#btnReview').onclick = () => setReviewShown(!cur.showReview);
  $('#btnClearAns').onclick = () => {
    if (!Object.values(cur.answers).some((v) => v)) return;
    if (!confirm('この問の解答をすべて消去しますか？')) return;
    cur.answers = {};
    saveAnswers();
    for (const ta of $$('#fields textarea')) { ta.value = ''; autosize(ta); }
    cur.problem.fields.forEach((_, i) => updateCount(i));
  };
  $('#btnBack').onclick = () => { location.hash = ''; };
  const go = (d) => {
    const ps = cur.session.problems;
    const n = ps[ps.indexOf(cur.problem) + d];
    if (n) location.hash = `#${cur.session.id}/${n.no}`;
  };
  $('#btnPrev').onclick = () => go(-1);
  $('#btnNext').onclick = () => go(1);
}

/* ------------------------------------------------------------------ 自動保存 */
const pending = new Map();
function schedule(key, getVal) {
  if (pending.has(key)) clearTimeout(pending.get(key).tm);
  const run = () => { pending.delete(key); return DB.set(key, getVal()); };
  pending.set(key, { tm: setTimeout(run, 400), run });
}
function flushSave() {
  return Promise.all([...pending.values()].map(({ tm, run }) => { clearTimeout(tm); return run(); }));
}
function saveAnswers() { const a = cur.answers; schedule(`a:${cur.session.id}:${cur.problem.no}`, () => a); }
function saveScores() { const s = cur.scores; schedule(`s:${cur.session.id}:${cur.problem.no}`, () => s); }
function saveMarks() { const m = cur.marks; schedule(`m:${cur.session.id}:${cur.problem.no}`, () => m); }
addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

/* ------------------------------------------------------------------ 起動 */
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    const r = await fetch('data/exams.json');
    EXAMS = (await r.json()).exams;
  } catch (e) {
    $('#home').innerHTML = '<div class="home-inner"><h1>データを読み込めませんでした</h1><p class="hint">オンラインで一度開いてから、もう一度お試しください。</p></div>';
    return;
  }
  initHome();
  initDivider();
  initMarking();
  initSheet();
  addEventListener('hashchange', route);
  route();
})();
