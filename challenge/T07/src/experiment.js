'use strict';
// 5일 기록: 1일차에 질문·지표·단위·계산 규칙·계획 규칙을 정하고, 서로 다른 서울 날짜 5일을 적는다.
// 2일차 기록 뒤, 3일차 기록 앞에 계획 규칙을 딱 한 번 바꾼다. 전후 비교는 같은 지표·단위·계산 규칙으로 한다.
const { tx } = require('./db');
const v = require('./validate');
const { HttpError, bad } = v;

const SEOUL_TODAY = `(now() at time zone 'Asia/Seoul')::date`;
const iso = (d) => (d ? new Date(d).toISOString() : null);

// 값 처리 규칙. 코드가 이 문장대로 계산하므로 사용자가 바꿀 수 없게 고정해 두고 화면에 그대로 보여 준다.
const RULES = {
  day: 'n일차 = Asia/Seoul 달력에서 서로 다른 날짜를 이른 순서대로 센 번째 (최대 5일). 기록은 그날(서울) 또는 바로 전날 것만 적을 수 있고, 앞선 기록보다 늦은 날짜여야 한다.',
  missing: '그날 값을 못 쟀으면 값 칸을 비운 채 그날 기록만 남긴다(빠짐). 빠진 날은 합계에 0으로 넣지 않고, 평균을 낼 때 나누는 날 수에서도 뺀다.',
  duplicate: '한 날짜에는 기록 한 줄만 둔다. 같은 날짜를 또 저장하면 서버가 409로 거절하고 처음 값을 그대로 둔다.',
  outlier: '유난히 튀는 값도 지우거나 잘라 내지 않고 그대로 계산에 넣는다. 대신 그날 메모에 왜 튀었는지 적는다.',
  rounding: '합계는 정수 그대로 둔다. 평균은 소수 둘째 자리에서 반올림해 소수 첫째 자리까지 보인다 (예: 52.25 → 52.3).',
  week_start: '한 주는 월요일에 시작한다 (Asia/Seoul).',
  compare: '규칙을 바꾸기 전(1·2일차)과 바꾼 뒤(3~5일차)를 같은 지표·같은 단위·같은 계산 규칙(위 빠짐·중복·튐·반올림 규칙)으로 비교한다.',
};

function defFields(body, { partial }) {
  const req = !partial;
  return {
    question: v.text(body, 'question', { label: '답하려는 질문', required: req, max: 300 }),
    metric: v.text(body, 'metric', { label: '관찰 지표', required: req, max: 100 }),
    unit: v.text(body, 'unit', { label: '단위', required: req, max: 20 }),
    calc_rule: v.text(body, 'calc_rule', { label: '하루 값 계산 규칙', required: req, max: 500 }),
    plan_rule: v.text(body, 'plan_rule', { label: '계획 규칙', required: req, max: 500 }),
  };
}

const expOut = (r) => r && ({
  id: r.id, question: r.question, metric: r.metric, unit: r.unit, calc_rule: r.calc_rule,
  plan_rule: r.plan_rule, created_at: iso(r.created_at),
});
const dayOut = (r) => ({
  id: r.id, day_no: r.day_no, day_date: r.day_date, value: r.value, plan_rule: r.plan_rule,
  note: r.note, created_at: iso(r.created_at), phase: r.day_no <= 2 ? 'before' : 'after',
});
const changeOut = (r) => r && ({
  id: r.id, day1_id: r.day1_id, day2_id: r.day2_id, old_rule: r.old_rule, new_rule: r.new_rule,
  reason: r.reason, changed_at: iso(r.changed_at),
});

async function findExp(db, uid, { lock = false } = {}) {
  const { rows } = await db.query(`select * from experiments where owner_id = $1${lock ? ' for update' : ''}`, [uid]);
  return rows[0] || null;
}

// 합계·평균은 SQL에서 한 번에 계산한다 (반올림 = numeric round, 소수 첫째 자리).
async function summarize(db, expId) {
  const { rows } = await db.query(
    `select phase,
            count(*)::int as days,
            count(value)::int as recorded,
            (count(*) - count(value))::int as missing,
            coalesce(sum(value), 0)::int as sum,
            case when count(value) = 0 then null else round(sum(value)::numeric / count(value), 1)::text end as avg
     from (select case when day_no <= 2 then 'before' else 'after' end as phase, value
           from experiment_days where experiment_id = $1
           union all
           select 'all', value from experiment_days where experiment_id = $1) d
     group by phase`,
    [expId],
  );
  const out = {};
  for (const p of ['before', 'after', 'all']) {
    const r = rows.find((x) => x.phase === p) || { days: 0, recorded: 0, missing: 0, sum: 0, avg: null };
    out[p] = { days: r.days, recorded: r.recorded, missing: r.missing, sum: r.sum, avg: r.avg === null ? null : Number(r.avg) };
  }
  return out;
}

async function get(db, uid) {
  const exp = await findExp(db, uid);
  const today = (await db.query(`select ${SEOUL_TODAY}::text as d`)).rows[0].d;
  if (!exp) return { today_seoul: today, rules: RULES, experiment: null, days: [], rule_change: null, summary: null };
  const days = (await db.query('select * from experiment_days where experiment_id = $1 order by day_no', [exp.id])).rows;
  const change = (await db.query('select * from experiment_rule_changes where experiment_id = $1', [exp.id])).rows[0];
  return {
    today_seoul: today,
    rules: RULES,
    experiment: expOut(exp),
    locked: days.length > 0,
    days: days.map(dayOut),
    rule_change: changeOut(change),
    summary: await summarize(db, exp.id),
  };
}

// 1일차 기록 전에는 다섯 칸을 모두 고칠 수 있다. 1일차가 생기면 질문·지표·단위·계산 규칙은 잠기고(DB 트리거),
// 계획 규칙은 "규칙 바꾸기"로만 바꾼다.
async function define(pool, uid, body) {
  return tx(pool, async (c) => {
    const exp = await findExp(c, uid, { lock: true });
    if (!exp) {
      const f = defFields(body, { partial: false });
      await c.query(
        'insert into experiments (owner_id, question, metric, unit, calc_rule, plan_rule) values ($1,$2,$3,$4,$5,$6)',
        [uid, f.question, f.metric, f.unit, f.calc_rule, f.plan_rule],
      );
      return get(c, uid);
    }
    const n = (await c.query('select count(*)::int n from experiment_days where experiment_id = $1', [exp.id])).rows[0].n;
    if (n > 0) throw new HttpError(409, '1일차 기록이 있어 질문·지표·단위·규칙을 고칠 수 없습니다. 계획 규칙은 2일차 뒤 "규칙 바꾸기"로 한 번만 바꿉니다');
    const f = defFields(body, { partial: true });
    const next = {};
    for (const k of Object.keys(f)) {
      if (f[k] === '') throw bad('빈 값으로 바꿀 수 없습니다');
      next[k] = f[k] === undefined ? exp[k] : f[k];
    }
    await c.query(
      'update experiments set question=$2, metric=$3, unit=$4, calc_rule=$5, plan_rule=$6 where id=$1',
      [exp.id, next.question, next.metric, next.unit, next.calc_rule, next.plan_rule],
    );
    return get(c, uid);
  });
}

async function addDay(pool, uid, body) {
  const date = v.date(body, 'day_date', { label: '날짜', required: true });
  let value = null;
  if (!(body.value === null || body.value === undefined || body.value === '')) {
    value = v.int(body, 'value', { label: '값', min: 0, max: 1000000 });
  }
  const note = v.text(body, 'note', { label: '메모', max: 1000, def: '' });
  return tx(pool, async (c) => {
    const exp = await findExp(c, uid, { lock: true });
    if (!exp) throw new HttpError(409, '먼저 질문·지표·단위·규칙을 정하세요');
    const today = (await c.query(`select ${SEOUL_TODAY}::text as d, (${SEOUL_TODAY} - 1)::text as y`)).rows[0];
    if (date > today.d) throw bad('오늘(서울)보다 뒤 날짜는 적을 수 없습니다');
    if (date < today.y) throw bad('기록은 오늘(서울) 또는 어제 날짜만 적을 수 있습니다');
    const days = (await c.query('select * from experiment_days where experiment_id = $1 order by day_no', [exp.id])).rows;
    if (days.some((d) => d.day_date === date)) throw new HttpError(409, `${date}에는 이미 기록이 있습니다 (중복은 받지 않습니다)`);
    if (days.length >= 5) throw new HttpError(409, '5일 기록을 모두 채웠습니다');
    const last = days[days.length - 1];
    if (last && date < last.day_date) throw bad('앞선 기록보다 이른 날짜는 적을 수 없습니다');
    const change = (await c.query('select id from experiment_rule_changes where experiment_id = $1', [exp.id])).rows[0];
    if (days.length === 2 && !change) throw new HttpError(409, '3일차를 적기 전에 계획 규칙을 하나 바꾸세요');
    const { rows } = await c.query(
      `insert into experiment_days (experiment_id, day_no, day_date, value, plan_rule, note)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [exp.id, days.length + 1, date, value, exp.plan_rule, note],
    );
    return { day: dayOut(rows[0]), ...(await get(c, uid)) };
  });
}

// 잘못 적은 마지막 기록만 지울 수 있다. 규칙 변경이 가리키는 1·2일차는 지울 수 없다.
async function deleteDay(pool, uid, id) {
  return tx(pool, async (c) => {
    const exp = await findExp(c, uid, { lock: true });
    const day = exp && (await c.query('select * from experiment_days where id = $1 and experiment_id = $2', [id, exp.id])).rows[0];
    if (!day) throw new HttpError(404, '기록을 찾을 수 없습니다');
    const max = (await c.query('select max(day_no) m from experiment_days where experiment_id = $1', [exp.id])).rows[0].m;
    if (day.day_no !== max) throw new HttpError(409, '마지막 기록만 지울 수 있습니다');
    const change = (await c.query('select id from experiment_rule_changes where experiment_id = $1', [exp.id])).rows[0];
    if (change && day.day_no <= 2) throw new HttpError(409, '규칙 변경이 가리키는 1·2일차 기록은 지울 수 없습니다');
    await c.query('delete from experiment_days where id = $1', [id]);
    return get(c, uid);
  });
}

async function changeRule(pool, uid, body) {
  const newRule = v.text(body, 'new_rule', { label: '바꾼 계획 규칙', required: true, max: 500 });
  const reason = v.text(body, 'reason', { label: '바꾼 이유', required: true, max: 500 });
  return tx(pool, async (c) => {
    const exp = await findExp(c, uid, { lock: true });
    if (!exp) throw new HttpError(409, '먼저 질문·지표·단위·규칙을 정하세요');
    const days = (await c.query('select * from experiment_days where experiment_id = $1 order by day_no', [exp.id])).rows;
    const done = (await c.query('select id from experiment_rule_changes where experiment_id = $1', [exp.id])).rows[0];
    if (done) throw new HttpError(409, '계획 규칙은 한 번만 바꿉니다');
    if (days.length !== 2) throw new HttpError(409, `규칙은 2일차 기록 뒤, 3일차 기록 앞에 바꿉니다 (지금 ${days.length}일 기록)`);
    if (newRule === exp.plan_rule) throw bad('지금 규칙과 같습니다');
    await c.query(
      `insert into experiment_rule_changes (experiment_id, day1_id, day2_id, old_rule, new_rule, reason)
       values ($1,$2,$3,$4,$5,$6)`,
      [exp.id, days[0].id, days[1].id, exp.plan_rule, newRule, reason],
    );
    await c.query('update experiments set plan_rule = $2 where id = $1', [exp.id, newRule]);
    return get(c, uid);
  });
}

module.exports = { RULES, get, define, addDay, deleteDay, changeRule };
