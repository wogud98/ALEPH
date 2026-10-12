'use strict';
// 화면에 사용자 글자를 넣을 때는 항상 textContent만 쓴다 (HTML 문자열로 넣지 않는다). 그래서 <script> 같은 글자도 글자 그대로 보인다.

const $ = (sel) => document.querySelector(sel);
const PRIORITY = { 1: '높음', 2: '보통', 3: '낮음' };
const state = {
  meta: null,
  plans: [],
  plan: null,
  tasks: [],
  allTasks: [],
  period: { from: '', to: '' },
  editingTaskId: null,
  carryRetro: null,
  planFormMode: 'edit',
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

function newKey() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('서버에 연결하지 못했습니다. 인터넷 연결을 확인하거나 잠시 뒤 새로고침하세요.');
  }
  const data = await res.json().catch(() => ({}));
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

const seoulDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
function fmtTime(isoStr) {
  if (!isoStr) return '';
  return seoulDate.format(new Date(isoStr));
}
// ISO(UTC) → datetime-local 입력값(서울)
function toSeoulInput(isoStr) {
  const d = new Date(new Date(isoStr).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 16);
}
// datetime-local 입력값(서울) → 시간대가 붙은 ISO
const fromSeoulInput = (v) => (v ? `${v}:00+09:00` : '');

function fmtMin(m) {
  const n = Number(m) || 0;
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const h = Math.floor(a / 60);
  const r = a % 60;
  const human = h ? `${h}시간${r ? ` ${r}분` : ''}` : `${r}분`;
  return `${sign}${a}분${h ? ` (${sign}${human})` : ''}`;
}
const fmtSigned = (n) => (n > 0 ? `+${fmtMin(n)}` : fmtMin(n));

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

// ---------- 계획 ----------
async function loadPlans(selectId) {
  state.plans = await api('GET', '/api/plans');
  const sel = $('#plan-select');
  sel.replaceChildren(...state.plans.map((p) => el('option', { value: p.id, text: `#${p.id} ${p.title}` })));
  $('#plan-empty').hidden = state.plans.length > 0;
  for (const id of ['#edit-plan-btn', '#add-task-btn']) $(id).disabled = state.plans.length === 0;
  if (!state.plans.length) {
    state.plan = null;
    $('#plan-view').replaceChildren();
    return;
  }
  const fromUrl = Number(new URLSearchParams(location.search).get('plan'));
  const want = selectId || fromUrl || state.plans[0].id;
  const pick = state.plans.find((p) => p.id === want) ? want : state.plans[0].id;
  sel.value = String(pick);
  await selectPlan(pick);
}

async function selectPlan(id) {
  state.plan = await api('GET', `/api/plans/${id}`);
  const url = new URL(location.href);
  url.searchParams.set('plan', id);
  history.replaceState(null, '', url);
  renderPlan();
  await Promise.all([loadTasks(), loadReview(), loadRetros()]);
}

function field(label, value, extra) {
  return el('div', { class: 'field' }, el('dt', { text: label }), el('dd', { class: extra }, value));
}

function renderPlan() {
  const p = state.plan;
  const view = $('#plan-view');
  const card = el('article', { class: 'card plan-card', id: `plan-${p.id}` },
    el('div', { class: 'plan-title' },
      el('span', { class: 'id', text: `계획 #${p.id}` }),
      el('h3', { text: p.title }),
      el('span', { class: 'badge', text: `${p.current_revision}판` })),
    p.carried_improvement
      ? el('p', { class: 'carry' }, el('strong', { text: `돌아보기 #${p.carried_from_retro_id}에서 넘어온 고칠 점` }), ' ', p.carried_improvement)
      : null,
    el('dl', { class: 'fields' },
      field('기간', `${p.start_date} ~ ${p.end_date}`),
      field('우선순위', PRIORITY[p.priority], `prio p${p.priority}`),
      field('예상 시간', fmtMin(p.estimated_minutes)),
      field('성공 기준', p.success_criteria, 'pre')),
  );
  view.replaceChildren(card);
  renderHistory();
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
  $('#history-count').textContent = `(${revs.length}판)`;
  const head = el('tr', {}, el('th', { text: '판' }), el('th', { text: '저장 시각' }),
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

function openPlanForm(mode, retro) {
  const f = $('#plan-form');
  state.planFormMode = mode;
  state.carryRetro = retro || null;
  f.reset();
  $('#plan-form-title').textContent = mode === 'edit' ? '계획 고치기 (고치기 전 판은 수정 이력에 남습니다)' : '새 계획';
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
    f.elements.success_criteria.value = `고칠 점 반영: ${retro.improvement}`;
  }
  f.hidden = false;
  document.getElementById('plan').scrollIntoView({ behavior: 'smooth' });
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
      say(`계획을 고쳤습니다. 지금 ${p.current_revision}판이고, 고치기 전 판은 수정 이력에 남아 있습니다.`);
      form.hidden = true;
      $('#history-box').open = true;
      await loadPlans(p.id);
    } else {
      if (state.carryRetro) body.carried_from_retro_id = state.carryRetro.id;
      const p = await api('POST', '/api/plans', body);
      say(`새 계획 #${p.id}을(를) 만들었습니다.`);
      form.hidden = true;
      await loadPlans(p.id);
    }
  } catch (err) {
    say(err.message, 'error');
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
  $('#task-count').textContent = `보이는 할 일 ${state.tasks.length}개 / 이 계획의 할 일 ${state.allTasks.length}개`;
  if (!state.tasks.length) {
    list.replaceChildren(el('li', { class: 'empty', text: state.allTasks.length ? '조건에 맞는 할 일이 없습니다.' : '아직 할 일이 없습니다. "할 일 추가"를 눌러 넣어 보세요.' }));
    return;
  }
  list.replaceChildren(...state.tasks.map(renderTask));
}

function renderTask(t) {
  const done = t.status === 'done';
  const actual = t.logs.reduce((s, l) => s + l.actual_minutes, 0);
  const blocked = t.logs.some((l) => l.blocked_reason.trim());
  const completeBtn = done
    ? el('button', { type: 'button', class: 'ghost', onclick: (e) => reopenTask(t, e.currentTarget), text: '진행 중으로 되돌리기' })
    : el('button', {
      type: 'button', class: 'primary', dataset: { key: newKey() },
      onclick: (e) => completeTask(t, e.currentTarget), text: '완료',
    });
  const logsBox = el('details', { class: 'logs', open: t.logs.length <= 3 ? true : undefined },
    el('summary', { text: `실행 기록 ${t.logs.length}건 · 실제 ${fmtMin(actual)}` }),
    t.logs.length
      ? el('ol', { class: 'log-list' }, t.logs.map((l) => renderLog(l)))
      : el('p', { class: 'hint', text: '아직 실행 기록이 없습니다.' }),
    el('details', { class: 'log-add' }, el('summary', { text: '+ 실행 기록 추가' }), renderLogForm(t)));
  return el('li', { class: `task${done ? ' done' : ''}${t.overdue ? ' overdue' : ''}`, id: `task-${t.id}`, tabindex: '-1' },
    el('div', { class: 'task-main' },
      el('div', { class: 'task-title' },
        el('span', { class: 'id', text: `#${t.id}` }),
        el('h3', { text: t.title }),
        el('span', { class: `state ${done ? 'is-done' : 'is-todo'}`, text: done ? '완료' : '진행 중' })),
      t.description ? el('p', { class: 'desc', text: t.description }) : null,
      el('ul', { class: 'meta' },
        el('li', { class: `prio p${t.priority}`, text: `우선순위 ${PRIORITY[t.priority]}` }),
        el('li', { class: t.overdue ? 'late' : undefined, text: t.due_date ? `마감 ${t.due_date}${t.overdue ? ' · 지연' : ''}` : '마감일 없음' }),
        el('li', { text: `예상 ${fmtMin(t.estimated_minutes)}` }),
        blocked ? el('li', { class: 'late', text: '막힘 있음' }) : null,
        done ? el('li', { text: `완료 ${fmtTime(t.completed_at)}` }) : null,
        ...t.tags.map((g) => el('li', { class: 'tag', text: `#${g}` })))),
    el('div', { class: 'task-actions' },
      completeBtn,
      el('button', { type: 'button', class: 'ghost', onclick: () => openTaskForm(t), text: '고치기' }),
      el('button', { type: 'button', class: 'ghost danger', onclick: (e) => deleteTask(t, e.currentTarget), text: '지우기' })),
    logsBox);
}

function renderLog(l) {
  return el('li', { class: `log${l.blocked_reason.trim() ? ' blocked' : ''}`, id: `log-${l.id}`, tabindex: '-1' },
    el('span', { class: 'id', text: `기록 #${l.id}` }),
    el('span', { text: `${fmtTime(l.started_at)} ~ ${fmtTime(l.ended_at)}` }),
    el('strong', { text: `실제 ${fmtMin(l.actual_minutes)}` }),
    l.blocked_reason.trim() ? el('span', { class: 'why' }, '막힌 이유: ', l.blocked_reason) : null,
    l.note ? el('span', { class: 'note', text: l.note }) : null,
    el('button', { type: 'button', class: 'link danger', onclick: (e) => deleteLog(l, e.currentTarget), text: '이 기록 지우기' }));
}

function renderLogForm(t) {
  const key = newKey();
  const now = toSeoulInput(new Date().toISOString());
  const form = el('form', { class: 'log-form', dataset: { key } },
    el('p', { class: 'hint', text: '실제로 한 일을 남깁니다. 계획과 할 일의 예상 값은 바뀌지 않습니다.' }),
    el('div', { class: 'grid' },
      el('label', {}, '시작 시각 (서울)', el('input', { name: 'started_at', type: 'datetime-local', required: true, value: now })),
      el('label', {}, '끝난 시각 (서울)', el('input', { name: 'ended_at', type: 'datetime-local', required: true, value: now })),
      el('label', {}, '실제로 걸린 시간(분)', el('input', { name: 'actual_minutes', type: 'number', min: 0, step: 1, placeholder: '비우면 끝-시작으로 계산' })),
      el('label', {}, '막혔던 이유', el('input', { name: 'blocked_reason', maxlength: 1000, placeholder: '없으면 비워 두기' })),
      el('label', { class: 'span2' }, '메모', el('input', { name: 'note', maxlength: 1000 }))),
    el('div', { class: 'actions' }, el('button', { type: 'submit', text: '실행 기록 저장' })));
  form.addEventListener('submit', (e) => addLog(e, t));
  return form;
}

function openTaskForm(t) {
  const f = $('#task-form');
  f.reset();
  state.editingTaskId = t ? t.id : null;
  $('#task-form-title').textContent = t ? `할 일 #${t.id} 고치기` : '할 일 추가';
  if (t) {
    f.elements.title.value = t.title;
    f.elements.due_date.value = t.due_date || '';
    f.elements.priority.value = String(t.priority);
    f.elements.estimated_minutes.value = t.estimated_minutes;
    f.elements.tags.value = t.tags.join(', ');
    f.elements.description.value = t.description;
  }
  f.hidden = false;
  f.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      const t = await api('POST', `/api/plans/${state.plan.id}/tasks`, body);
      say(`할 일 #${t.id}을(를) 만들었습니다.`);
    }
    form.hidden = true;
    await refreshDoSee();
  } catch (err) {
    say(err.message, 'error');
  } finally {
    busy(btn, false);
  }
}

// 완료 버튼은 그려질 때 요청 키를 하나 받는다. 두 번 눌러도 같은 키가 가므로 서버가 한 번만 기록한다.
async function completeTask(t, btn) {
  const key = btn.dataset.key;
  btn.classList.add('pending');
  try {
    const r = await api('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: key });
    say(r.duplicate ? `할 일 #${t.id}은(는) 이미 완료로 기록돼 있습니다 (중복 기록 없음).` : `할 일 #${t.id}을(를) 완료했습니다.`);
    await refreshDoSee();
  } catch (err) {
    say(err.message, 'error');
  } finally {
    btn.classList.remove('pending');
  }
}

async function reopenTask(t, btn) {
  busy(btn, true);
  try {
    await api('POST', `/api/tasks/${t.id}/reopen`);
    say(`할 일 #${t.id}을(를) 진행 중으로 되돌렸습니다.`);
    await refreshDoSee();
  } catch (err) {
    say(err.message, 'error');
    busy(btn, false);
  }
}

async function deleteTask(t, btn) {
  if (!confirm(`할 일 #${t.id} "${t.title}"을(를) 지울까요? 돌아보기 집계에서도 빠집니다.`)) return;
  busy(btn, true);
  try {
    await api('DELETE', `/api/tasks/${t.id}`);
    say(`할 일 #${t.id}을(를) 지웠습니다.`);
    await refreshDoSee();
  } catch (err) {
    say(err.message, 'error');
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
    say(r.duplicate ? '이미 저장된 기록입니다 (중복 저장 없음).' : `할 일 #${t.id}에 실행 기록 #${r.log.id}을(를) 남겼습니다.`);
    await refreshDoSee();
  } catch (err) {
    say(err.message, 'error');
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
    say(err.message, 'error');
    busy(btn, false);
  }
}

async function refreshDoSee() {
  await Promise.all([loadTasks(), loadReview()]);
}

// ---------- 돌아보기 ----------
const TILES = [
  ['planned', '계획 수', (r) => r.planned, '개'],
  ['done', '완료 수', (r) => r.done, '개'],
  ['delayed', '지연 수', (r) => r.delayed, '개'],
  ['blocked', '막힘 수', (r) => r.blocked, '개'],
  ['estimated', '예상 시간', (r) => r.estimated_minutes, '분'],
  ['actual', '실제 시간', (r) => r.actual_minutes, '분'],
];

function periodQuery() {
  const q = new URLSearchParams();
  if (state.period.from) q.set('from', state.period.from);
  if (state.period.to) q.set('to', state.period.to);
  return q;
}

async function loadReview() {
  if (!state.plan) return;
  const r = await api('GET', `/api/plans/${state.plan.id}/review?${periodQuery()}`);
  state.review = r;
  $('#today').textContent = r.today_seoul;
  $('#period-rule').textContent = `대상: ${r.period.rule}`;
  const tiles = TILES.map(([metric, label, get, unit]) => el('button', {
    type: 'button', class: `tile t-${metric}`, dataset: { metric },
    title: r.rules[metric], onclick: () => showEvidence(metric),
  },
  el('span', { class: 'tile-label', text: label }),
  el('span', { class: 'tile-num', text: String(get(r)) }),
  el('span', { class: 'tile-unit', text: unit === '분' && get(r) >= 60 ? `분 ${fmtMin(get(r)).replace(/^\d+분 /, '')}` : unit }),
  el('span', { class: 'tile-rule', text: r.rules[metric] })));
  const diffTile = el('button', {
    type: 'button', class: `tile t-diff ${r.diff_minutes > 0 ? 'over' : r.diff_minutes < 0 ? 'under' : ''}`,
    dataset: { metric: 'actual' }, title: '실제 시간 - 예상 시간', onclick: () => showEvidence('actual'),
  },
  el('span', { class: 'tile-label', text: '차이 (실제 - 예상)' }),
  el('span', { class: 'tile-num', text: r.diff_minutes > 0 ? `+${r.diff_minutes}` : String(r.diff_minutes) }),
  el('span', { class: 'tile-unit', text: '분' }),
  el('span', { class: 'tile-rule', text: `${fmtMin(r.actual_minutes)} - ${fmtMin(r.estimated_minutes)}` }));
  $('#tiles').replaceChildren(...tiles, diffTile);
}

async function showEvidence(metric) {
  const box = $('#evidence');
  try {
    const ev = await api('GET', `/api/plans/${state.plan.id}/review/evidence?metric=${metric}&${periodQuery()}`);
    const isTime = metric === 'estimated' || metric === 'actual';
    const head = el('div', { class: 'ev-head' },
      el('h3', { text: `${ev.label}의 근거` }),
      el('p', { class: 'hint', text: `조건: ${ev.rule}` }),
      el('p', { class: 'ev-total', text: isTime ? `합계 ${fmtMin(ev.total)} · 할 일 ${ev.tasks.length}개${metric === 'actual' ? ` · 실행 기록 ${ev.logs.length}건` : ''}` : `${ev.total}개` }),
      el('button', { type: 'button', class: 'ghost', onclick: () => { box.hidden = true; }, text: '닫기' }));
    const taskList = el('ol', { class: 'ev-list' }, ev.tasks.map((t) => el('li', {},
      el('a', { href: `#task-${t.id}`, dataset: { jump: `task-${t.id}` }, text: `할 일 #${t.id} ${t.title}` }),
      el('span', { class: 'hint', text: ` · ${t.status === 'done' ? '완료' : '진행 중'} · 마감 ${t.due_date || '없음'} · 예상 ${t.estimated_minutes}분` }))));
    const parts = [head];
    if (!ev.tasks.length) parts.push(el('p', { class: 'empty', text: '해당하는 기록이 없습니다 (0).' }));
    else parts.push(el('h4', { text: '할 일' }), taskList);
    if (ev.logs.length) {
      parts.push(el('h4', { text: metric === 'blocked' ? '막힌 이유가 적힌 실행 기록' : '실행 기록' }),
        el('ol', { class: 'ev-list' }, ev.logs.map((l) => el('li', {},
          el('a', { href: `#log-${l.id}`, dataset: { jump: `log-${l.id}`, task: l.task_id }, text: `기록 #${l.id} (할 일 #${l.task_id})` }),
          el('span', { class: 'hint', text: ` · ${fmtTime(l.started_at)} · 실제 ${l.actual_minutes}분${l.blocked_reason ? ` · 막힘: ${l.blocked_reason}` : ''}` })))));
    }
    box.replaceChildren(...parts);
    box.hidden = false;
    box.focus();
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    say(err.message, 'error');
  }
}

// 근거 링크를 누르면 거르기를 풀고 해당 할 일·기록으로 가서 표시한다.
async function jumpTo(id) {
  let target = document.getElementById(id);
  if (!target) {
    $('#f-q').value = '';
    $('#f-status').value = '';
    $('#f-priority').value = '';
    $('#f-tag').value = '';
    await loadTasks();
    target = document.getElementById(id);
  }
  if (!target) return say('그 기록을 찾지 못했습니다.', 'error');
  for (let d = target.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
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
    const pct = Math.round((Math.abs(diff) / max) * 50);
    const bar = el('span', { class: `bar ${diff > 0 ? 'over' : 'under'}` });
    bar.style.width = `${pct}%`;
    if (diff > 0) bar.style.left = '50%';
    else bar.style.right = '50%';
    return el('div', { class: 'gap-row' },
      el('a', { href: `#task-${t.id}`, dataset: { jump: `task-${t.id}` }, class: 'gap-name', text: `#${t.id} ${t.title}` }),
      el('span', { class: 'gap-track' }, el('span', { class: 'axis' }), bar),
      el('span', { class: 'gap-num', text: `예상 ${t.estimated_minutes} · 실제 ${actual} · ${diff > 0 ? '+' : ''}${diff}분` }));
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
    return el('li', { class: 'card retro', id: `retro-${r.id}` },
      el('div', { class: 'retro-head' },
        el('h3', { text: `돌아보기 #${r.id}` }),
        el('span', { class: 'hint', text: `${fmtTime(r.created_at)} 저장 · 대상: ${r.period_from || r.period_to ? `${r.period_from || '처음'} ~ ${r.period_to || '끝'}` : '계획 전체'}` })),
      el('p', { class: 'snap', text: `계획 ${s.planned} · 완료 ${s.done} · 지연 ${s.delayed} · 막힘 ${s.blocked} · 예상 ${s.estimated_minutes}분 · 실제 ${s.actual_minutes}분 · 차이 ${s.diff_minutes > 0 ? '+' : ''}${s.diff_minutes}분` }),
      r.went_well ? el('p', {}, el('strong', { text: '잘된 점 ' }), r.went_well) : null,
      r.went_wrong ? el('p', {}, el('strong', { text: '빗나간 점 ' }), r.went_wrong) : null,
      el('p', { class: 'carry' }, el('strong', { text: '다음 계획으로 넘길 고칠 점 ' }), r.improvement),
      r.carried_to_plan_id
        ? el('p', {}, '→ ', el('a', { href: `?plan=${r.carried_to_plan_id}#plan`, text: `계획 #${r.carried_to_plan_id}(으)로 넘어갔습니다` }))
        : el('button', { type: 'button', class: 'primary', onclick: () => openPlanForm('new', r), text: '이 고칠 점으로 다음 계획 만들기' }));
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
    await loadRetros();
  } catch (err) {
    say(err.message, 'error');
  } finally {
    busy(btn, false);
  }
}

// ---------- 시작 ----------
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function init() {
  state.meta = await api('GET', '/api/meta');
  $('#f-sort').replaceChildren(...Object.entries(state.meta.sorts).map(([k, label]) => el('option', { value: k, text: label.split(' → ')[0] })));
  $('#plan-select').addEventListener('change', (e) => selectPlan(Number(e.target.value)).catch((err) => say(err.message, 'error')));
  $('#new-plan-btn').addEventListener('click', () => openPlanForm('new'));
  $('#edit-plan-btn').addEventListener('click', () => openPlanForm('edit'));
  $('#plan-form').addEventListener('submit', submitPlan);
  $('#add-task-btn').addEventListener('click', () => openTaskForm(null));
  $('#task-form').addEventListener('submit', submitTask);
  for (const f of document.querySelectorAll('form')) {
    const c = f.querySelector('[data-cancel]');
    if (c) c.addEventListener('click', () => { f.hidden = true; });
  }
  const reload = () => loadTasks().catch((err) => say(err.message, 'error'));
  $('#f-q').addEventListener('input', debounce(reload, 250));
  for (const id of ['#f-status', '#f-priority', '#f-tag', '#f-sort']) $(id).addEventListener('change', reload);
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
    loadReview().catch((err) => say(err.message, 'error'));
  });
  $('#period-all').addEventListener('click', () => {
    $('#period-form').reset();
    state.period = { from: '', to: '' };
    $('#evidence').hidden = true;
    loadReview().catch((err) => say(err.message, 'error'));
  });
  $('#retro-form').addEventListener('submit', submitRetro);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-jump]');
    if (!a) return;
    e.preventDefault();
    jumpTo(a.dataset.jump);
  });
  await loadPlans();
  const hash = location.hash.slice(1);
  if (/^(task|log)-\d+$/.test(hash)) jumpTo(hash);
}

init().catch((err) => say(err.message, 'error'));
