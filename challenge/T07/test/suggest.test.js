'use strict';
// 자동완성 API. 실행: TEST_DATABASE_URL=... node --test test/suggest.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let S;
before(async () => { S = await startTestServer(); });
after(async () => { await S.close(); });

test('자동완성: 전에 쓴 할 일 이름(최근 순)·태그(많이 쓴 순)만, 지운 것과 남의 것은 빠진다', async () => {
  const plan = (await S.call('POST', '/api/plans', {
    title: '자동완성 계획', start_date: '2026-10-20', end_date: '2026-10-26', priority: 2, success_criteria: '검사', estimated_minutes: 0,
  })).json;
  const add = (title, tags) => S.call('POST', `/api/plans/${plan.id}/tasks`, { title, tags });
  await add('스쿼트', ['웨이트', '하체']);
  await add('벤치프레스', ['웨이트']);
  const gone = (await add('지울 할 일', ['지운태그'])).json;
  await S.call('DELETE', `/api/tasks/${gone.id}`);
  await add('스쿼트', ['하체', '웨이트']);

  const other = S.client();
  await other.signup('suggest_other');
  const op = (await other.call('POST', '/api/plans', {
    title: '남의 계획', start_date: '2026-10-20', end_date: '2026-10-26', priority: 2, success_criteria: '검사', estimated_minutes: 0,
  })).json;
  await other.call('POST', `/api/plans/${op.id}/tasks`, { title: '남의 할 일', tags: ['남의태그'] });

  const r = await S.call('GET', '/api/suggestions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.titles, ['스쿼트', '벤치프레스']);
  assert.deepEqual(r.json.tags, ['웨이트', '하체']);

  const theirs = (await other.call('GET', '/api/suggestions')).json;
  assert.deepEqual(theirs, { titles: ['남의 할 일'], tags: ['남의태그'] });

  const anon = S.client();
  assert.equal((await anon.call('GET', '/api/suggestions')).status, 401);
});
