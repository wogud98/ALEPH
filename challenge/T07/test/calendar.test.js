'use strict';
// 달력 API. 실행: TEST_DATABASE_URL=... node --test test/calendar.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, seoulToday, key } = require('./helpers');

let S;
before(async () => { S = await startTestServer(); });
after(async () => { await S.close(); });

test('달력: 여러 계획의 기간·마감·실행 기록·5일 기록이 날짜별로 한 번에 온다', async () => {
  const a = (await S.call('POST', '/api/plans', {
    title: '운동', start_date: seoulToday(-2), end_date: seoulToday(5), priority: 1, success_criteria: '주 3회', estimated_minutes: 300,
  })).json;
  const b = (await S.call('POST', '/api/plans', {
    title: '공부', start_date: seoulToday(1), end_date: seoulToday(3), priority: 2, success_criteria: '책 1권', estimated_minutes: 600,
  })).json;
  const far = (await S.call('POST', '/api/plans', {
    title: '먼 계획', start_date: seoulToday(100), end_date: seoulToday(110), priority: 3, success_criteria: '-', estimated_minutes: 0,
  })).json;
  const t1 = (await S.call('POST', `/api/plans/${a.id}/tasks`, { title: '하체', due_date: seoulToday(), estimated_minutes: 60 })).json;
  const t2 = (await S.call('POST', `/api/plans/${b.id}/tasks`, { title: '1장 읽기', due_date: seoulToday(2), estimated_minutes: 90 })).json;
  await S.call('POST', `/api/plans/${a.id}/tasks`, { title: '마감 없음', estimated_minutes: 10 });
  await S.call('POST', `/api/plans/${far.id}/tasks`, { title: '먼 할 일', due_date: seoulToday(105) });
  const gone = (await S.call('POST', `/api/plans/${a.id}/tasks`, { title: '지운 할 일', due_date: seoulToday() })).json;
  await S.call('DELETE', `/api/tasks/${gone.id}`);
  // 서울 기준 오늘 00:30에 시작한 기록 → UTC로는 어제지만 달력에는 오늘에 놓여야 한다
  const start = `${seoulToday()}T00:30:00+09:00`;
  const end = `${seoulToday()}T01:20:00+09:00`;
  const log = await S.call('POST', `/api/tasks/${t1.id}/logs`, { idempotency_key: key(), started_at: start, ended_at: end });
  assert.equal(log.status, 201, log.text);

  const r = await S.call('GET', `/api/calendar?from=${seoulToday(-3)}&to=${seoulToday(10)}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.today_seoul, seoulToday());
  assert.deepEqual(r.json.plans.map((p) => p.title), ['운동', '공부']);
  assert.deepEqual(r.json.tasks.map((t) => [t.id, t.due_date, t.plan_id]), [[t1.id, seoulToday(), a.id], [t2.id, seoulToday(2), b.id]]);
  assert.equal(r.json.logs.length, 1);
  assert.equal(r.json.logs[0].day, seoulToday());
  assert.equal(r.json.logs[0].task_title, '하체');
  assert.equal(r.json.logs[0].actual_minutes, 50);
});

test('달력: 남의 계획·할 일은 보이지 않는다', async () => {
  const other = S.client();
  await other.signup('cal_other');
  const p = (await other.call('POST', '/api/plans', {
    title: '남의 계획', start_date: seoulToday(), end_date: seoulToday(1), priority: 2, success_criteria: '-', estimated_minutes: 0,
  })).json;
  await other.call('POST', `/api/plans/${p.id}/tasks`, { title: '남의 할 일', due_date: seoulToday() });
  const mine = await S.call('GET', `/api/calendar?from=${seoulToday(-3)}&to=${seoulToday(10)}`);
  assert.ok(!mine.json.plans.some((x) => x.title === '남의 계획'));
  assert.ok(!mine.json.tasks.some((x) => x.title === '남의 할 일'));
  const theirs = await other.call('GET', `/api/calendar?from=${seoulToday(-3)}&to=${seoulToday(10)}`);
  assert.deepEqual(theirs.json.tasks.map((x) => x.title), ['남의 할 일']);
});

test('달력: 기간이 틀리거나 너무 길면 400, 로그인 안 하면 401', async () => {
  assert.equal((await S.call('GET', '/api/calendar')).status, 400);
  assert.equal((await S.call('GET', '/api/calendar?from=2026-10-10&to=2026-10-01')).status, 400);
  assert.equal((await S.call('GET', '/api/calendar?from=2026-01-01&to=2026-12-31')).status, 400);
  assert.equal((await S.call('GET', '/api/calendar?from=2026-02-30&to=2026-03-01')).status, 400);
  assert.equal((await S.call('GET', '/api/calendar?from=2026-10-01&to=2026-10-01', undefined, { cookie: '' })).status, 401);
});
