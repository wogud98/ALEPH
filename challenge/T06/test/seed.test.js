'use strict';
// T06-C78~C81: seed/mine.json(내 실제 자료)이 빈 DB에 들어가고 돌아보기가 그 자료로 채워지는지 검사한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { seedIfEmpty } = require('../src/seed');

let S;
before(async () => { S = await startTestServer(); });
after(async () => { await S.close(); });

test('T06-C78~C81 내 계획 1개, 할 일 5개 이상, 실행 기록 3개 이상, 돌아보기 숫자가 모두 0은 아님', async () => {
  assert.equal(await seedIfEmpty(S.pool), true);
  assert.equal(await seedIfEmpty(S.pool), false, '이미 자료가 있으면 다시 넣지 않는다');
  const plans = (await S.call('GET', '/api/plans')).json;
  assert.ok(plans.length >= 1);
  const p = plans[0];
  const tasks = (await S.call('GET', `/api/plans/${p.id}/tasks`)).json.tasks;
  assert.ok(tasks.length >= 5, `할 일 ${tasks.length}개`);
  const logs = tasks.flatMap((t) => t.logs);
  assert.ok(logs.length >= 3, `실행 기록 ${logs.length}개`);
  const r = (await S.call('GET', `/api/plans/${p.id}/review`)).json;
  assert.ok([r.planned, r.done, r.delayed, r.blocked, r.estimated_minutes, r.actual_minutes].some((n) => n !== 0));
  assert.equal(r.planned, tasks.length);
  assert.equal(r.estimated_minutes, p.estimated_minutes, '할 일 예상 합계가 계획 예상 시간과 맞다');
  const done = tasks.filter((t) => t.status === 'done');
  assert.ok(done.every((t) => t.completed_at), '완료 시각이 들어 있다');
  const n = (await S.pool.query('select count(*)::int n from task_completions where undone_at is null')).rows[0].n;
  assert.equal(n, done.length);
});
