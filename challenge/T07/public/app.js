'use strict';
// 화면에 사용자 글자를 넣을 때는 항상 textContent만 쓴다 (HTML 문자열로 넣지 않는다). 그래서 <script> 같은 글자도 글자 그대로 보인다.

const $ = (sel) => document.querySelector(sel);
const PRIORITY = { 1: '높음', 2: '보통', 3: '낮음' };
const VIEWS = ['cal', 'plan', 'do', 'see', 'exp'];
const state = {
  meta: null,
  plans: [],
  plan: null,
  tasks: [],
  allTasks: [],
  review: null,
  period: { from: '', to: '' },
  editingTaskId: null,
  carryRetro: null,
  planFormMode: 'edit',
  expanded: new Set(),
  cooldown: new Map(),
};

// ---------- 작은 도우미 ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function gearIcon(cls = 'gear') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#gear');
  svg.append(use);
  return svg;
}

function newKey() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

let inflight = 0;
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  inflight++;
  document.body.classList.add('busy');
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나 잠시 뒤 새로고침하세요.');
  } finally {
    if (--inflight === 0) document.body.classList.remove('busy');
  }
  const data = await res.json().catch(() => ({}));
  // 세션이 끝났거나(로그아웃·만료·비밀번호 변경) 처음부터 없으면 서버가 401을 준다 → 로그인 화면으로
  if (res.status === 401) {
    location.replace('/login');
    throw new Error(data.error || '로그인이 필요합니다');
  }
  if (!res.ok) throw new Error(data.error || `요청이 실패했습니다 (${res.status})`);
  return data;
}

let statusTimer;
function say(msg, kind = 'ok') {
  const s = $('#status');
  s.textContent = msg;
  s.dataset.kind = kind;
  clearTimeout(statusTimer);
  if (kind === 'ok') statusTimer = setTimeout(() => { s.textContent = ''; }, 4000);
}
const fail = (err) => say(err.message, 'error');

const seoulDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const fmtTime = (isoStr) => (isoStr ? seoulDate.format(new Date(isoStr)) : '');
const seoulTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
function fmtRange(a, b) {
  return `${fmtTime(a)} ~ ${seoulTime.format(new Date(b))}`;
}
const seoulYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' });
const seoulToday = () => seoulYmd.format(new Date());
function fmtDate(d) {
  if (!d) return '';
  const [, m, day] = d.split('-');
  const wd = '일월화수목금토'[new Date(`${d}T00:00:00Z`).getUTCDay()];
  return `${Number(m)}/${Number(day)}(${wd})`;
}
// ISO(UTC) → datetime-local 입력값(서울)
function toSeoulInput(isoStr) {
  const d = new Date(new Date(isoStr).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}
// datetime-local 입력값(서울) → 시간대가 붙은 ISO
const fromSeoulInput = (v) => (v ? `${v}:00+09:00` : '');

function hm(n) {
  const a = Math.abs(n);
  const h = Math.floor(a / 60);
  const r = a % 60;
  return h ? `${h}시간${r ? ` ${r}분` : ''}` : `${r}분`;
}
function fmtMin(m) {
  const n = Number(m) || 0;
  const sign = n < 0 ? '-' : '';
  return Math.abs(n) >= 60 ? `${sign}${Math.abs(n)}분 (${sign}${hm(n)})` : `${n}분`;
}

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

// ---------- 화면 전환 ----------
function viewOf(hash) {
  const h = hash.replace(/^#/, '');
  if (VIEWS.includes(h)) return h;
  if (/^(task|log)-\d+$/.test(h)) return 'do';
  if (/^retro-\d+$/.test(h)) return 'see';
  return 'cal';
}

function showView(name) {
  // 달력은 스크롤 없이 한 화면에 맞춘다 (머리를 줄이고, 달력·고른 날 목록이 남은 높이를 나눠 쓴다)
  document.body.classList.toggle('cal-mode', name === 'cal');
  if (name === 'cal' && state.cal && state.cal.data) renderCal();
  for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.dataset.view !== name;
  for (const a of document.querySelectorAll('.step')) {
    if (a.dataset.view === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function renderSummaries() {
  const p = state.plan;
  $('#sum-plan').textContent = p ? `${fmtDate(p.start_date)}~${fmtDate(p.end_date)}` : '';
  const total = state.allTasks.length;
  const done = state.allTasks.filter((t) => t.status === 'done').length;
  $('#sum-do').textContent = total ? `${total}개 중 ${done} 완료` : '';
  const r = state.review;
  $('#sum-see').textContent = r ? `차이 ${r.diff_minutes > 0 ? '+' : ''}${r.diff_minutes}분` : '';
}

// ---------- 계획 ----------
async function loadPlans(selectId) {
  state.plans = await api('GET', '/api/plans');
  const sel = $('#plan-select');
  sel.replaceChildren(...state.plans.map((p) => el('option', { value: p.id, text: `#${p.id} ${p.title}` })));
  $('#plan-empty').hidden = state.plans.length > 0;
  sel.hidden = state.plans.length === 0;
  for (const id of ['#edit-plan-btn', '#add-task-btn']) $(id).disabled = state.plans.length === 0;
  if (!state.plans.length) {
    state.plan = null;
    $('#plan-view').replaceChildren();
    await loadCal();
    return;
  }
  const fromUrl = Number(new URLSearchParams(location.search).get('plan'));
  const want = selectId || fromUrl || state.plans[0].id;
  const pick = state.plans.find((p) => p.id === want) ? want : state.plans[0].id;
  sel.value = String(pick);
  await Promise.all([selectPlan(pick), loadCal()]);
}

async function selectPlan(id) {
  state.plan = await api('GET', `/api/plans/${id}`);
  state.expanded.clear();
  const url = new URL(location.href);
  url.searchParams.set('plan', id);
  history.replaceState(null, '', url);
  renderPlan();
  await Promise.all([loadTasks(), loadReview(), loadRetros()]);
}

function field(label, value, cls) {
  return el('div', { class: `field ${cls || ''}` }, el('dt', { text: label }), el('dd', {}, value));
}

function renderPlan() {
  const p = state.plan;
  const card = el('article', { class: 'plan-card', id: `plan-${p.id}` },
    el('div', { class: 'plan-head' },
      el('span', { class: 'kicker', text: `계획 #${p.id} · ${p.current_revision}판` }),
      el('h3', { class: 'plan-title', text: p.title })),
    p.carried_improvement
      ? el('p', { class: 'carry' }, el('strong', { text: `돌아보기 #${p.carried_from_retro_id}에서 넘어온 고칠 점 ` }), p.carried_improvement)
      : null,
    el('dl', { class: 'fields' },
      field('기간', `${p.start_date} ~ ${p.end_date}`),
      field('우선순위', PRIORITY[p.priority], `prio p${p.priority}`),
      field('예상 시간', fmtMin(p.estimated_minutes))),
    el('div', { class: 'criteria' }, el('span', { class: 'label', text: '성공 기준' }), el('p', { text: p.success_criteria })),
    gearIcon('gear corner'));
  $('#plan-view').replaceChildren(card);
  renderHistory();
  renderSummaries();
}

const REV_FIELDS = [
  ['title', '이름', (v) => v],
  ['start_date', '시작일', (v) => v],
  ['end_date', '종료일', (v) => v],
  ['priority', '우선순위', (v) => PRIORITY[v]],
  ['success_criteria', '성공 기준', (v) => v],
  ['estimated_minutes', '예상 시간', fmtMin],
];

function renderHistory() {
  const revs = state.plan.revisions;
  $('#history-count').textContent = `${revs.length}판`;
  const head = el('tr', {}, el('th', { text: '판' }), el('th', { text: '저장' }),
    ...REV_FIELDS.map(([, l]) => el('th', { text: l })), el('th', { text: '고친 이유' }));
  const rows = revs.map((r, i) => {
    const prev = revs[i - 1];
    return el('tr', { id: `rev-${r.id}` },
      el('td', { text: r.revision_no === 1 ? '1판 (처음)' : `${r.revision_no}판` }),
      el('td', { text: fmtTime(r.created_at) }),
      ...REV_FIELDS.map(([k, , f]) => el('td', { class: prev && String(prev[k]) !== String(r[k]) ? 'changed' : undefined, text: f(r[k]) })),
      el('td', { text: r.change_reason || '' }));
  });
  $('#history-table').replaceChildren(el('thead', {}, head), el('tbody', {}, rows));
}

// preset: 달력에서 여러 날을 끌어 열 때 { start_date, end_date }
function openPlanForm(mode, retro, preset) {
  const f = $('#plan-form');
  state.planFormMode = mode;
  state.carryRetro = retro || null;
  state.planFromCal = !!preset;
  f.reset();
  $('#plan-form-title').textContent = mode === 'edit' ? '계획 고치기' : preset ? `새 일정 (계획) ${fmtDate(preset.start_date)} ~ ${fmtDate(preset.end_date)}` : '새 계획';
  if (preset) {
    f.elements.start_date.value = preset.start_date;
    f.elements.end_date.value = preset.end_date;
    f.elements.estimated_minutes.value = '0';
  }
  $('#change-reason-wrap').hidden = mode !== 'edit';
  const carry = $('#plan-form-carry');
  carry.hidden = !retro;
  if (retro) carry.textContent = `돌아보기 #${retro.id}의 고칠 점이 이 계획에 함께 저장됩니다: ${retro.improvement}`;
  if (mode === 'edit' && state.plan) {
    for (const k of ['title', 'start_date', 'end_date', 'priority', 'estimated_minutes', 'success_criteria']) {
      f.elements[k].value = state.plan[k];
    }
  } else if (retro && state.plan) {
    const next = new Date(`${state.plan.end_date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const end = new Date(next);
    end.setUTCDate(end.getUTCDate() + 6);
    f.elements.start_date.value = next.toISOString().slice(0, 10);
    f.elements.end_date.value = end.toISOString().slice(0, 10);
    f.elements.priority.value = String(state.plan.priority);
    f.elements.success_criteria.value = state.plan.success_criteria;
  }
  $('#plan-dialog').showModal();
  f.elements.title.focus();
}

async function submitPlan(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('[type=submit]');
  const d = formData(form);
  const body = {
    title: d.title, start_date: d.start_date, end_date: d.end_date,
    priority: Number(d.priority), success_criteria: d.success_criteria,
    estimated_minutes: d.estimated_minutes === '' ? undefined : Number(d.estimated_minutes),
  };
  busy(btn, true);
  try {
    if (state.planFormMode === 'edit') {
      body.change_reason = d.change_reason;
      const p = await api('PUT', `/api/plans/${state.plan.id}`, body);
      $('#plan-dialog').close();
      say(`계획을 고쳤습니다. 지금 ${p.current_revision}판이고, 고치기 전 판은 수정 이력에 남아 있습니다.`);
      $('#history-box').open = true;
      await loadPlans(p.id);
    } else {
      if (state.carryRetro) body.carried_from_retro_id = state.carryRetro.id;
      const p = await api('POST', '/api/plans', body);
      $('#plan-dialog').close();
      say(`새 계획 #${p.id}을(를) 만들었습니다.`);
      if (!state.planFromCal) location.hash = '#plan';
      await loadPlans(p.id);
    }
  } catch (err) {
    fail(err);
  } finally {
    busy(btn, false);
  }
}

// ---------- 할 일 ----------
function taskQuery() {
  const q = new URLSearchParams();
  const v = (id) => $(id).value.trim();
  if (v('#f-q')) q.set('q', v('#f-q'));
  if (v('#f-status')) q.set('status', v('#f-status'));
  if (v('#f-priority')) q.set('priority', v('#f-priority'));
  if (v('#f-tag')) q.set('tag', v('#f-tag'));
  q.set('sort', v('#f-sort') || 'due');
  return q;
}

let taskSeq = 0;
async function loadTasks() {
  if (!state.plan) return;
  const seq = ++taskSeq;
  const [res, all] = await Promise.all([
    api('GET', `/api/plans/${state.plan.id}/tasks?${taskQuery()}`),
    api('GET', `/api/plans/${state.plan.id}/tasks?sort=due`),
  ]);
  if (seq !== taskSeq) return; // 늦게 도착한 옛 응답은 버린다
  state.tasks = res.tasks;
  state.allTasks = all.tasks;
  $('#sort-rule').textContent = res.sort_label;
  renderTagOptions();
  renderTasks();
  renderGapChart();
  renderSummaries();
}

function renderTagOptions() {
  const sel = $('#f-tag');
  const cur = sel.value;
  const tags = [...new Set(state.allTasks.flatMap((t) => t.tags))].sort((a, b) => a.localeCompare(b, 'ko'));
  sel.replaceChildren(el('option', { value: '', text: '전체' }), ...tags.map((t) => el('option', { value: t, text: `#${t}` })));
  sel.value = tags.includes(cur) ? cur : '';
}

function renderTasks() {
  const list = $('#task-list');
  const filtered = state.tasks.length !== state.allTasks.length;
  $('#task-count').textContent = filtered ? `${state.allTasks.length}개 중 ${state.tasks.length}개가 조건에 맞습니다` : `할 일 ${state.allTasks.length}개`;
  if (!state.tasks.length) {
    list.replaceChildren(el('li', { class: 'empty', text: state.allTasks.length ? '조건에 맞는 할 일이 없습니다.' : '아직 할 일이 없습니다. "+ 할 일"로 넣어 보세요.' }));
    return;
  }
  list.replaceChildren(...state.tasks.map(renderTask));
}

function renderTask(t) {
  const done = t.status === 'done';
  const open = state.expanded.has(t.id);
  const actual = t.logs.reduce((s, l) => s + l.actual_minutes, 0);
  const blocked = t.logs.some((l) => l.blocked_reason.trim());
  const until = state.cooldown.get(t.id) || 0;
  const check = el('button', {
    type: 'button', class: `check${done ? ' on' : ''}`, dataset: { key: newKey() },
    'aria-label': done ? '진행 중으로 되돌리기' : '완료',
    title: done ? '누르면 진행 중으로 되돌립니다' : '누르면 완료로 바꿉니다',
    onclick: (e) => (done ? reopenTask(t, e.currentTarget) : completeTask(t, e.currentTarget)),
  }, el('span', { class: 'tick', 'aria-hidden': 'true', text: '✓' }));
  // 방금 상태가 바뀐 버튼은 잠시 눌리지 않게 해, 두 번째 클릭이 바로 "되돌리기"로 이어지지 않게 한다 (중복 완료 자체는 서버가 막음)
  if (until > Date.now()) {
    check.disabled = true;
    setTimeout(() => { check.disabled = false; }, until - Date.now());
  }
  const today = !done && t.due_date === seoulToday();
  const meta = [
    t.due_date ? el('span', { class: t.overdue ? 'late' : undefined, text: `${fmtDate(t.due_date)}${t.overdue ? ' 지연' : ''}` }) : el('span', { text: '마감 없음' }),
    today ? el('span', { class: 'today', text: '오늘' }) : null,
    el('span', { class: `prio p${t.priority}`, text: PRIORITY[t.priority] }),
    el('span', { text: `예상 ${hm(t.estimated_minutes)}` }),
    t.logs.length ? el('span', { text: `실제 ${hm(actual)}` }) : null,
    blocked ? el('span', { class: 'late', text: '막힘' }) : null,
    ...t.tags.map((g) => el('span', { class: 'tag', text: `#${g}` })),
  ];
  const toggle = el('button', {
    type: 'button', class: 'task-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': `task-body-${t.id}`,
    onclick: () => toggleTask(t.id),
  },
  el('h3', { text: t.title }),
  el('span', { class: 'meta' }, meta),
  el('span', { class: 'chev', 'aria-hidden': 'true' }));

  const body = el('div', { class: 'task-body', id: `task-body-${t.id}`, hidden: !open },
    t.description ? el('p', { class: 'desc', text: t.description }) : null,
    done ? el('p', { class: 'hint', text: `완료 ${fmtTime(t.completed_at)}` }) : null,
    el('h4', { text: `실행 기록 ${t.logs.length}건` }),
    t.logs.length
      ? el('ol', { class: 'log-list' }, t.logs.map((l) => renderLog(l)))
      : el('p', { class: 'hint', text: '아직 실행 기록이 없습니다.' }),
    el('details', { class: 'log-add' }, el('summary', { text: '+ 실행 기록 추가' }), renderLogForm(t)),
    el('div', { class: 'task-actions' },
      el('button', { type: 'button', class: 'btn ghost small', onclick: () => openTaskForm(t), text: '고치기' }),
      el('button', { type: 'button', class: 'btn ghost small danger', onclick: (e) => deleteTask(t, e.currentTarget), text: '지우기' })));

  return el('li', { class: `task${done ? ' done' : ''}${t.overdue ? ' overdue' : ''}${today ? ' due-today' : ''}${open ? ' open' : ''}`, id: `task-${t.id}`, tabindex: '-1' },
    el('div', { class: 'task-row' }, check, toggle), body);
}

function toggleTask(id, force) {
  const open = force ?? !state.expanded.has(id);
  if (open) state.expanded.add(id); else state.expanded.delete(id);
  const li = document.getElementById(`task-${id}`);
  if (!li) return;
  li.classList.toggle('open', open);
  li.querySelector('.task-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  li.querySelector('.task-body').hidden = !open;
}

function renderLog(l) {
  const isBlocked = l.blocked_reason.trim() !== '';
  return el('li', { class: `log${isBlocked ? ' blocked' : ''}`, id: `log-${l.id}`, tabindex: '-1' },
    el('div', { class: 'log-main' },
      el('span', { class: 'when', text: fmtRange(l.started_at, l.ended_at) }),
      el('strong', { text: `실제 ${fmtMin(l.actual_minutes)}` })),
    isBlocked ? el('p', { class: 'why' }, '막힌 이유 · ', l.blocked_reason) : null,
    l.note ? el('p', { class: 'note', text: l.note }) : null,
    el('div', { class: 'log-foot' },
      el('span', { class: 'id', text: `기록 #${l.id}` }),
      el('button', { type: 'button', class: 'link danger', onclick: (e) => deleteLog(l, e.currentTarget), text: '지우기' })));
}

function renderLogForm(t, day) {
  const key = newKey();
  // 기본값은 "방금 끝냄": 끝 = 지금, 시작 = 지금 - 예상 시간(없으면 60분). 바로 저장해도 실제 시간이 맞게 들어간다.
  // 달력에서 다른 날을 골라 열면 그날의 같은 시각으로 맞춘다.
  const nowMs = Date.now() + (day ? daysBetween(seoulToday(), day) * 86400000 : 0);
  const now = toSeoulInput(new Date(nowMs).toISOString());
  const before = toSeoulInput(new Date(nowMs - (t.estimated_minutes || 60) * 60000).toISOString());
  const doneBox = t.status === 'done' ? null : el('input', { name: 'complete', type: 'checkbox', checked: true });
  const form = el('form', { class: 'form log-form', dataset: { key } },
    el('div', { class: 'two' },
      el('label', {}, '시작 (서울)', el('input', { name: 'started_at', type: 'datetime-local', required: true, value: before })),
      el('label', {}, '끝 (서울)', el('input', { name: 'ended_at', type: 'datetime-local', required: true, value: now }))),
    el('div', { class: 'two' },
      el('label', {}, '실제 걸린 시간(분)', el('input', { name: 'actual_minutes', type: 'number', min: 0, step: 1, placeholder: '비우면 끝-시작' })),
      el('label', {}, '막혔던 이유', el('input', {
        name: 'blocked_reason', maxlength: 1000, placeholder: '없으면 비움',
        // 막힌 기록(못 한 날)은 보통 완료가 아니므로 완료 표시를 꺼 둔다
        oninput: (e) => { if (doneBox && e.target.value.trim()) doneBox.checked = false; },
      }))),
    el('label', {}, '메모', el('input', { name: 'note', maxlength: 1000 })),
    doneBox ? el('label', { class: 'inline-check' }, doneBox, '저장하면서 이 할 일을 완료로 표시') : null,
    el('p', { class: 'hint', text: '계획과 할 일의 예상 값은 바뀌지 않고, 기록만 따로 쌓입니다.' }),
    el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'btn primary small', text: '실행 기록 저장' })));
  form.addEventListener('submit', (e) => addLog(e, t));
  return form;
}

// preset: 달력에서 열 때 { due_date, plan_id }
function openTaskForm(t, preset) {
  const f = $('#task-form');
  f.reset();
  state.editingTaskId = t ? t.id : null;
  $('#task-form-title').textContent = t ? `할 일 #${t.id} 고치기` : '할 일 추가';
  // 새 할 일은 어느 계획에 넣을지 고를 수 있다 (고치기에서는 계획을 옮기지 않는다)
  $('#task-plan-wrap').hidden = !!t;
  f.elements.plan_id.replaceChildren(...state.plans.map((p) => el('option', { value: p.id, text: `#${p.id} ${p.title}` })));
  f.elements.plan_id.value = String((preset && preset.plan_id) || (state.plan && state.plan.id) || '');
  if (preset && preset.due_date) f.elements.due_date.value = preset.due_date;
  if (t) {
    f.elements.title.value = t.title;
    f.elements.due_date.value = t.due_date || '';
    f.elements.priority.value = String(t.priority);
    f.elements.estimated_minutes.value = t.estimated_minutes;
    f.elements.tags.value = t.tags.join(', ');
    f.elements.description.value = t.description;
  }
  $('#task-dialog').showModal();
  f.elements.title.focus();
}

async function submitTask(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('[type=submit]');
  const d = formData(form);
  const body = {
    title: d.title, description: d.description, due_date: d.due_date || null,
    priority: Number(d.priority), tags: d.tags,
    estimated_minutes: d.estimated_minutes === '' ? 0 : Number(d.estimated_minutes),
  };
  busy(btn, true);
  try {
    if (state.editingTaskId) {
      await api('PATCH', `/api/tasks/${state.editingTaskId}`, body);
      say(`할 일 #${state.editingTaskId}을(를) 고쳤습니다.`);
    } else {
      const t = await api('POST', `/api/plans/${d.plan_id || state.plan.id}/tasks`, body);
      say(`할 일 #${t.id}을(를) 만들었습니다.`);
    }
    $('#task-dialog').close();
    await refreshDoSee();
  } catch (err) {
    fail(err);
  } finally {
    busy(btn, false);
  }
}

// 완료 버튼은 그려질 때 요청 키를 하나 받는다. 두 번 눌러도 같은 키가 가므로 서버가 한 번만 기록한다.
async function completeTask(t, btn) {
  btn.classList.add('pending');
  try {
    const r = await api('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: btn.dataset.key });
    state.cooldown.set(t.id, Date.now() + 1200);
    say(r.duplicate ? `"${t.title}"은(는) 이미 완료로 기록돼 있습니다 (중복 기록 없음).` : `"${t.title}" 완료!`);
    await refreshDoSee();
  } catch (err) {
    fail(err);
  } finally {
    btn.classList.remove('pending');
  }
}

async function reopenTask(t, btn) {
  busy(btn, true);
  try {
    await api('POST', `/api/tasks/${t.id}/reopen`);
    state.cooldown.set(t.id, Date.now() + 1200);
    say(`"${t.title}"을(를) 진행 중으로 되돌렸습니다.`);
    await refreshDoSee();
  } catch (err) {
    fail(err);
    busy(btn, false);
  }
}

async function deleteTask(t, btn) {
  if (!confirm(`"${t.title}"을(를) 지울까요? 돌아보기 집계에서도 빠집니다.`)) return;
  busy(btn, true);
  try {
    await api('DELETE', `/api/tasks/${t.id}`);
    state.expanded.delete(t.id);
    say(`"${t.title}"을(를) 지웠습니다.`);
    await refreshDoSee();
  } catch (err) {
    fail(err);
    busy(btn, false);
  }
}

async function addLog(e, t) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('[type=submit]');
  const d = formData(form);
  const body = {
    idempotency_key: form.dataset.key,
    started_at: fromSeoulInput(d.started_at),
    ended_at: fromSeoulInput(d.ended_at),
    actual_minutes: d.actual_minutes === '' ? undefined : Number(d.actual_minutes),
    blocked_reason: d.blocked_reason,
    note: d.note,
  };
  busy(btn, true);
  try {
    const r = await api('POST', `/api/tasks/${t.id}/logs`, body);
    let msg = r.duplicate ? '이미 저장된 기록입니다 (중복 저장 없음).' : `실행 기록 #${r.log.id}을(를) 남겼습니다.`;
    if (form.elements.complete?.checked) {
      // 키는 기록 키에서 만들어, 두 번 눌러도 한 번만 완료된다.
      await api('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: `${form.dataset.key}c` });
      msg += ' 할 일도 완료로 표시했습니다.';
    }
    say(msg);
    await refreshDoSee();
  } catch (err) {
    fail(err);
    busy(btn, false);
  }
}

async function deleteLog(l, btn) {
  if (!confirm(`실행 기록 #${l.id}을(를) 지울까요?`)) return;
  busy(btn, true);
  try {
    await api('DELETE', `/api/logs/${l.id}`);
    say(`실행 기록 #${l.id}을(를) 지웠습니다.`);
    await refreshDoSee();
  } catch (err) {
    fail(err);
    busy(btn, false);
  }
}

async function refreshDoSee() {
  await Promise.all([loadTasks(), loadReview(), loadCal()]);
}

// ---------- 돌아보기 ----------
const TILES = [
  ['planned', '계획', (r) => r.planned, '개'],
  ['done', '완료', (r) => r.done, '개'],
  ['delayed', '지연', (r) => r.delayed, '개'],
  ['blocked', '막힘', (r) => r.blocked, '개'],
  ['estimated', '예상 시간', (r) => r.estimated_minutes, '분'],
  ['actual', '실제 시간', (r) => r.actual_minutes, '분'],
];

function periodQuery() {
  const q = new URLSearchParams();
  if (state.period.from) q.set('from', state.period.from);
  if (state.period.to) q.set('to', state.period.to);
  return q;
}

function tile(metric, label, num, unit, rule, extraCls = '', evidenceMetric = metric) {
  return el('button', {
    type: 'button', class: `tile t-${metric} ${extraCls}`, dataset: { metric: evidenceMetric }, title: rule,
    onclick: () => showEvidence(evidenceMetric),
  },
  el('span', { class: 'tile-label', text: label }),
  el('span', { class: 'tile-num', text: num }),
  el('span', { class: 'tile-unit', text: unit }));
}

async function loadReview() {
  if (!state.plan) return;
  const r = await api('GET', `/api/plans/${state.plan.id}/review?${periodQuery()}`);
  state.review = r;
  $('#today').textContent = fmtDate(r.today_seoul);
  $('#period-rule').textContent = `대상: ${r.period.rule}`;
  const tiles = TILES.map(([m, label, get, unit]) => {
    const n = get(r);
    return tile(m, label, String(n), unit === '분' && n >= 60 ? `분 · ${hm(n)}` : unit, r.rules[m]);
  });
  const d = r.diff_minutes;
  tiles.push(tile('diff', '차이 (실제−예상)', d > 0 ? `+${d}` : String(d), d === 0 ? '분' : `분 · 예상보다 ${d > 0 ? '오래' : '짧게'}`,
    '실제 시간 - 예상 시간', d > 0 ? 'over' : d < 0 ? 'under' : '', 'actual'));
  $('#tiles').replaceChildren(...tiles);
  renderSummaries();
}

async function showEvidence(metric) {
  const box = $('#evidence');
  try {
    const ev = await api('GET', `/api/plans/${state.plan.id}/review/evidence?metric=${metric}&${periodQuery()}`);
    const isTime = metric === 'estimated' || metric === 'actual';
    const parts = [
      el('div', { class: 'sheet-head' },
        el('h3', { text: `${ev.label} — 근거` }),
        el('button', { type: 'button', class: 'btn ghost small', onclick: () => { box.hidden = true; }, text: '닫기' })),
      el('p', { class: 'hint', text: `조건: ${ev.rule}` }),
      el('p', { class: 'ev-total', text: isTime ? `합계 ${fmtMin(ev.total)} · 할 일 ${ev.tasks.length}개${metric === 'actual' ? ` · 실행 기록 ${ev.logs.length}건` : ''}` : `${ev.total}개` }),
    ];
    if (!ev.tasks.length) parts.push(el('p', { class: 'empty', text: '해당하는 기록이 없습니다 (0).' }));
    else {
      parts.push(el('ol', { class: 'ev-list' }, ev.tasks.map((t) => el('li', {},
        el('a', { href: `#task-${t.id}`, dataset: { jump: `task-${t.id}` }, text: t.title }),
        el('span', { class: 'hint', text: ` · ${t.status === 'done' ? '완료' : '진행 중'} · 마감 ${t.due_date ? fmtDate(t.due_date) : '없음'} · 예상 ${t.estimated_minutes}분` })))));
    }
    if (ev.logs.length) {
      parts.push(el('h4', { text: metric === 'blocked' ? '막힌 이유가 적힌 실행 기록' : '실행 기록' }),
        el('ol', { class: 'ev-list logs' }, ev.logs.map((l) => el('li', {},
          el('a', { href: `#log-${l.id}`, dataset: { jump: `log-${l.id}`, task: l.task_id }, text: `기록 #${l.id} · ${fmtTime(l.started_at)}` }),
          el('span', { class: 'hint', text: ` · 실제 ${l.actual_minutes}분${l.blocked_reason ? ` · ${l.blocked_reason}` : ''}` })))));
    }
    box.replaceChildren(...parts);
    box.hidden = false;
    box.focus();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    fail(err);
  }
}

// 근거 링크를 누르면 실행 화면으로 가서, 거르기를 풀고 해당 할 일·기록을 펼쳐 표시한다.
async function jumpTo(id) {
  showView('do');
  let target = document.getElementById(id);
  if (!target) {
    for (const f of ['#f-q', '#f-status', '#f-priority', '#f-tag']) $(f).value = '';
    await loadTasks();
    target = document.getElementById(id);
  }
  if (!target) return say('그 기록을 찾지 못했습니다.', 'error');
  const li = target.closest('.task');
  if (li) toggleTask(Number(li.id.slice(5)), true);
  history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.focus({ preventScroll: true });
  target.classList.remove('flash');
  void target.offsetWidth;
  target.classList.add('flash');
}

function renderGapChart() {
  const rows = state.allTasks
    .map((t) => ({ t, actual: t.logs.reduce((s, l) => s + l.actual_minutes, 0) }))
    .filter((x) => x.t.logs.length > 0);
  const box = $('#gap-chart');
  if (!rows.length) {
    box.replaceChildren(el('p', { class: 'empty', text: '실행 기록이 쌓이면 여기에 보입니다.' }));
    return;
  }
  const max = Math.max(...rows.map((x) => Math.abs(x.actual - x.t.estimated_minutes)), 1);
  box.replaceChildren(...rows.map(({ t, actual }) => {
    const diff = actual - t.estimated_minutes;
    const bar = el('span', { class: `bar ${diff > 0 ? 'over' : 'under'}` });
    bar.style.width = `${Math.round((Math.abs(diff) / max) * 50)}%`;
    if (diff > 0) bar.style.left = '50%'; else bar.style.right = '50%';
    return el('div', { class: 'gap-row' },
      el('a', { href: `#task-${t.id}`, dataset: { jump: `task-${t.id}` }, class: 'gap-name', text: t.title }),
      el('span', { class: 'gap-track' }, el('span', { class: 'axis' }), bar),
      el('span', { class: 'gap-num', text: `${t.estimated_minutes} → ${actual}분 (${diff > 0 ? '+' : ''}${diff})` }));
  }));
}

async function loadRetros() {
  if (!state.plan) return;
  const list = await api('GET', `/api/plans/${state.plan.id}/retros`);
  const box = $('#retro-list');
  if (!list.length) {
    box.replaceChildren(el('li', { class: 'empty', text: '아직 저장한 돌아보기가 없습니다.' }));
    return;
  }
  box.replaceChildren(...list.map((r) => {
    const s = r.snapshot;
    return el('li', { class: 'retro', id: `retro-${r.id}` },
      el('div', { class: 'retro-head' },
        el('strong', { text: `돌아보기 #${r.id}` }),
        el('span', { class: 'hint', text: `${fmtTime(r.created_at)} · ${r.period_from || r.period_to ? `${r.period_from || '처음'} ~ ${r.period_to || '끝'}` : '계획 전체'}` })),
      el('p', { class: 'snap', text: `계획 ${s.planned} · 완료 ${s.done} · 지연 ${s.delayed} · 막힘 ${s.blocked} · 예상 ${s.estimated_minutes}분 · 실제 ${s.actual_minutes}분 · 차이 ${s.diff_minutes > 0 ? '+' : ''}${s.diff_minutes}분` }),
      r.went_well ? el('p', {}, el('span', { class: 'label', text: '잘된 점 ' }), r.went_well) : null,
      r.went_wrong ? el('p', {}, el('span', { class: 'label', text: '빗나간 점 ' }), r.went_wrong) : null,
      el('p', { class: 'carry' }, el('strong', { text: '고칠 점 ' }), r.improvement),
      r.carried_to_plan_id
        ? el('p', { class: 'hint' }, '→ ', el('a', { href: `?plan=${r.carried_to_plan_id}#plan`, text: `계획 #${r.carried_to_plan_id}(으)로 넘어갔습니다` }))
        : el('button', { type: 'button', class: 'btn primary small', onclick: () => openPlanForm('new', r), text: '이 고칠 점으로 다음 계획 만들기' }));
  }));
}

async function submitRetro(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('[type=submit]');
  const d = formData(form);
  busy(btn, true);
  try {
    const r = await api('POST', `/api/plans/${state.plan.id}/retros`, { ...d, from: state.period.from || null, to: state.period.to || null });
    say(`돌아보기 #${r.id}을(를) 저장했습니다. 아래에서 다음 계획으로 넘길 수 있습니다.`);
    form.reset();
    form.hidden = true;
    await loadRetros();
  } catch (err) {
    fail(err);
  } finally {
    busy(btn, false);
  }
}

// ---------- 계정 ----------
async function loadMe() {
  const me = await api('GET', '/api/auth/me');
  state.me = me.user;
  $('#who-name').textContent = me.user.username;
  $('#session-exp').textContent = me.user.session_expires_at ? `이 로그인은 ${fmtTime(me.user.session_expires_at)}에 끊깁니다.` : '';
  if (!me.has_recovery_code) {
    $('#recovery-state').textContent = '이 계정에는 아직 복구 코드가 없습니다. 비밀번호를 잊으면 되찾을 수 없으니 지금 받아 두세요.';
  }
  const imp = me.t06_import;
  const note = $('#import-note');
  note.hidden = !imp;
  if (imp) {
    const c = imp.counts;
    note.textContent = `T06 다이어리 자료를 이 계정으로 옮겨 왔습니다 (${fmtTime(imp.imported_at)}): 계획 ${c.plans}개 · 할 일 ${c.tasks}개 · 실행 기록 ${c.work_logs}개 · 돌아보기 ${c.retrospectives}개`;
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    location.replace('/login');
  }
}

async function submitPassword(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = f.querySelector('button[type=submit]');
  busy(btn, true);
  try {
    const r = await api('POST', '/api/account/password', {
      current_password: f.elements.current_password.value, new_password: f.elements.new_password.value,
    });
    f.reset();
    $('#account-dialog').close();
    say(`비밀번호를 바꿨습니다. 이전 로그인 ${r.revoked_sessions}개를 끊었습니다.`);
    await loadMe();
  } catch (err) {
    f.elements.current_password.value = '';
    fail(err);
  } finally {
    busy(btn, false);
  }
}

async function submitRecovery(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = f.querySelector('button[type=submit]');
  busy(btn, true);
  try {
    const r = await api('POST', '/api/account/recovery-code', { password: f.elements.password.value });
    f.reset();
    const out = $('#recovery-value');
    out.textContent = r.recovery_code;
    out.hidden = false;
    $('#recovery-state').textContent = '새 복구 코드입니다. 지금 한 번만 보여 주니 적어 두세요. 예전 코드는 이제 못 씁니다.';
  } catch (err) {
    f.elements.password.value = '';
    fail(err);
  } finally {
    busy(btn, false);
  }
}

async function submitDelete(e) {
  e.preventDefault();
  const f = e.currentTarget;
  if (!confirm('정말 계정과 내 자료를 모두 지울까요? 되돌릴 수 없습니다.')) return;
  const btn = f.querySelector('button[type=submit]');
  busy(btn, true);
  try {
    await api('DELETE', '/api/account', { password: f.elements.password.value });
    location.replace('/login');
  } catch (err) {
    f.elements.password.value = '';
    fail(err);
  } finally {
    busy(btn, false);
  }
}

// ---------- 5일 기록 ----------
const RULE_LABELS = {
  day: 'n일차', missing: '값이 빠졌을 때', duplicate: '값이 중복될 때', outlier: '값이 유난히 튈 때',
  rounding: '반올림', week_start: '주 시작 요일', compare: '전후 비교',
};

async function loadExp() {
  state.exp = await api('GET', '/api/experiment');
  renderExp();
}

// 손으로 따라 더해 볼 수 있게 계산식을 그대로 보여 준다. 평균 값 자체는 서버가 계산한 것을 쓴다.
function calcText(days, part) {
  const vals = days.filter((d) => d.value !== null).map((d) => d.value);
  if (!vals.length) return '값 없음';
  const sum = vals.reduce((a, b) => a + b, 0);
  return `합계 ${vals.join(' + ')} = ${sum} · 평균 ${sum} ÷ ${vals.length} = ${part.avg}`;
}

function renderExp() {
  const x = state.exp;
  $('#exp-today').textContent = x.today_seoul;
  $('#exp-rules').replaceChildren(...Object.entries(x.rules).map(([k, v]) => el('li', {}, el('strong', { text: `${RULE_LABELS[k] || k}: ` }), v)));
  const e = x.experiment;
  $('#exp-def-empty').hidden = !!e;
  $('#exp-edit-btn').hidden = !!x.locked;
  $('#exp-edit-btn').textContent = e ? '고치기 (1일차 전까지만)' : '정하기';
  const row = (k, v) => [el('dt', { text: k }), el('dd', { text: v })];
  $('#exp-def').replaceChildren(...(e ? [
    ...row('답하려는 질문', e.question), ...row('관찰 지표', e.metric), ...row('단위', e.unit),
    ...row('하루 값 계산 규칙', e.calc_rule), ...row('지금 계획 규칙', e.plan_rule),
    ...row('정한 시각', fmtTime(e.created_at)),
  ] : []));
  const unit = e ? e.unit : '';
  $('#day-unit').textContent = unit ? `(${unit})` : '';
  $('#rule-now').textContent = e ? e.plan_rule : '';
  const n = x.days.length;
  $('#day-open').disabled = !e || n >= 5 || (n === 2 && !x.rule_change);
  $('#rule-open').disabled = !e || n !== 2 || !!x.rule_change;
  $('#sum-exp').textContent = e ? `${n}/5일${x.rule_change ? ' · 규칙 바꿈' : ''}` : '';

  const head = el('tr', {}, el('th', { text: '일차' }), el('th', { text: '날짜(서울)' }), el('th', { class: 'num', text: `값${unit ? ` (${unit})` : ''}` }),
    el('th', { text: '적용한 계획 규칙' }), el('th', { text: '메모' }), el('th', { text: '적은 시각' }), el('th', { text: '' }));
  const rows = [];
  for (const d of x.days) {
    const last = d.day_no === n && !(x.rule_change && d.day_no <= 2);
    rows.push(el('tr', { id: `day-${d.id}`, class: d.value === null ? 'missing' : undefined },
      el('td', { text: `${d.day_no}일차` }), el('td', { text: fmtDate(d.day_date) }),
      el('td', { class: 'num', text: d.value === null ? '빠짐' : String(d.value) }),
      el('td', { text: d.plan_rule }), el('td', { text: d.note }), el('td', { text: fmtTime(d.created_at) }),
      el('td', {}, last ? el('button', { type: 'button', class: 'link danger', text: '지우기', onclick: () => deleteDay(d.id) }) : null)));
    if (d.day_no === 2 && x.rule_change) {
      const c = x.rule_change;
      rows.push(el('tr', { class: 'change-row', id: `rule-change-${c.id}` }, el('td', { colspan: 7 },
        el('strong', { text: `계획 규칙 변경 (${fmtTime(c.changed_at)}) ` }),
        `1일차 기록 #${c.day1_id}·2일차 기록 #${c.day2_id} 뒤, 3일차 앞. "${c.old_rule}" → "${c.new_rule}". 이유: ${c.reason}`)));
    }
  }
  $('#exp-table').replaceChildren(el('thead', {}, head), el('tbody', {}, rows.length ? rows : [el('tr', {}, el('td', { colspan: 7, class: 'empty', text: '아직 기록이 없습니다' }))]));

  const s = x.summary;
  const box = (label, part, days) => el('div', { class: 'tile' },
    el('span', { class: 'tile-label', text: label }),
    el('span', { class: 'tile-num', text: part && part.avg !== null ? String(part.avg) : '–' }),
    el('span', { class: 'tile-unit', text: `평균(${unit}) · 합계 ${part ? part.sum : 0}${unit} · 값 ${part ? part.recorded : 0}일 / 빠짐 ${part ? part.missing : 0}일` }),
    el('p', { class: 'calc', text: part ? calcText(days, part) : '' }));
  $('#exp-compare').replaceChildren(
    box('바꾸기 전 (1·2일차)', s && s.before, x.days.filter((d) => d.day_no <= 2)),
    box('바꾼 뒤 (3~5일차)', s && s.after, x.days.filter((d) => d.day_no >= 3)),
    box('5일 전체', s && s.all, x.days));
}

async function submitExp(e) {
  e.preventDefault();
  const f = e.currentTarget;
  try {
    state.exp = await api('PUT', '/api/experiment', formData(f));
    f.hidden = true;
    renderExp();
    say('저장했습니다');
  } catch (err) { fail(err); }
}

async function submitDay(e) {
  e.preventDefault();
  const f = e.currentTarget;
  const d = formData(f);
  try {
    const r = await api('POST', '/api/experiment/days', { day_date: d.day_date, value: d.value === '' ? null : Number(d.value), note: d.note });
    state.exp = r;
    f.hidden = true;
    renderExp();
    say(`${r.day.day_no}일차를 적었습니다`);
  } catch (err) { fail(err); }
}

async function submitRule(e) {
  e.preventDefault();
  const f = e.currentTarget;
  try {
    state.exp = await api('POST', '/api/experiment/rule-change', formData(f));
    f.hidden = true;
    renderExp();
    say('계획 규칙을 바꿨습니다. 3일차부터 새 규칙으로 적습니다');
  } catch (err) { fail(err); }
}

async function deleteDay(id) {
  if (!confirm('이 기록을 지울까요?')) return;
  try {
    state.exp = await api('DELETE', `/api/experiment/days/${id}`);
    renderExp();
  } catch (err) { fail(err); }
}

function bindExp() {
  $('#exp-edit-btn').addEventListener('click', () => {
    const f = $('#exp-form');
    f.hidden = false;
    const e = state.exp && state.exp.experiment;
    for (const k of ['question', 'metric', 'unit', 'calc_rule', 'plan_rule']) f.elements[k].value = e ? e[k] : '';
    f.elements.question.focus();
  });
  $('#exp-form').addEventListener('submit', submitExp);
  $('#day-open').addEventListener('click', () => {
    const f = $('#day-form');
    f.reset();
    f.hidden = false;
    f.elements.day_date.value = seoulToday();
    f.elements.value.focus();
  });
  $('#day-form').addEventListener('submit', submitDay);
  $('#rule-open').addEventListener('click', () => {
    const f = $('#rule-form');
    f.reset();
    f.hidden = false;
    f.elements.new_rule.focus();
  });
  $('#rule-form').addEventListener('submit', submitRule);
}

// ---------- 달력 ----------
// 네이버 캘린더처럼: 한 달 칸에 계획 기간(색 띠)·할 일 마감·실행 기록을 놓고, 날짜를 누르면 그날 내용이 아래에 나온다.
// 주는 일요일에 시작하고(네이버 캘린더 기본), 일요일은 빨강·토요일은 파랑으로 쓴다. 날짜는 모두 서울 달력 날짜.
const WEEKDAYS = '일월화수목금토';
const PLAN_COLORS = 6;
// 한 칸에 보이는 줄 수 (넘치면 "+n"). 칸 높이는 화면 높이에 따라 달라지므로 그릴 때마다 잰다.
let CELL_ITEMS = 4;
function measureCellItems(weeks) {
  const grid = $('#cal-grid');
  const head = grid.querySelector('.wd');
  const h = grid.clientHeight - (head ? head.offsetHeight : 24);
  if (!h || h < 0) return 4;
  const small = matchMedia('(max-width: 640px)').matches;
  const lineH = small ? 15 : 18;
  const fixed = small ? 30 : 32; // 날짜 동그라미 + 얇은 계획 띠 + 아래 기록 줄
  return Math.max(1, Math.min(6, Math.floor((h / weeks - fixed) / lineH)));
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const planColor = (planId) => `pc${planId % PLAN_COLORS}`;

function calMonthRange(month) {
  const first = `${month}-01`;
  const start = addDays(first, -weekdayOf(first));
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const end = addDays(last, 6 - weekdayOf(last));
  return { start, end, first, last };
}

function shiftMonth(month, n) {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

let calSeq = 0;
async function loadCal() {
  if (!state.cal) {
    const today = seoulToday();
    state.cal = { month: today.slice(0, 7), selected: today, data: null };
  }
  const { start, end } = calMonthRange(state.cal.month);
  const seq = ++calSeq;
  const data = await api('GET', `/api/calendar?from=${start}&to=${end}`);
  if (seq !== calSeq) return;
  state.cal.data = data;
  renderCal();
}

function calItemsOn(day) {
  const d = state.cal.data;
  return {
    plans: d.plans.filter((p) => p.start_date <= day && p.end_date >= day),
    tasks: d.tasks.filter((t) => t.due_date === day),
    logs: d.logs.filter((l) => l.day === day),
    exp: d.experiment_days.find((x) => x.day_date === day),
  };
}

function renderCal() {
  const { month, selected, data } = state.cal;
  const { start, end } = calMonthRange(month);
  const today = data.today_seoul;
  $('#cal-title').textContent = `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`;
  $('#cal-today').disabled = month === today.slice(0, 7) && selected === today;

  const head = [...WEEKDAYS].map((w, i) => el('div', { class: `wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`, 'aria-hidden': 'true', text: w }));
  const weeks = daysBetween(start, end) / 7 + 1 | 0;
  $('#cal-grid').style.setProperty('--weeks', weeks);
  const touch = matchMedia('(pointer: coarse)').matches;
  $('#cal-legend').replaceChildren(...data.plans.map((p) => el('span', { class: `legend ${planColor(p.id)}` }, el('i', { 'aria-hidden': 'true' }), p.title)),
    el('span', { class: 'cal-hint', text: touch ? '꾹 눌러 끌면 새 일정 · 할 일 꾹 눌러 끌면 날짜 옮김' : '여러 날을 끌면 새 일정 · 할 일을 끌어 다른 날에 놓으면 날짜 옮기기' }));
  // 칸에 들어갈 줄 수는 그려 본 뒤 칸 높이로 다시 재고, 달라졌으면 한 번 더 그린다
  const draw = () => {
    const cells = [];
    for (let wk = start; wk <= end; wk = addDays(wk, 7)) {
      const wkEnd = addDays(wk, 6);
      // 이 주에 걸친 계획마다 줄(lane)을 하나씩 정해, 여러 날에 걸친 띠가 같은 높이로 이어지게 한다
      const lanes = data.plans.filter((p) => p.start_date <= wkEnd && p.end_date >= wk);
      for (let i = 0; i < 7; i++) {
        const day = addDays(wk, i);
        cells.push(renderCalCell(day, lanes, { today, month, selected }));
      }
    }
    $('#cal-grid').replaceChildren(...head, ...cells);
  };
  draw();
  const fit = measureCellItems(weeks);
  if (fit !== CELL_ITEMS) { CELL_ITEMS = fit; draw(); }
  const todayCount = data.tasks.filter((t) => t.due_date === today && t.status !== 'done').length;
  $('#sum-cal').textContent = todayCount ? `오늘 할 일 ${todayCount}` : '';
  renderDayPanel();
}

function renderCalCell(day, lanes, { today, month, selected }) {
  const items = calItemsOn(day);
  const wd = weekdayOf(day);
  const lines = [];
  // 계획 띠: 이 칸에 없는 계획 줄은 빈 자리로 남겨 옆 칸 띠와 높이를 맞춘다. 이름은 시작일이나 그 주 첫 칸에만 쓴다.
  // 칸이 낮으면(휴대폰) 계획 띠를 글자 없는 얇은 줄로 그려 할 일 자리를 남긴다
  const thin = CELL_ITEMS <= 2;
  const bars = [];
  let lastLane = -1;
  lanes.forEach((p, i) => { if (p.start_date <= day && p.end_date >= day) lastLane = i; });
  for (let i = 0; i <= lastLane && bars.length < (thin ? 3 : CELL_ITEMS - 1); i++) {
    const p = lanes[i];
    const on = p.start_date <= day && p.end_date >= day;
    if (!on) { bars.push(el('span', { class: `bar-gap${thin ? ' thin' : ''}`, 'aria-hidden': 'true' })); continue; }
    const head = !thin && (p.start_date === day || wd === 0);
    bars.push(el('span', {
      class: `pbar ${planColor(p.id)}${thin ? ' thin' : ''}${p.start_date === day ? ' s' : ''}${p.end_date === day ? ' e' : ''}`,
      'aria-hidden': 'true', text: head ? p.title : '\u00a0',
    }));
  }
  if (thin && bars.length) lines.push(el('span', { class: 'thin-bars', 'aria-hidden': 'true' }, bars));
  else lines.push(...bars);
  const room = Math.max(CELL_ITEMS - (thin ? 0 : bars.length), 1);
  const tasks = items.tasks;
  const shown = tasks.slice(0, room);
  for (const t of shown) {
    lines.push(el('span', { class: `chip ${planColor(t.plan_id)}${t.status === 'done' ? ' done' : ''}${t.overdue ? ' late' : ''}`, 'aria-hidden': 'true', dataset: { task: t.id }, title: '끌어서 다른 날로 옮기기', text: t.title }));
  }
  // 넘친 할 일 수("+n")와 실행 기록 시간은 칸 맨 아래 한 줄에 둔다
  const more = tasks.length - shown.length;
  const logMin = items.logs.reduce((s, l) => s + l.actual_minutes, 0);
  const foot = more || items.logs.length || items.exp
    ? el('span', { class: 'cell-foot', 'aria-hidden': 'true' },
      more ? el('span', { class: 'more', text: `+${more}` }) : null,
      items.logs.length ? el('span', { class: 'logmark', text: hm(logMin) }) : null,
      items.exp ? el('span', { class: 'expmark', text: `Ⅳ${items.exp.value ?? '–'}` }) : null)
    : null;

  const left = tasks.filter((t) => t.status !== 'done').length;
  const label = [
    `${Number(day.slice(5, 7))}월 ${Number(day.slice(8))}일 ${WEEKDAYS[wd]}요일`,
    day === today ? '오늘' : '',
    tasks.length ? `할 일 ${tasks.length}개${left ? `(남은 것 ${left})` : ''}` : '',
    items.logs.length ? `실행 기록 ${items.logs.length}건` : '',
  ].filter(Boolean).join(', ');
  const cls = ['cell', wd === 0 ? 'sun' : wd === 6 ? 'sat' : '', day.slice(0, 7) !== month ? 'out' : '',
    day === today ? 'today' : '', day === selected ? 'sel' : ''].filter(Boolean).join(' ');
  return el('button', {
    type: 'button', class: cls, dataset: { date: day }, 'aria-label': label, 'aria-pressed': day === selected ? 'true' : 'false',
    onclick: () => { if (!calDrag.suppressClick) selectDay(day); calDrag.suppressClick = false; },
  }, el('span', { class: 'dnum', text: String(Number(day.slice(8))) }), el('span', { class: 'lines' }, lines), foot);
}

function selectDay(day) {
  const month = day.slice(0, 7);
  state.cal.selected = day;
  if (month !== state.cal.month) {
    state.cal.month = month;
    loadCal().catch(fail);
    return;
  }
  for (const c of document.querySelectorAll('#cal-grid .cell')) {
    const on = c.dataset.date === day;
    c.classList.toggle('sel', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  $('#cal-today').disabled = day === state.cal.data.today_seoul;
  renderDayPanel();
}

function gotoMonth(n) {
  const month = shiftMonth(state.cal.month, n);
  state.cal.month = month;
  // 옮긴 달에 오늘이 있으면 오늘, 없으면 1일을 고른다
  const today = state.cal.data ? state.cal.data.today_seoul : seoulToday();
  state.cal.selected = today.startsWith(month) ? today : `${month}-01`;
  loadCal().catch(fail);
}

// 고른 날에 할 일을 넣을 계획: 그날이 기간 안에 드는 계획 → 지금 고른 계획 → 첫 계획
function planForDay(day) {
  const covering = state.cal.data.plans.find((p) => p.start_date <= day && p.end_date >= day);
  return covering ? covering.id : state.plan ? state.plan.id : null;
}

async function openTaskInDo(t) {
  if (!state.plan || state.plan.id !== t.plan_id) {
    $('#plan-select').value = String(t.plan_id);
    await selectPlan(t.plan_id);
  }
  location.hash = `#task-${t.id}`;
}

function renderDayPanel() {
  const day = state.cal.selected;
  const today = state.cal.data.today_seoul;
  const items = calItemsOn(day);
  const diff = daysBetween(today, day);
  const rel = diff === 0 ? '오늘' : diff === 1 ? '내일' : diff === -1 ? '어제' : diff > 0 ? `${diff}일 뒤` : `${-diff}일 전`;
  $('#day-title').textContent = `${Number(day.slice(5, 7))}월 ${Number(day.slice(8))}일 (${WEEKDAYS[weekdayOf(day)]}) · ${rel}`;
  const noPlan = state.plans.length === 0;
  for (const id of ['#day-add-task', '#cal-fab']) {
    $(id).disabled = noPlan;
    $(id).title = noPlan ? '먼저 "Ⅰ 계획"에서 계획을 하나 만들어 주세요' : '';
  }

  const parts = [];
  if (items.plans.length) {
    parts.push(el('ul', { class: 'day-plans' }, items.plans.map((p) => {
      const n = daysBetween(p.start_date, day) + 1;
      const total = daysBetween(p.start_date, p.end_date) + 1;
      return el('li', {}, el('button', {
        type: 'button', class: `plan-chip ${planColor(p.id)}`,
        onclick: async () => {
          $('#plan-select').value = String(p.id);
          await selectPlan(p.id).catch(fail);
          location.hash = '#plan';
        },
      }, el('i', { 'aria-hidden': 'true' }), el('span', { text: p.title }), el('small', { text: ` ${n}/${total}일째` })));
    })));
  }

  parts.push(el('h4', { text: `할 일 ${items.tasks.length}개` }));
  if (items.tasks.length) {
    parts.push(el('ul', { class: 'day-tasks' }, items.tasks.map((t) => renderDayTask(t, day))));
  } else {
    parts.push(el('p', { class: 'hint', text: noPlan ? '아직 계획이 없습니다. "Ⅰ 계획"에서 계획을 먼저 만들면 여기서 할 일을 넣을 수 있습니다.' : '이날 마감인 할 일이 없습니다. "+ 할 일"로 넣어 보세요.' }));
  }

  if (items.logs.length) {
    const sum = items.logs.reduce((s, l) => s + l.actual_minutes, 0);
    parts.push(el('h4', { text: `실행 기록 ${items.logs.length}건 · ${hm(sum)}` }),
      el('ol', { class: 'log-list' }, items.logs.map((l) => el('li', { class: `log${l.blocked_reason.trim() ? ' blocked' : ''}` },
        el('div', { class: 'log-main' },
          el('span', { class: 'when', text: `${seoulTime.format(new Date(l.started_at))}~${seoulTime.format(new Date(l.ended_at))}` }),
          el('strong', { text: `${l.task_title} · ${hm(l.actual_minutes)}` })),
        l.blocked_reason.trim() ? el('p', { class: 'why' }, '막힌 이유 · ', l.blocked_reason) : null,
        l.note ? el('p', { class: 'note', text: l.note }) : null))));
  }
  if (items.exp) {
    const x = items.exp;
    parts.push(el('p', { class: 'carry' }, el('strong', { text: `5일 기록 ${x.day_no}일차 ` }),
      `${x.metric}: ${x.value === null ? '빠짐' : `${x.value}${x.unit}`}${x.note ? ` · ${x.note}` : ''}`));
  }
  $('#day-body').replaceChildren(...parts);
}

function renderDayTask(t, day) {
  const done = t.status === 'done';
  const check = el('button', {
    type: 'button', class: `check${done ? ' on' : ''}`, dataset: { key: newKey() },
    'aria-label': done ? `"${t.title}" 진행 중으로 되돌리기` : `"${t.title}" 완료`,
    onclick: (e) => (done ? reopenTask(t, e.currentTarget) : completeTask(t, e.currentTarget)),
  }, el('span', { class: 'tick', 'aria-hidden': 'true', text: '✓' }));
  const logBox = el('div', { class: 'day-log', hidden: true });
  return el('li', { class: `day-task ${planColor(t.plan_id)}${done ? ' done' : ''}${t.overdue ? ' overdue' : ''}`, id: `cal-task-${t.id}` },
    el('div', { class: 'task-row' },
      check,
      el('button', { type: 'button', class: 'day-task-title', onclick: () => openTaskInDo(t).catch(fail) },
        el('span', { class: 'name', text: t.title }),
        el('span', { class: 'meta' },
          el('span', { class: `prio p${t.priority}`, text: PRIORITY[t.priority] }),
          el('span', { text: `예상 ${hm(t.estimated_minutes)}` }),
          t.overdue ? el('span', { class: 'late', text: '지연' }) : null,
          ...t.tags.map((g) => el('span', { class: 'tag', text: `#${g}` })))),
      el('button', {
        type: 'button', class: 'btn ghost small', 'aria-expanded': 'false', text: '기록',
        onclick: (e) => {
          const open = logBox.hidden;
          if (open && !logBox.firstChild) logBox.append(renderLogForm(t, day));
          logBox.hidden = !open;
          e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
        },
      })),
    logBox);
}

function bindCal() {
  $('#cal-prev').addEventListener('click', () => gotoMonth(-1));
  $('#cal-next').addEventListener('click', () => gotoMonth(1));
  $('#cal-today').addEventListener('click', () => selectDay(state.cal.data ? state.cal.data.today_seoul : seoulToday()));
  const addOnDay = () => {
    const day = state.cal.selected;
    openTaskForm(null, { due_date: day, plan_id: planForDay(day) });
  };
  $('#day-add-task').addEventListener('click', addOnDay);
  $('#cal-fab').addEventListener('click', addOnDay);
  bindCalDrag();
  window.addEventListener('resize', debounce(() => { if (document.body.classList.contains('cal-mode') && state.cal && state.cal.data) renderCal(); }, 150));
}

// ---------- 달력 끌기 (네이버 캘린더처럼) ----------
// 마우스: 여러 날을 누른 채 끌면 그 기간으로 새 일정(계획) 창이 열린다. 할 일 줄을 끌어 다른 날에 놓으면 마감일이 옮겨진다.
// 휴대폰: 날짜를 꾹 누른 채(0.4초) 끌면 같은 동작. 꾹 누르고 바로 떼면 그날 할 일 추가. 옆으로 밀면 이전·다음 달.
const calDrag = { suppressClick: false, g: null };

function cellAt(x, y) {
  const node = document.elementFromPoint(x, y);
  return node && node.closest ? node.closest('#cal-grid .cell') : null;
}

function markRange(a, b) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  for (const c of document.querySelectorAll('#cal-grid .cell')) {
    c.classList.toggle('range', c.dataset.date >= lo && c.dataset.date <= hi);
  }
}

function markDrop(day) {
  for (const c of document.querySelectorAll('#cal-grid .cell')) c.classList.toggle('drop', c.dataset.date === day);
}

function clearDragMarks() {
  for (const c of document.querySelectorAll('#cal-grid .cell.range, #cal-grid .cell.drop')) c.classList.remove('range', 'drop');
  document.body.classList.remove('dragging');
}

async function moveTask(taskId, day) {
  const t = state.cal.data.tasks.find((x) => x.id === taskId);
  if (!t || t.due_date === day) return;
  try {
    await api('PATCH', `/api/tasks/${taskId}`, { due_date: day });
    say(`"${t.title}"의 마감일을 ${fmtDate(day)}(으)로 옮겼습니다.`);
    state.cal.selected = day;
    await refreshDoSee();
  } catch (err) { fail(err); }
}

function bindCalDrag() {
  const grid = $('#cal-grid');
  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const chip = e.target.closest('.chip[data-task]');
    const g = {
      id: e.pointerId, touch: e.pointerType !== 'mouse', x: e.clientX, y: e.clientY,
      start: cell.dataset.date, end: cell.dataset.date,
      task: chip ? Number(chip.dataset.task) : null, mode: 'pending', timer: null,
    };
    if (g.touch) {
      g.timer = setTimeout(() => {
        g.mode = g.task ? 'move' : 'range';
        if (navigator.vibrate) navigator.vibrate(15);
        document.body.classList.add('dragging');
        if (g.mode === 'range') markRange(g.start, g.end); else markDrop(g.end);
      }, 400);
    }
    calDrag.g = g;
  });
  grid.addEventListener('pointermove', (e) => {
    const g = calDrag.g;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.mode === 'pending') {
      if (Math.hypot(dx, dy) < 8) return;
      if (g.touch) { clearTimeout(g.timer); g.mode = 'swipe'; return; }
      // 마우스는 다른 날 칸으로 넘어가야 끌기로 본다 (누르다 살짝 흔들린 것은 그냥 클릭)
      const over = cellAt(e.clientX, e.clientY);
      if (!over || over.dataset.date === g.start) return;
      g.mode = g.task ? 'move' : 'range';
      document.body.classList.add('dragging');
    }
    if (g.mode === 'swipe') return;
    const cell = cellAt(e.clientX, e.clientY);
    if (!cell) return;
    g.end = cell.dataset.date;
    if (g.mode === 'range') markRange(g.start, g.end); else markDrop(g.end);
  });
  const finish = (e, cancelled) => {
    const g = calDrag.g;
    if (!g || g.id !== e.pointerId) return;
    calDrag.g = null;
    clearTimeout(g.timer);
    clearDragMarks();
    if (cancelled || g.mode === 'pending') return; // 그냥 누른 것은 click이 날짜를 고른다
    calDrag.suppressClick = true;
    setTimeout(() => { calDrag.suppressClick = false; }, 0);
    if (g.mode === 'swipe') {
      const dx = e.clientX - g.x;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - g.y) * 1.5) gotoMonth(dx < 0 ? 1 : -1);
    } else if (g.mode === 'move') {
      moveTask(g.task, g.end);
    } else if (g.start === g.end) {
      // 꾹 눌렀다 뗀 날 → 그날 할 일 추가
      selectDay(g.start);
      if (state.plans.length) openTaskForm(null, { due_date: g.start, plan_id: planForDay(g.start) });
    } else {
      const [a, b] = g.start <= g.end ? [g.start, g.end] : [g.end, g.start];
      openPlanForm('new', null, { start_date: a, end_date: b });
    }
  };
  grid.addEventListener('pointerup', (e) => finish(e, false));
  grid.addEventListener('pointercancel', (e) => finish(e, true));
  // 휴대폰에서 꾹 누를 때 뜨는 메뉴를 막는다
  grid.addEventListener('contextmenu', (e) => { if (calDrag.g && calDrag.g.touch) e.preventDefault(); });
}

// ---------- 시작 ----------
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function init() {
  await loadMe();
  $('#logout-btn').addEventListener('click', logout);
  $('#account-btn').addEventListener('click', () => $('#account-dialog').showModal());
  // 복구 코드는 창을 닫으면 화면에서 지운다.
  $('#account-dialog').addEventListener('close', () => { $('#recovery-value').hidden = true; $('#recovery-value').textContent = ''; });
  $('#pw-form').addEventListener('submit', submitPassword);
  $('#recovery-form').addEventListener('submit', submitRecovery);
  $('#delete-form').addEventListener('submit', submitDelete);
  bindExp();
  showView(viewOf(location.hash));
  window.addEventListener('hashchange', () => {
    const h = location.hash.slice(1);
    if (/^(task|log)-\d+$/.test(h)) jumpTo(h); else showView(viewOf(location.hash));
  });

  state.meta = await api('GET', '/api/meta');
  $('#f-sort').replaceChildren(...Object.entries(state.meta.sorts).map(([k, label]) => el('option', { value: k, text: label.split(' → ')[0] })));
  $('#plan-select').addEventListener('change', (e) => selectPlan(Number(e.target.value)).catch(fail));
  $('#new-plan-btn').addEventListener('click', () => openPlanForm('new'));
  $('#edit-plan-btn').addEventListener('click', () => openPlanForm('edit'));
  $('#plan-form').addEventListener('submit', submitPlan);
  $('#add-task-btn').addEventListener('click', () => openTaskForm(null));
  $('#task-form').addEventListener('submit', submitTask);
  for (const c of document.querySelectorAll('[data-cancel]')) {
    c.addEventListener('click', () => {
      const dlg = c.closest('dialog');
      if (dlg) dlg.close(); else c.closest('form').hidden = true;
    });
  }
  const reload = () => loadTasks().catch(fail);
  $('#f-q').addEventListener('input', debounce(reload, 250));
  for (const id of ['#f-status', '#f-priority', '#f-tag', '#f-sort']) $(id).addEventListener('change', reload);
  $('#f-toggle').addEventListener('click', (e) => {
    const box = $('#filters');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
  });
  $('#f-reset').addEventListener('click', () => {
    for (const id of ['#f-q', '#f-status', '#f-priority', '#f-tag']) $(id).value = '';
    $('#f-sort').value = 'due';
    reload();
  });
  $('#period-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const d = formData(e.currentTarget);
    state.period = { from: d.from, to: d.to };
    $('#evidence').hidden = true;
    loadReview().catch(fail);
  });
  $('#period-all').addEventListener('click', () => {
    $('#period-form').reset();
    state.period = { from: '', to: '' };
    $('#evidence').hidden = true;
    loadReview().catch(fail);
  });
  $('#retro-open').addEventListener('click', () => {
    const f = $('#retro-form');
    f.hidden = false;
    f.elements.improvement.focus();
  });
  $('#retro-form').addEventListener('submit', submitRetro);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-jump]');
    if (!a) return;
    e.preventDefault();
    jumpTo(a.dataset.jump);
  });
  bindCal();
  await Promise.all([loadPlans(), loadExp()]);
  const hash = location.hash.slice(1);
  if (/^(task|log)-\d+$/.test(hash)) jumpTo(hash);
}

init().catch(fail);
