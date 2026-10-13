'use strict';
// T07 카드 5 — 5일 기록 (C04~C27, C132). 실행: TEST_DATABASE_URL=... node --test test/experiment.test.js
// 실제 날짜 5일을 검사 안에서 기다릴 수 없으므로, 앞선 날짜는 DB에 직접 넣고 오늘·어제 기록은 API로 넣는다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, seoulToday } = require('./helpers');

let S;
before(async () => { S = await startTestServer(); });
after(async () => { await S.close(); });

const DEF = {
  question: '운동을 아침으로 옮기면 실제로 운동한 시간이 늘어날까?',
  metric: '하루 실제 운동 시간',
  unit: '분',
  calc_rule: '그날(서울) 시작한 운동 실행 기록의 실제 시간을 모두 더한 값',
  plan_rule: '운동은 퇴근 뒤 저녁 8시에 계획한다',
};

// created_at: 규칙 변경 전 날은 그날 밤 10시(서울), 규칙 변경 뒤 날은 지금(now)으로 넣는다.
async function insertDay(expId, no, date, value, rule, { now = false } = {}) {
  await S.pool.query(
    `insert into experiment_days (experiment_id, day_no, day_date, value, plan_rule, created_at)
     values ($1,$2,$3,$4,$5, ${now ? 'clock_timestamp()' : `($3::date + time '22:00') at time zone 'Asia/Seoul'`})`,
    [expId, no, date, value, rule],
  );
}

test('5일 기록: 정하기 → 1·2일차 → 규칙 변경 → 3~5일차, 순서·잠금·합계·평균', async () => {
  // 정하기 전에는 기록할 수 없다
  assert.equal((await S.call('POST', '/api/experiment/days', { day_date: seoulToday(), value: 1 })).status, 409);

  // T07-C04~C06 질문·지표·단위를 정한다 (값 처리 규칙 C23~C27은 서버가 고정해 함께 돌려준다)
  const d = await S.call('PUT', '/api/experiment', DEF);
  assert.equal(d.status, 200, d.text);
  for (const k of ['missing', 'duplicate', 'outlier', 'rounding', 'week_start']) assert.ok(d.json.rules[k].length > 10, k);
  assert.match(d.json.rules.week_start, /월요일/);
  const expId = d.json.experiment.id;

  // 1·2일차 (4일 전, 3일 전)
  await insertDay(expId, 1, seoulToday(-4), 30, DEF.plan_rule);
  await insertDay(expId, 2, seoulToday(-3), 45, DEF.plan_rule);

  // C04~C06 1일차가 생기면 질문·지표·단위는 고칠 수 없다 (API와 DB 트리거 모두)
  assert.equal((await S.call('PUT', '/api/experiment', { metric: '다른 지표' })).status, 409);
  await assert.rejects(S.pool.query(`update experiments set unit = '시간' where id = $1`, [expId]));

  // C09 3일차를 규칙 변경보다 먼저 적을 수 없다
  const early = await S.call('POST', '/api/experiment/days', { day_date: seoulToday(-1), value: 50 });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /3일차를 적기 전에/);

  // C10~C12 규칙 변경: 시각·이유가 남고 1·2일차를 가리킨다
  const days12 = (await S.call('GET', '/api/experiment')).json.days;
  const ch = await S.call('POST', '/api/experiment/rule-change', { new_rule: '운동은 출근 전 아침 7시에 계획한다', reason: '1·2일차 모두 저녁 약속으로 밀렸다' });
  assert.equal(ch.status, 201, ch.text);
  const rc = ch.json.rule_change;
  assert.equal(rc.day1_id, days12[0].id);
  assert.equal(rc.day2_id, days12[1].id);
  assert.equal(rc.old_rule, DEF.plan_rule);
  assert.ok(rc.reason && rc.changed_at);
  assert.ok(new Date(rc.changed_at) > new Date(days12[1].created_at), '2일차 기록 뒤');
  assert.equal((await S.call('POST', '/api/experiment/rule-change', { new_rule: '또', reason: '또' })).status, 409, '한 번만');

  // 3일차 (2일 전, DB) → 4일차 (어제, API) → 5일차 (오늘, API, 값 빠짐)
  await insertDay(expId, 3, seoulToday(-2), 60, rc.new_rule, { now: true });
  const d4 = await S.call('POST', '/api/experiment/days', { day_date: seoulToday(-1), value: 55, note: '' });
  assert.equal(d4.status, 201, d4.text);
  assert.equal(d4.json.day.day_no, 4);
  assert.equal(d4.json.day.plan_rule, rc.new_rule);
  // C24 같은 날짜 중복은 거절
  assert.equal((await S.call('POST', '/api/experiment/days', { day_date: seoulToday(-1), value: 99 })).status, 409);
  // 미래·너무 이른 날짜는 거절
  assert.equal((await S.call('POST', '/api/experiment/days', { day_date: seoulToday(1), value: 1 })).status, 400);
  assert.equal((await S.call('POST', '/api/experiment/days', { day_date: seoulToday(-5), value: 1 })).status, 400);
  // C23 값이 빠진 날
  const d5 = await S.call('POST', '/api/experiment/days', { day_date: seoulToday(), value: null, note: '야근으로 못 함' });
  assert.equal(d5.status, 201, d5.text);
  assert.equal((await S.call('POST', '/api/experiment/days', { day_date: seoulToday(), value: 1 })).status, 409);

  // C07 서로 다른 날짜 정확히 5일, C09 규칙 변경은 2일차 뒤·3일차 앞
  const all = (await S.call('GET', '/api/experiment')).json;
  assert.equal(all.days.length, 5);
  assert.equal(new Set(all.days.map((x) => x.day_date)).size, 5);
  assert.ok(new Date(all.rule_change.changed_at) < new Date(all.days[2].created_at), '3일차 기록 앞');
  assert.deepEqual(all.days.map((x) => x.phase), ['before', 'before', 'after', 'after', 'after']);

  // C132, C13~C15 합계·평균 = 손으로 더한 값 (같은 지표·단위·계산 규칙)
  // 전: (30 + 45) ÷ 2 = 37.5 / 뒤: (60 + 55) ÷ 2 = 57.5 (5일차 빠짐) / 전체: 190 ÷ 4 = 47.5
  assert.deepEqual(all.summary.before, { days: 2, recorded: 2, missing: 0, sum: 75, avg: 37.5 });
  assert.deepEqual(all.summary.after, { days: 3, recorded: 2, missing: 1, sum: 115, avg: 57.5 });
  assert.deepEqual(all.summary.all, { days: 5, recorded: 4, missing: 1, sum: 190, avg: 47.5 });
  assert.equal(all.experiment.metric, DEF.metric);
  assert.equal(all.experiment.unit, DEF.unit);
  assert.equal(all.experiment.calc_rule, DEF.calc_rule);

  // 6일차는 없다
  assert.equal((await S.call('POST', '/api/experiment/days', { day_date: seoulToday(), value: 1 })).status, 409);
});

test('C26 반올림: 평균은 소수 첫째 자리까지 (둘째 자리에서 반올림)', async () => {
  const c = S.client();
  await c.signup('round_user');
  const e = (await c.call('PUT', '/api/experiment', DEF)).json.experiment;
  await insertDay(e.id, 1, seoulToday(-4), 10, DEF.plan_rule);
  await insertDay(e.id, 2, seoulToday(-3), 11, DEF.plan_rule);
  await c.call('POST', '/api/experiment/rule-change', { new_rule: '바꿈', reason: '시험' });
  await insertDay(e.id, 3, seoulToday(-2), 10, '바꿈');
  await insertDay(e.id, 4, seoulToday(-1), 10, '바꿈');
  await insertDay(e.id, 5, seoulToday(0), 11, '바꿈');
  const s = (await c.call('GET', '/api/experiment')).json.summary;
  assert.equal(s.after.avg, 10.3); // 31 ÷ 3 = 10.333…
  assert.equal(s.all.avg, 10.4); // 52 ÷ 5 = 10.4
  assert.equal(s.before.avg, 10.5); // 21 ÷ 2 = 10.5
  // 남의 5일 기록은 보이지 않는다
  const mine = (await S.call('GET', '/api/experiment')).json;
  assert.notEqual(mine.experiment.id, e.id);
  const dayId = (await c.call('GET', '/api/experiment')).json.days[4].id;
  assert.equal((await S.call('DELETE', `/api/experiment/days/${dayId}`)).status, 404);
});
