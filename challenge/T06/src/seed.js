'use strict';
// 배포 직후 DB가 비어 있으면 seed/mine.json(내가 실제로 세운 계획과 기록)을 넣는다.
// 일반 API와 같은 서비스 함수를 거치므로 검증·수정 이력 규칙이 그대로 적용된다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const svc = require('./service');

const key = () => crypto.randomUUID().replace(/-/g, '');

async function seedIfEmpty(pool, file) {
  const seedPath = file || path.join(__dirname, '..', 'seed', 'mine.json');
  if (!fs.existsSync(seedPath)) return false;
  const { rows } = await pool.query('select count(*)::int as n from plans');
  if (rows[0].n > 0) return false;
  const data = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  for (const p of data.plans) {
    const plan = await svc.createPlan(pool, p.plan);
    for (const r of p.revisions || []) await svc.updatePlan(pool, plan.id, r);
    for (const t of p.tasks || []) {
      const task = await svc.createTask(pool, plan.id, t);
      for (const l of t.logs || []) await svc.createLog(pool, task.id, { ...l, idempotency_key: key() });
      if (t.completed_at) {
        await svc.completeTask(pool, task.id, { idempotency_key: key() });
        await pool.query('update task_completions set completed_at = $2 where task_id = $1 and undone_at is null', [task.id, t.completed_at]);
        await pool.query('update tasks set completed_at = $2 where id = $1', [task.id, t.completed_at]);
      }
    }
  }
  console.log(`seed: ${path.basename(seedPath)}에서 계획 ${data.plans.length}개를 넣었습니다`);
  return true;
}

module.exports = { seedIfEmpty };
