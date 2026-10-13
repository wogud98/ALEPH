'use strict';
// T06에 넣어 둔 내 자료를 내 T07 계정으로 한 번만 옮긴다.
//   * T06 서버는 같은 PostgreSQL의 public 스키마를 쓰고, T07은 t07 스키마를 쓴다.
//   * 환경 변수 T06_OWNER_USERNAME에 적은 아이디가 가입하거나 로그인하는 순간, public.* 을 읽어 t07에 그 계정 소유로 넣는다.
//   * t06_imports 표에 한 줄을 남겨 두 번 옮기지 않는다. T06 쪽 표는 읽기만 하고 고치지 않는다.
const { tx } = require('./db');

async function t06Exists(c) {
  const { rows } = await c.query(`select to_regclass('public.plans') is not null as ok`);
  return rows[0].ok;
}

async function importT06IfOwner(pool, user) {
  const owner = (process.env.T06_OWNER_USERNAME || '').trim().toLowerCase();
  if (!owner || user.username !== owner) return null;
  return tx(pool, async (c) => {
    await c.query('select pg_advisory_xact_lock(7070708)');
    if ((await c.query('select 1 from t06_imports')).rows[0]) return null;
    if (!(await t06Exists(c))) return null;
    const read = async (t) => (await c.query(`select * from public.${t} order by id`)).rows;
    const map = { plans: new Map(), tasks: new Map(), retros: new Map() };
    const counts = { plans: 0, plan_revisions: 0, tasks: 0, task_completions: 0, work_logs: 0, retrospectives: 0 };

    for (const p of await read('plans')) {
      const { rows } = await c.query(
        `insert into plans (owner_id, current_revision, title, start_date, end_date, priority, success_criteria,
                            estimated_minutes, carried_improvement, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [user.id, p.current_revision, p.title, p.start_date, p.end_date, p.priority, p.success_criteria,
          p.estimated_minutes, p.carried_improvement, p.created_at, p.updated_at],
      );
      map.plans.set(p.id, rows[0].id);
      counts.plans++;
    }
    for (const r of await read('plan_revisions')) {
      await c.query(
        `insert into plan_revisions (plan_id, revision_no, title, start_date, end_date, priority, success_criteria,
                                     estimated_minutes, change_reason, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [map.plans.get(r.plan_id), r.revision_no, r.title, r.start_date, r.end_date, r.priority, r.success_criteria,
          r.estimated_minutes, r.change_reason, r.created_at],
      );
      counts.plan_revisions++;
    }
    for (const t of await read('tasks')) {
      const { rows } = await c.query(
        `insert into tasks (plan_id, title, description, due_date, priority, tags, estimated_minutes, status,
                            completed_at, deleted_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [map.plans.get(t.plan_id), t.title, t.description, t.due_date, t.priority, t.tags, t.estimated_minutes,
          t.status, t.completed_at, t.deleted_at, t.created_at, t.updated_at],
      );
      map.tasks.set(t.id, rows[0].id);
      counts.tasks++;
    }
    for (const x of await read('task_completions')) {
      await c.query(
        `insert into task_completions (task_id, idempotency_key, completed_at, undone_at) values ($1,$2,$3,$4)`,
        [map.tasks.get(x.task_id), `t06-${x.idempotency_key}`.slice(0, 80), x.completed_at, x.undone_at],
      );
      counts.task_completions++;
    }
    for (const w of await read('work_logs')) {
      await c.query(
        `insert into work_logs (task_id, started_at, ended_at, actual_minutes, blocked_reason, note, idempotency_key, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [map.tasks.get(w.task_id), w.started_at, w.ended_at, w.actual_minutes, w.blocked_reason, w.note,
          `t06-${w.idempotency_key}`.slice(0, 80), w.created_at],
      );
      counts.work_logs++;
    }
    const retros = await read('retrospectives');
    for (const r of retros) {
      const { rows } = await c.query(
        `insert into retrospectives (plan_id, period_from, period_to, snapshot, went_well, went_wrong, improvement, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [map.plans.get(r.plan_id), r.period_from, r.period_to, r.snapshot, r.went_well, r.went_wrong, r.improvement, r.created_at],
      );
      map.retros.set(r.id, rows[0].id);
      counts.retrospectives++;
    }
    for (const p of await read('plans')) {
      if (p.carried_from_retro_id && map.retros.has(p.carried_from_retro_id)) {
        await c.query('update plans set carried_from_retro_id = $2 where id = $1',
          [map.plans.get(p.id), map.retros.get(p.carried_from_retro_id)]);
      }
    }
    await c.query('insert into t06_imports (owner_id, counts) values ($1, $2)', [user.id, counts]);
    return counts;
  });
}

async function importStatus(pool, uid) {
  const { rows } = await pool.query('select imported_at, counts from t06_imports where owner_id = $1', [uid]);
  return rows[0] ? { imported_at: new Date(rows[0].imported_at).toISOString(), counts: rows[0].counts } : null;
}

module.exports = { importT06IfOwner, importStatus };
