'use strict';
const { tx } = require('./db');
const v = require('./validate');
const { HttpError, bad } = v;

const SEOUL_TODAY = `(now() at time zone 'Asia/Seoul')::date`;

// ---------- 직렬화 ----------
// 시각은 UTC ISO 문자열, 날짜는 YYYY-MM-DD, 시간은 정수 분으로 고정한다.
const iso = (d) => (d ? new Date(d).toISOString() : null);

function planOut(r) {
  return {
    id: r.id,
    current_revision: r.current_revision,
    title: r.title,
    start_date: r.start_date,
    end_date: r.end_date,
    priority: r.priority,
    success_criteria: r.success_criteria,
    estimated_minutes: r.estimated_minutes,
    carried_from_retro_id: r.carried_from_retro_id,
    carried_improvement: r.carried_improvement,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function revisionOut(r) {
  return {
    id: r.id,
    plan_id: r.plan_id,
    revision_no: r.revision_no,
    title: r.title,
    start_date: r.start_date,
    end_date: r.end_date,
    priority: r.priority,
    success_criteria: r.success_criteria,
    estimated_minutes: r.estimated_minutes,
    change_reason: r.change_reason,
    created_at: iso(r.created_at),
  };
}

function logOut(r) {
  return {
    id: r.id,
    task_id: r.task_id,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    actual_minutes: r.actual_minutes,
    blocked_reason: r.blocked_reason,
    note: r.note,
    created_at: iso(r.created_at),
  };
}

function taskOut(r) {
  return {
    id: r.id,
    plan_id: r.plan_id,
    title: r.title,
    description: r.description,
    due_date: r.due_date,
    priority: r.priority,
    tags: r.tags,
    estimated_minutes: r.estimated_minutes,
    status: r.status,
    completed_at: iso(r.completed_at),
    deleted_at: iso(r.deleted_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    overdue: r.overdue === undefined ? undefined : r.overdue,
    logs: r.logs ? r.logs.map(logOut) : undefined,
  };
}

// ---------- 계획 ----------
function planFields(body, { partial }) {
  const req = !partial;
  const f = {
    title: v.text(body, 'title', { label: '계획 이름', required: req, max: 200 }),
    start_date: v.date(body, 'start_date', { label: '시작일', required: req }),
    end_date: v.date(body, 'end_date', { label: '종료일', required: req }),
    priority: v.priority(body, 'priority', { required: req }),
    success_criteria: v.text(body, 'success_criteria', { label: '성공 기준', required: req, max: 2000 }),
    estimated_minutes: v.int(body, 'estimated_minutes', { label: '예상 시간(분)', required: req, max: 100000 }),
  };
  for (const k of ['title', 'success_criteria']) {
    if (partial && f[k] === '') throw bad('빈 값으로 바꿀 수 없습니다');
  }
  for (const k of ['start_date', 'end_date']) {
    if (partial && f[k] === null) throw bad('기간은 비울 수 없습니다');
  }
  return f;
}

async function listPlans(pool) {
  const { rows } = await pool.query('select * from plans order by id');
  return rows.map(planOut);
}

async function getPlan(db, id) {
  const { rows } = await db.query('select * from plans where id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, '계획을 찾을 수 없습니다');
  const revs = await db.query('select * from plan_revisions where plan_id = $1 order by revision_no', [id]);
  return { ...planOut(rows[0]), revisions: revs.rows.map(revisionOut) };
}

async function createPlan(pool, body) {
  const f = planFields(body, { partial: false });
  if (f.end_date < f.start_date) throw bad('종료일은 시작일보다 앞설 수 없습니다');
  const carriedId = body.carried_from_retro_id == null ? null : v.idParam(body.carried_from_retro_id);
  return tx(pool, async (c) => {
    let carried = null;
    if (carriedId) {
      const r = await c.query('select improvement from retrospectives where id = $1', [carriedId]);
      if (!r.rows[0]) throw bad('넘겨받을 돌아보기를 찾을 수 없습니다');
      const used = await c.query('select id from plans where carried_from_retro_id = $1', [carriedId]);
      if (used.rows[0]) throw new HttpError(409, `이 고칠 점은 이미 계획 #${used.rows[0].id}로 넘어갔습니다`);
      carried = r.rows[0].improvement;
    }
    const { rows } = await c.query(
      `insert into plans (title, start_date, end_date, priority, success_criteria, estimated_minutes,
                          carried_from_retro_id, carried_improvement)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [f.title, f.start_date, f.end_date, f.priority, f.success_criteria, f.estimated_minutes, carriedId, carried],
    );
    const p = rows[0];
    await c.query(
      `insert into plan_revisions (plan_id, revision_no, title, start_date, end_date, priority, success_criteria,
                                   estimated_minutes, change_reason)
       values ($1, 1, $2, $3, $4, $5, $6, $7, '처음 세운 계획')`,
      [p.id, p.title, p.start_date, p.end_date, p.priority, p.success_criteria, p.estimated_minutes],
    );
    return getPlan(c, p.id);
  });
}

// 계획을 고치면 plans의 지금 값만 바뀌고, 새 판이 plan_revisions에 추가된다. 1판(처음 계획)은 그대로 남는다.
async function updatePlan(pool, id, body) {
  const f = planFields(body, { partial: true });
  const reason = v.text(body, 'change_reason', { label: '고친 이유', max: 500, def: '' });
  return tx(pool, async (c) => {
    const cur = (await c.query('select * from plans where id = $1 for update', [id])).rows[0];
    if (!cur) throw new HttpError(404, '계획을 찾을 수 없습니다');
    const next = {};
    for (const k of Object.keys(f)) next[k] = f[k] === undefined ? cur[k] : f[k];
    if (next.end_date < next.start_date) throw bad('종료일은 시작일보다 앞설 수 없습니다');
    const changed = Object.keys(next).some((k) => String(next[k]) !== String(cur[k]));
    if (!changed) throw bad('바뀐 내용이 없습니다');
    const rev = cur.current_revision + 1;
    await c.query(
      `update plans set title=$2, start_date=$3, end_date=$4, priority=$5, success_criteria=$6,
                        estimated_minutes=$7, current_revision=$8, updated_at=now()
       where id=$1`,
      [id, next.title, next.start_date, next.end_date, next.priority, next.success_criteria, next.estimated_minutes, rev],
    );
    await c.query(
      `insert into plan_revisions (plan_id, revision_no, title, start_date, end_date, priority, success_criteria,
                                   estimated_minutes, change_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, rev, next.title, next.start_date, next.end_date, next.priority, next.success_criteria, next.estimated_minutes, reason],
    );
    return getPlan(c, id);
  });
}

// ---------- 할 일 ----------
// 정렬 기준은 화면에 그대로 보여 준다. 값이 같으면 마지막에 ID로 순서를 고정해 볼 때마다 같은 순서가 나온다.
const SORTS = {
  due: {
    label: '마감일 빠른 순 → 같으면 우선순위 높은 순 → 같으면 먼저 만든 순(ID 작은 순). 마감일 없는 할 일은 맨 뒤',
    sql: 'due_date asc nulls last, priority asc, id asc',
  },
  priority: {
    label: '우선순위 높은 순 → 같으면 마감일 빠른 순(없으면 뒤) → 같으면 먼저 만든 순(ID 작은 순)',
    sql: 'priority asc, due_date asc nulls last, id asc',
  },
  estimate: {
    label: '예상 시간 긴 순 → 같으면 먼저 만든 순(ID 작은 순)',
    sql: 'estimated_minutes desc, id asc',
  },
  created: {
    label: '최근 만든 순(ID 큰 순)',
    sql: 'id desc',
  },
};

function taskFields(body, { partial }) {
  const f = {
    title: v.text(body, 'title', { label: '할 일', required: !partial, max: 200 }),
    description: v.text(body, 'description', { label: '설명', max: 2000 }),
    due_date: v.date(body, 'due_date', { label: '마감일' }),
    priority: v.priority(body, 'priority'),
    tags: v.tags(body, 'tags'),
    estimated_minutes: v.int(body, 'estimated_minutes', { label: '예상 시간(분)', max: 100000 }),
  };
  if (partial && f.title === '') throw bad('할 일 이름은 비울 수 없습니다');
  return f;
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const TASK_SELECT = `
  select t.*,
         (t.status <> 'done' and t.due_date < ${SEOUL_TODAY}) as overdue,
         coalesce((select json_agg(w order by w.started_at, w.id) from work_logs w where w.task_id = t.id), '[]') as logs
  from tasks t`;

async function listTasks(pool, planId, query) {
  await getPlan(pool, planId);
  const where = ['t.plan_id = $1', 't.deleted_at is null'];
  const params = [planId];
  const add = (sql, val) => {
    params.push(val);
    where.push(sql.replace('?', `$${params.length}`));
  };
  const q = (query.q || '').trim();
  if (q) {
    if (q.length > 100) throw bad('검색어는 100자 이하로 적어 주세요');
    add(`(t.title ilike ? or t.description ilike $${params.length + 1} or exists (select 1 from unnest(t.tags) tg where tg ilike $${params.length + 1}))`, `%${likeEscape(q)}%`);
  }
  if (query.status) {
    if (query.status === 'todo' || query.status === 'done') add('t.status = ?', query.status);
    else if (query.status === 'overdue') where.push(`t.status <> 'done' and t.due_date < ${SEOUL_TODAY}`);
    else if (query.status === 'blocked') where.push(`exists (select 1 from work_logs w where w.task_id = t.id and btrim(w.blocked_reason) <> '')`);
    else throw bad('알 수 없는 상태 조건입니다');
  }
  if (query.priority) add('t.priority = ?', v.priority({ p: query.priority }, 'p'));
  if (query.tag) add('? = any(t.tags)', String(query.tag).replace(/^#/, ''));
  const sortKey = query.sort || 'due';
  const sort = SORTS[sortKey];
  if (!sort) throw bad('알 수 없는 정렬 기준입니다');
  const orderSql = sort.sql.replace(/(^|, )/g, '$1t.');
  const { rows } = await pool.query(`${TASK_SELECT} where ${where.join(' and ')} order by ${orderSql}`, params);
  return { sort: sortKey, sort_label: sort.label, filtered_on: 'server', tasks: rows.map(taskOut) };
}

async function getTask(db, id, { lock = false } = {}) {
  const { rows } = await db.query(`select * from tasks where id = $1 and deleted_at is null${lock ? ' for update' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, '할 일을 찾을 수 없습니다');
  return rows[0];
}

async function taskWithLogs(db, id) {
  const { rows } = await db.query(`${TASK_SELECT} where t.id = $1`, [id]);
  return taskOut(rows[0]);
}

async function createTask(pool, planId, body) {
  const f = taskFields(body, { partial: false });
  await getPlan(pool, planId);
  const { rows } = await pool.query(
    `insert into tasks (plan_id, title, description, due_date, priority, tags, estimated_minutes)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [planId, f.title, f.description ?? '', f.due_date ?? null, f.priority ?? 2, f.tags ?? [], f.estimated_minutes ?? 0],
  );
  return taskWithLogs(pool, rows[0].id);
}

async function updateTask(pool, id, body) {
  const f = taskFields(body, { partial: true });
  const sets = [];
  const params = [id];
  for (const [k, val] of Object.entries(f)) {
    if (val === undefined) continue;
    params.push(val);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) throw bad('바꿀 내용이 없습니다');
  return tx(pool, async (c) => {
    await getTask(c, id, { lock: true });
    await c.query(`update tasks set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    return taskWithLogs(c, id);
  });
}

async function deleteTask(pool, id) {
  return tx(pool, async (c) => {
    await getTask(c, id, { lock: true });
    await c.query('update tasks set deleted_at = now(), updated_at = now() where id = $1', [id]);
    return { id, deleted: true };
  });
}

// 완료: 같은 요청 키는 한 번만 처리하고(멱등), 키가 달라도 DB의 부분 유일 색인이 "살아 있는 완료"를 1건으로 막는다.
async function completeTask(pool, id, body) {
  const key = v.idemKey(body);
  return tx(pool, async (c) => {
    const task = await getTask(c, id, { lock: true });
    const prev = await c.query('select * from task_completions where idempotency_key = $1', [key]);
    if (prev.rows[0]) {
      if (prev.rows[0].task_id !== id) throw new HttpError(409, '다른 할 일에 쓴 요청 키입니다');
      return { duplicate: true, completion_id: prev.rows[0].id, task: await taskWithLogs(c, id) };
    }
    if (task.status === 'done') {
      const act = await c.query('select id from task_completions where task_id = $1 and undone_at is null', [id]);
      return { duplicate: true, completion_id: act.rows[0] && act.rows[0].id, task: await taskWithLogs(c, id) };
    }
    const ins = await c.query(
      `insert into task_completions (task_id, idempotency_key) values ($1, $2)
       on conflict do nothing returning id, completed_at`,
      [id, key],
    );
    if (!ins.rows[0]) return { duplicate: true, task: await taskWithLogs(c, id) };
    await c.query(`update tasks set status = 'done', completed_at = $2, updated_at = now() where id = $1`, [id, ins.rows[0].completed_at]);
    return { duplicate: false, completion_id: ins.rows[0].id, task: await taskWithLogs(c, id) };
  });
}

async function reopenTask(pool, id) {
  return tx(pool, async (c) => {
    const task = await getTask(c, id, { lock: true });
    if (task.status !== 'done') return { changed: false, task: await taskWithLogs(c, id) };
    await c.query('update task_completions set undone_at = now() where task_id = $1 and undone_at is null', [id]);
    await c.query(`update tasks set status = 'todo', completed_at = null, updated_at = now() where id = $1`, [id]);
    return { changed: true, task: await taskWithLogs(c, id) };
  });
}

// ---------- 실행 기록 ----------
async function createLog(pool, taskId, body) {
  const key = v.idemKey(body);
  const started = v.timestamp(body, 'started_at', { label: '시작 시각', required: true });
  const ended = v.timestamp(body, 'ended_at', { label: '끝난 시각', required: true });
  if (ended < started) throw bad('끝난 시각은 시작 시각보다 앞설 수 없습니다');
  const span = Math.ceil((ended - started) / 60000);
  if (span > 24 * 60) throw bad('한 기록은 24시간을 넘을 수 없습니다');
  const actual = v.int(body, 'actual_minutes', { label: '실제로 걸린 시간(분)', max: span, def: span });
  const blocked = v.text(body, 'blocked_reason', { label: '막혔던 이유', max: 1000, def: '' });
  const note = v.text(body, 'note', { label: '메모', max: 1000, def: '' });
  return tx(pool, async (c) => {
    await getTask(c, taskId, { lock: true });
    const prev = await c.query('select * from work_logs where idempotency_key = $1', [key]);
    if (prev.rows[0]) return { duplicate: true, log: logOut(prev.rows[0]) };
    const { rows } = await c.query(
      `insert into work_logs (task_id, started_at, ended_at, actual_minutes, blocked_reason, note, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [taskId, started, ended, actual, blocked, note, key],
    );
    return { duplicate: false, log: logOut(rows[0]) };
  });
}

async function deleteLog(pool, id) {
  const { rowCount } = await pool.query('delete from work_logs where id = $1', [id]);
  if (!rowCount) throw new HttpError(404, '실행 기록을 찾을 수 없습니다');
  return { id, deleted: true };
}

// ---------- 돌아보기 ----------
// 숫자와 근거 목록이 같은 조건에서 나오도록, 지표마다 조건을 한 곳에만 둔다.
const METRICS = {
  planned: { label: '계획 수', where: 'true', rule: '이 계획에 딸린, 지우지 않은 할 일' },
  done: { label: '완료 수', where: `t.status = 'done'`, rule: '그중 지금 완료 상태인 할 일' },
  delayed: {
    label: '지연 수',
    where: `t.status <> 'done' and t.due_date < ${SEOUL_TODAY}`,
    rule: '완료되지 않았고 마감일이 서울 기준 오늘보다 앞선 할 일 (완료한 할 일은 세지 않음)',
  },
  blocked: {
    label: '막힘 수',
    where: `exists (select 1 from work_logs w where w.task_id = t.id and btrim(w.blocked_reason) <> '')`,
    rule: '막혔던 이유가 하나라도 적힌 실행 기록이 있는 할 일',
  },
  estimated: { label: '예상 시간', where: 't.estimated_minutes > 0', rule: '대상 할 일의 예상 시간 합계 (분)' },
  actual: {
    label: '실제 시간',
    where: 'exists (select 1 from work_logs w where w.task_id = t.id)',
    rule: '대상 할 일에 붙은 실행 기록의 실제 시간 합계 (분)',
  },
};

function periodFilter(query, params) {
  const from = v.date(query, 'from', { label: '기간 시작' }) || null;
  const to = v.date(query, 'to', { label: '기간 끝' }) || null;
  if (from && to && to < from) throw bad('기간 끝은 시작보다 앞설 수 없습니다');
  const where = [];
  if (from) { params.push(from); where.push(`t.due_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`t.due_date <= $${params.length}`); }
  return { from, to, where };
}

function targetCte(planId, query) {
  const params = [planId];
  const p = periodFilter(query, params);
  const where = ['t.plan_id = $1', 't.deleted_at is null', ...p.where];
  return { params, from: p.from, to: p.to, cte: `target as (select t.* from tasks t where ${where.join(' and ')})` };
}

async function review(db, planId, query = {}) {
  await getPlan(db, planId);
  const t = targetCte(planId, query);
  const { rows } = await db.query(
    `with ${t.cte}
     select
       (select count(*) from target t where ${METRICS.planned.where}) as planned,
       (select count(*) from target t where ${METRICS.done.where}) as done,
       (select count(*) from target t where ${METRICS.delayed.where}) as delayed,
       (select count(*) from target t where ${METRICS.blocked.where}) as blocked,
       (select coalesce(sum(t.estimated_minutes), 0) from target t) as estimated_minutes,
       (select coalesce(sum(w.actual_minutes), 0) from work_logs w join target t on t.id = w.task_id) as actual_minutes,
       ${SEOUL_TODAY}::text as today`,
    t.params,
  );
  const r = rows[0];
  const est = Number(r.estimated_minutes);
  const act = Number(r.actual_minutes);
  return {
    plan_id: planId,
    period: { from: t.from, to: t.to, rule: t.from || t.to ? '마감일이 이 기간 안에 있는 할 일' : '계획 전체' },
    today_seoul: r.today,
    unit: 'minutes',
    planned: r.planned,
    done: r.done,
    delayed: r.delayed,
    blocked: r.blocked,
    estimated_minutes: est,
    actual_minutes: act,
    diff_minutes: act - est,
    rules: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, m.rule])),
  };
}

async function evidence(pool, planId, query) {
  const metric = query.metric;
  const m = METRICS[metric];
  if (!m) throw bad('알 수 없는 지표입니다');
  await getPlan(pool, planId);
  const t = targetCte(planId, query);
  const { rows } = await pool.query(
    `with ${t.cte}
     select t.*, (t.status <> 'done' and t.due_date < ${SEOUL_TODAY}) as overdue,
            coalesce((select json_agg(w order by w.started_at, w.id) from work_logs w where w.task_id = t.id), '[]') as logs
     from target t where ${m.where} order by t.id`,
    t.params,
  );
  const tasks = rows.map(taskOut);
  let logs = [];
  if (metric === 'actual') logs = tasks.flatMap((x) => x.logs);
  if (metric === 'blocked') logs = tasks.flatMap((x) => x.logs.filter((l) => l.blocked_reason.trim() !== ''));
  let total = tasks.length;
  if (metric === 'estimated') total = tasks.reduce((s, x) => s + x.estimated_minutes, 0);
  if (metric === 'actual') total = logs.reduce((s, l) => s + l.actual_minutes, 0);
  return { metric, label: m.label, rule: m.rule, period: { from: t.from, to: t.to }, total, tasks, logs };
}

async function createRetro(pool, planId, body) {
  const improvement = v.text(body, 'improvement', { label: '다음 계획으로 넘길 고칠 점', required: true, max: 500 });
  const wentWell = v.text(body, 'went_well', { label: '잘된 점', max: 2000, def: '' });
  const wentWrong = v.text(body, 'went_wrong', { label: '빗나간 점', max: 2000, def: '' });
  return tx(pool, async (c) => {
    const snap = await review(c, planId, { from: body.from, to: body.to });
    const { rows } = await c.query(
      `insert into retrospectives (plan_id, period_from, period_to, snapshot, went_well, went_wrong, improvement)
       values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [planId, snap.period.from, snap.period.to, snap, wentWell, wentWrong, improvement],
    );
    return retroOut(rows[0]);
  });
}

function retroOut(r) {
  return {
    id: r.id,
    plan_id: r.plan_id,
    period_from: r.period_from,
    period_to: r.period_to,
    snapshot: r.snapshot,
    went_well: r.went_well,
    went_wrong: r.went_wrong,
    improvement: r.improvement,
    created_at: iso(r.created_at),
    carried_to_plan_id: r.carried_to_plan_id ?? null,
  };
}

async function listRetros(pool, planId) {
  await getPlan(pool, planId);
  const { rows } = await pool.query(
    `select r.*, (select p.id from plans p where p.carried_from_retro_id = r.id) as carried_to_plan_id
     from retrospectives r where r.plan_id = $1 order by r.id desc`,
    [planId],
  );
  return rows.map(retroOut);
}

// ---------- 내보내기 ----------
async function exportAll(pool) {
  const q = async (sql) => (await pool.query(sql)).rows;
  const [plans, revisions, tasks, completions, logs, retros, today] = await Promise.all([
    q('select * from plans order by id'),
    q('select * from plan_revisions order by plan_id, revision_no'),
    q('select * from tasks order by id'),
    q('select * from task_completions order by id'),
    q('select * from work_logs order by id'),
    q('select r.*, (select p.id from plans p where p.carried_from_retro_id = r.id) as carried_to_plan_id from retrospectives r order by id'),
    q(`select ${SEOUL_TODAY}::text as d`),
  ]);
  const reviews = [];
  for (const p of plans) reviews.push(await review(pool, p.id));
  return {
    format: 'pds-export',
    schema: 'contracts/pds-schema-v2.json',
    schema_version: 2,
    exported_at: new Date().toISOString(),
    today_seoul: today[0].d,
    rules: { timestamps: 'UTC ISO 8601', dates: 'YYYY-MM-DD (Asia/Seoul 달력)', durations: 'minutes (정수)' },
    plans: plans.map(planOut),
    plan_revisions: revisions.map(revisionOut),
    tasks: tasks.map(taskOut),
    task_completions: completions.map((r) => ({
      id: r.id, task_id: r.task_id, completed_at: iso(r.completed_at), undone_at: iso(r.undone_at),
    })),
    work_logs: logs.map(logOut),
    retrospectives: retros.map(retroOut),
    reviews,
  };
}

async function meta(pool) {
  const { rows } = await pool.query(`select ${SEOUL_TODAY}::text as today`);
  return {
    today_seoul: rows[0].today,
    timezone: 'Asia/Seoul',
    sorts: Object.fromEntries(Object.entries(SORTS).map(([k, s]) => [k, s.label])),
    metrics: Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, { label: m.label, rule: m.rule }])),
  };
}

module.exports = {
  listPlans, getPlan, createPlan, updatePlan,
  listTasks, createTask, updateTask, deleteTask, completeTask, reopenTask,
  createLog, deleteLog,
  review, evidence, createRetro, listRetros,
  exportAll, meta, SORTS, METRICS,
};
