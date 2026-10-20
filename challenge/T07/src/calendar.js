'use strict';
// 달력: 한 기간(보통 한 달 + 앞뒤 주)에 걸친 내 계획 기간·할 일 마감·실행 기록·5일 기록을 한 번에 돌려준다.
// 계획이 여러 개여도 모두 한 달력에 모인다. 다른 API와 같이 세션의 user.id가 주인인 것만 읽는다.
const v = require('./validate');
const { bad } = v;

const SEOUL_TODAY = `(now() at time zone 'Asia/Seoul')::date`;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const MAX_DAYS = 62;

async function range(pool, uid, query) {
  const from = v.date(query, 'from', { label: '시작일', required: true });
  const to = v.date(query, 'to', { label: '종료일', required: true });
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (days < 0) throw bad('종료일이 시작일보다 앞설 수 없습니다');
  if (days >= MAX_DAYS) throw bad(`달력은 한 번에 ${MAX_DAYS}일까지만 볼 수 있습니다`);

  const [today, plans, tasks, logs, expDays] = await Promise.all([
    pool.query(`select ${SEOUL_TODAY}::text as today`),
    pool.query(
      `select id, title, start_date, end_date, priority from plans
       where owner_id = $1 and start_date <= $3 and end_date >= $2 order by start_date, id`,
      [uid, from, to],
    ),
    pool.query(
      `select t.id, t.plan_id, t.title, t.due_date, t.priority, t.status, t.estimated_minutes, t.tags,
              (t.status <> 'done' and t.due_date < ${SEOUL_TODAY}) as overdue
       from tasks t join plans p on p.id = t.plan_id
       where p.owner_id = $1 and t.deleted_at is null and t.due_date between $2 and $3
       order by t.due_date, t.status desc, t.priority, t.id`,
      [uid, from, to],
    ),
    // 실행 기록은 시작한 시각의 서울 날짜에 놓는다.
    pool.query(
      `select w.id, w.task_id, t.plan_id, t.title as task_title, w.started_at, w.ended_at, w.actual_minutes,
              w.blocked_reason, w.note, (w.started_at at time zone 'Asia/Seoul')::date::text as day
       from work_logs w join tasks t on t.id = w.task_id join plans p on p.id = t.plan_id
       where p.owner_id = $1 and t.deleted_at is null
         and (w.started_at at time zone 'Asia/Seoul')::date between $2 and $3
       order by w.started_at, w.id`,
      [uid, from, to],
    ),
    pool.query(
      `select d.id, d.day_no, d.day_date, d.value, d.note, e.unit, e.metric
       from experiment_days d join experiments e on e.id = d.experiment_id
       where e.owner_id = $1 and d.day_date between $2 and $3 order by d.day_date`,
      [uid, from, to],
    ),
  ]);

  return {
    from, to,
    today_seoul: today.rows[0].today,
    plans: plans.rows,
    tasks: tasks.rows,
    logs: logs.rows.map((r) => ({ ...r, started_at: iso(r.started_at), ended_at: iso(r.ended_at) })),
    experiment_days: expDays.rows,
  };
}

module.exports = { range, MAX_DAYS };
