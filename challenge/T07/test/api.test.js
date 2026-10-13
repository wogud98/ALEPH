'use strict';
// T06 통과 기준(T06-Cxx)별 검사를 로그인한 계정 하나로 다시 돈다. 실행: TEST_DATABASE_URL=... node --test test/
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { startTestServer, seoulToday, key } = require('./helpers');
const { createPool, SCHEMA } = require('../src/db');
const { createHandler } = require('../src/app');

let S;
before(async () => { S = await startTestServer(); });
after(async () => { await S.close(); });

const PLAN = {
  title: 'ALEPH T06 완주',
  start_date: '2026-10-12',
  end_date: '2026-10-18',
  priority: 1,
  success_criteria: '카드 1~5 통과 기준을 모두 충족하고 제출',
  estimated_minutes: 600,
};

async function newPlan(over = {}) {
  const r = await S.call('POST', '/api/plans', { ...PLAN, ...over });
  assert.equal(r.status, 201, r.text);
  return r.json;
}
async function newTask(planId, over = {}) {
  const r = await S.call('POST', `/api/plans/${planId}/tasks`, { title: '할 일', ...over });
  assert.equal(r.status, 201, r.text);
  return r.json;
}
async function newLog(taskId, over = {}) {
  const r = await S.call('POST', `/api/tasks/${taskId}/logs`, {
    idempotency_key: key(), started_at: '2026-10-12T09:00:00+09:00', ended_at: '2026-10-12T10:00:00+09:00', ...over,
  });
  assert.equal(r.status, 201, r.text);
  return r.json.log;
}
const review = async (planId, q = '') => (await S.call('GET', `/api/plans/${planId}/review${q}`)).json;

describe('카드 1 — 계획', () => {
  test('T06-C04~C07 기간·우선순위·성공 기준·예상 시간이 저장된다', async () => {
    const p = await newPlan();
    const got = (await S.call('GET', `/api/plans/${p.id}`)).json;
    assert.equal(got.start_date, '2026-10-12');
    assert.equal(got.end_date, '2026-10-18');
    assert.equal(got.priority, 1);
    assert.equal(got.success_criteria, PLAN.success_criteria);
    assert.equal(got.estimated_minutes, 600);
  });

  test('T06-C08 계획을 고쳐도 고치기 전 계획이 그대로 남는다', async () => {
    const p = await newPlan();
    const r = await S.call('PUT', `/api/plans/${p.id}`, { estimated_minutes: 720, end_date: '2026-10-19', change_reason: '카드 5가 더 큼' });
    assert.equal(r.status, 200, r.text);
    const got = r.json;
    assert.equal(got.id, p.id, '계획 ID는 그대로');
    assert.equal(got.current_revision, 2);
    assert.equal(got.estimated_minutes, 720);
    const [v1, v2] = got.revisions;
    assert.equal(v1.revision_no, 1);
    assert.equal(v1.estimated_minutes, 600, '처음 계획 값이 남아 있다');
    assert.equal(v1.end_date, '2026-10-18');
    assert.equal(v2.estimated_minutes, 720);
    assert.equal(v2.change_reason, '카드 5가 더 큼');
    // DB 차원에서도 지난 판은 고칠 수 없다
    await assert.rejects(S.pool.query('update plan_revisions set estimated_minutes = 1 where id = $1', [v1.id]));
    // 바뀐 것이 없으면 판을 늘리지 않는다
    assert.equal((await S.call('PUT', `/api/plans/${p.id}`, { estimated_minutes: 720 })).status, 400);
  });

  test('계획 입력 검증: 종료일이 시작일보다 앞서면 거절', async () => {
    const r = await S.call('POST', '/api/plans', { ...PLAN, start_date: '2026-10-18', end_date: '2026-10-12' });
    assert.equal(r.status, 400);
  });
});

describe('카드 2 — 할 일', () => {
  test('T06-C09, C14~C17 할 일을 만들고 마감일·우선순위·태그·예상 시간이 저장된다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id, { title: '스키마 설계', due_date: '2026-10-13', priority: 1, tags: 'T06, DB, DB', estimated_minutes: 90 });
    const list = (await S.call('GET', `/api/plans/${p.id}/tasks`)).json.tasks;
    const got = list.find((x) => x.id === t.id);
    assert.equal(got.title, '스키마 설계');
    assert.equal(got.due_date, '2026-10-13');
    assert.equal(got.priority, 1);
    assert.deepEqual(got.tags, ['T06', 'DB']);
    assert.equal(got.estimated_minutes, 90);
    assert.equal(got.status, 'todo');
  });

  test('T06-C10 할 일 내용을 고칠 수 있다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id, { title: '처음 이름' });
    const r = await S.call('PATCH', `/api/tasks/${t.id}`, { title: '고친 이름', description: '설명', tags: ['새태그'], due_date: null });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.title, '고친 이름');
    assert.equal(r.json.description, '설명');
    assert.deepEqual(r.json.tags, ['새태그']);
    assert.equal(r.json.due_date, null);
  });

  test('T06-C11, C12 완료로 바꾸고 다시 진행 중으로 되돌릴 수 있다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id);
    const c = await S.call('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: key() });
    assert.equal(c.json.task.status, 'done');
    assert.ok(c.json.task.completed_at);
    const o = await S.call('POST', `/api/tasks/${t.id}/reopen`);
    assert.equal(o.json.task.status, 'todo');
    assert.equal(o.json.task.completed_at, null);
    // 다시 완료하면 새 완료 기록 1건 (지난 기록은 되돌린 표시로 남는다)
    await S.call('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: key() });
    const rows = (await S.pool.query('select * from task_completions where task_id = $1 order by id', [t.id])).rows;
    assert.equal(rows.length, 2);
    assert.ok(rows[0].undone_at);
    assert.equal(rows[1].undone_at, null);
  });

  test('T06-C13 할 일을 지울 수 있다 (목록과 집계에서 빠진다)', async () => {
    const p = await newPlan();
    const t = await newTask(p.id);
    await newTask(p.id);
    assert.equal((await review(p.id)).planned, 2);
    const d = await S.call('DELETE', `/api/tasks/${t.id}`);
    assert.equal(d.status, 200);
    const list = (await S.call('GET', `/api/plans/${p.id}/tasks`)).json.tasks;
    assert.ok(!list.some((x) => x.id === t.id));
    assert.equal((await review(p.id)).planned, 1);
    assert.equal((await S.call('PATCH', `/api/tasks/${t.id}`, { title: 'x' })).status, 404);
  });

  test('T06-C18 할 일을 검색할 수 있다 (이름·설명·태그, % 같은 글자도 글자 그대로)', async () => {
    const p = await newPlan();
    const a = await newTask(p.id, { title: '서버 API 만들기' });
    const b = await newTask(p.id, { title: '화면', description: '집계 숫자 누르기' });
    const c = await newTask(p.id, { title: '배포', tags: ['render'] });
    const d = await newTask(p.id, { title: '진행률 100%' });
    const q = async (s) => (await S.call('GET', `/api/plans/${p.id}/tasks?q=${encodeURIComponent(s)}`)).json.tasks.map((x) => x.id);
    assert.deepEqual(await q('서버'), [a.id]);
    assert.deepEqual(await q('집계'), [b.id]);
    assert.deepEqual(await q('RENDER'), [c.id]);
    assert.deepEqual(await q('%'), [d.id]);
  });

  test('T06-C19 상태·우선순위·태그·지연·막힘으로 걸러 볼 수 있다', async () => {
    const p = await newPlan();
    const a = await newTask(p.id, { priority: 1, tags: ['x'], due_date: seoulToday(-2) });
    const b = await newTask(p.id, { priority: 3, tags: ['y'] });
    await S.call('POST', `/api/tasks/${b.id}/complete`, { idempotency_key: key() });
    await newLog(b.id, { blocked_reason: '권한 문제' });
    const f = async (qs) => (await S.call('GET', `/api/plans/${p.id}/tasks?${qs}`)).json.tasks.map((x) => x.id);
    assert.deepEqual(await f('status=done'), [b.id]);
    assert.deepEqual(await f('status=todo'), [a.id]);
    assert.deepEqual(await f('status=overdue'), [a.id]);
    assert.deepEqual(await f('status=blocked'), [b.id]);
    assert.deepEqual(await f('priority=1'), [a.id]);
    assert.deepEqual(await f('tag=y'), [b.id]);
    assert.equal((await S.call('GET', `/api/plans/${p.id}/tasks?status=zzz`)).status, 400);
  });

  test('T06-C20 밝혀 둔 기준대로 정렬되고, 같은 값이면 ID로 순서가 고정된다', async () => {
    const p = await newPlan();
    const t1 = await newTask(p.id, { title: 'A', due_date: '2026-10-15', priority: 2, estimated_minutes: 30 });
    const t2 = await newTask(p.id, { title: 'B', due_date: '2026-10-13', priority: 3, estimated_minutes: 60 });
    const t3 = await newTask(p.id, { title: 'C', due_date: '2026-10-13', priority: 1, estimated_minutes: 60 });
    const t4 = await newTask(p.id, { title: 'D', priority: 1, estimated_minutes: 10 });
    const t5 = await newTask(p.id, { title: 'E', due_date: '2026-10-13', priority: 1, estimated_minutes: 60 });
    const ids = async (sort) => {
      const r = (await S.call('GET', `/api/plans/${p.id}/tasks?sort=${sort}`)).json;
      assert.ok(r.sort_label.length > 10, '정렬 기준 설명이 함께 온다');
      assert.equal(r.filtered_on, 'server');
      return r.tasks.map((x) => x.id);
    };
    assert.deepEqual(await ids('due'), [t3.id, t5.id, t2.id, t1.id, t4.id]);
    assert.deepEqual(await ids('priority'), [t3.id, t5.id, t4.id, t1.id, t2.id]);
    assert.deepEqual(await ids('estimate'), [t2.id, t3.id, t5.id, t1.id, t4.id]);
    assert.deepEqual(await ids('created'), [t5.id, t4.id, t3.id, t2.id, t1.id]);
    // 여러 번 불러도 같은 순서
    for (let i = 0; i < 5; i++) assert.deepEqual(await ids('due'), [t3.id, t5.id, t2.id, t1.id, t4.id]);
  });
});

describe('카드 3 — 실행 기록', () => {
  test('T06-C23~C26 시작·끝 시각, 실제 시간, 막혔던 이유가 저장된다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id, { estimated_minutes: 60 });
    const l = await newLog(t.id, {
      started_at: '2026-10-12T21:10:00+09:00', ended_at: '2026-10-12T23:00:00+09:00', actual_minutes: 95, blocked_reason: 'DB 접속 오류',
    });
    const got = (await S.call('GET', `/api/plans/${p.id}/tasks`)).json.tasks[0].logs[0];
    assert.equal(got.id, l.id);
    assert.equal(got.task_id, t.id);
    assert.equal(got.started_at, '2026-10-12T12:10:00.000Z');
    assert.equal(got.ended_at, '2026-10-12T14:00:00.000Z');
    assert.equal(got.actual_minutes, 95);
    assert.equal(got.blocked_reason, 'DB 접속 오류');
  });

  test('실제 시간을 비우면 끝-시작으로 계산하고, 시간대 없는 시각·거꾸로 된 시각은 거절한다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id);
    const l = await newLog(t.id, { started_at: '2026-10-12T09:00:00+09:00', ended_at: '2026-10-12T09:45:00+09:00' });
    assert.equal(l.actual_minutes, 45);
    const bad1 = await S.call('POST', `/api/tasks/${t.id}/logs`, { idempotency_key: key(), started_at: '2026-10-12T09:00', ended_at: '2026-10-12T10:00' });
    assert.equal(bad1.status, 400);
    const bad2 = await S.call('POST', `/api/tasks/${t.id}/logs`, { idempotency_key: key(), started_at: '2026-10-12T10:00+09:00', ended_at: '2026-10-12T09:00+09:00' });
    assert.equal(bad2.status, 400);
  });

  test('T06-C27 실행 기록을 저장해도 원래 계획 값은 덮어쓰이지 않는다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id, { estimated_minutes: 60, due_date: '2026-10-14' });
    const planBefore = (await S.call('GET', `/api/plans/${p.id}`)).json;
    const taskBefore = (await S.call('GET', `/api/plans/${p.id}/tasks`)).json.tasks[0];
    await newLog(t.id, { started_at: '2026-10-12T09:00:00+09:00', ended_at: '2026-10-12T12:00:00+09:00', actual_minutes: 180 });
    const planAfter = (await S.call('GET', `/api/plans/${p.id}`)).json;
    const taskAfter = (await S.call('GET', `/api/plans/${p.id}/tasks`)).json.tasks[0];
    assert.deepEqual(planAfter, planBefore);
    const { logs: _a, ...tb } = taskBefore;
    const { logs: _b, ...ta } = taskAfter;
    assert.deepEqual(ta, tb);
    assert.equal(taskAfter.estimated_minutes, 60);
  });

  test('T06-C21, C22 완료를 연달아 두 번 보내도 완료 기록 1건, 돌아보기 완료 수는 정확히 1 증가', async () => {
    const p = await newPlan();
    const t = await newTask(p.id);
    await newTask(p.id);
    const before = (await review(p.id)).done;
    const k = key();
    // 같은 키로 동시에 두 번
    const [r1, r2] = await Promise.all([
      S.call('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: k }),
      S.call('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: k }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual([r1.json.duplicate, r2.json.duplicate].sort(), [false, true]);
    // 버튼 잠금이 없다고 치고 다른 키로 또 보내도 늘지 않는다
    const r3 = await S.call('POST', `/api/tasks/${t.id}/complete`, { idempotency_key: key() });
    assert.equal(r3.json.duplicate, true);
    const rows = (await S.pool.query('select count(*)::int n from task_completions where task_id = $1', [t.id])).rows[0].n;
    assert.equal(rows, 1);
    assert.equal((await review(p.id)).done, before + 1);
  });

  test('T06-C21 DB 제약: 살아 있는 완료를 같은 할 일에 두 번 넣을 수 없다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id);
    await S.pool.query('insert into task_completions (task_id, idempotency_key) values ($1, $2)', [t.id, key()]);
    await assert.rejects(S.pool.query('insert into task_completions (task_id, idempotency_key) values ($1, $2)', [t.id, key()]), /task_completions_one_active/);
  });

  test('실행 기록도 같은 요청 키로 두 번 보내면 한 건만 남는다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id);
    const body = { idempotency_key: key(), started_at: '2026-10-12T09:00:00+09:00', ended_at: '2026-10-12T10:00:00+09:00' };
    await Promise.all([S.call('POST', `/api/tasks/${t.id}/logs`, body), S.call('POST', `/api/tasks/${t.id}/logs`, body)]);
    const n = (await S.pool.query('select count(*)::int n from work_logs where task_id = $1', [t.id])).rows[0].n;
    assert.equal(n, 1);
  });
});

describe('카드 4 — 돌아보기', () => {
  let p; let ids;
  before(async () => {
    p = await newPlan();
    const A = await newTask(p.id, { title: 'A 완료+예전 마감', due_date: seoulToday(-3), estimated_minutes: 60 });
    const B = await newTask(p.id, { title: 'B 지연', due_date: seoulToday(-1), estimated_minutes: 30 });
    const C = await newTask(p.id, { title: 'C 오늘 마감', due_date: seoulToday(0), estimated_minutes: 45 });
    const D = await newTask(p.id, { title: 'D 지울 것', due_date: seoulToday(-5), estimated_minutes: 999 });
    const E = await newTask(p.id, { title: 'E 마감 없음', estimated_minutes: 0 });
    await S.call('POST', `/api/tasks/${A.id}/complete`, { idempotency_key: key() });
    await newLog(A.id, { actual_minutes: 50 });
    await newLog(A.id, { actual_minutes: 20, started_at: '2026-10-12T11:00:00+09:00', ended_at: '2026-10-12T11:30:00+09:00' });
    await newLog(B.id, { actual_minutes: 40, blocked_reason: '요구사항 해석' });
    await newLog(B.id, { actual_minutes: 10, blocked_reason: '또 막힘' });
    await newLog(C.id, { actual_minutes: 15, blocked_reason: '   ' });
    await newLog(D.id, { actual_minutes: 60, blocked_reason: '지운 할 일의 막힘' });
    await S.call('DELETE', `/api/tasks/${D.id}`);
    ids = { A: A.id, B: B.id, C: C.id, D: D.id, E: E.id };
  });

  test('T06-C28 계획 수 = 지우지 않은 할 일 수', async () => {
    assert.equal((await review(p.id)).planned, 4);
  });
  test('T06-C29 완료 수 = 지금 완료 상태인 할 일 수', async () => {
    assert.equal((await review(p.id)).done, 1);
  });
  test('T06-C30 지연 수 = 미완료이면서 마감일이 서울 오늘보다 앞선 할 일 (완료한 할 일은 세지 않음)', async () => {
    assert.equal((await review(p.id)).delayed, 1); // B만. A는 완료, C는 오늘, D는 지움, E는 마감 없음
  });
  test('T06-C31 막힘 수 = 막힌 이유가 하나라도 적힌 할 일 수 (기록 수가 아니라 할 일 수)', async () => {
    assert.equal((await review(p.id)).blocked, 1); // B(2건이어도 1), C는 공백뿐, D는 지움
  });
  test('T06-C32 예상·실제·차이 (같은 분 단위), 아무것도 없으면 0', async () => {
    const r = await review(p.id);
    assert.equal(r.unit, 'minutes');
    assert.equal(r.estimated_minutes, 60 + 30 + 45 + 0);
    assert.equal(r.actual_minutes, 50 + 20 + 40 + 10 + 15);
    assert.equal(r.diff_minutes, r.actual_minutes - r.estimated_minutes);
    const empty = await newPlan();
    const z = await review(empty.id);
    assert.deepEqual([z.planned, z.done, z.delayed, z.blocked, z.estimated_minutes, z.actual_minutes, z.diff_minutes], [0, 0, 0, 0, 0, 0, 0]);
  });
  test('T06-C28~C32 숫자가 DB를 직접 센 값과 같다', async () => {
    const r = await review(p.id);
    const q = async (sql) => (await S.pool.query(sql, [p.id])).rows[0].n;
    assert.equal(r.planned, await q('select count(*)::int n from tasks where plan_id=$1 and deleted_at is null'));
    assert.equal(r.done, await q(`select count(*)::int n from tasks where plan_id=$1 and deleted_at is null and status='done'`));
    assert.equal(r.actual_minutes, await q('select coalesce(sum(w.actual_minutes),0)::int n from work_logs w join tasks t on t.id=w.task_id where t.plan_id=$1 and t.deleted_at is null'));
  });
  test('기간으로 거르면 마감일이 그 기간 안인 할 일만 센다', async () => {
    const r = await review(p.id, `?from=${seoulToday(-1)}&to=${seoulToday(0)}`);
    assert.equal(r.planned, 2); // B, C
    assert.equal(r.period.rule, '마감일이 이 기간 안에 있는 할 일');
  });
  test('T06-C83 집계 숫자마다 그 숫자가 나온 기록 목록을 받을 수 있다', async () => {
    const r = await review(p.id);
    const ev = async (m) => (await S.call('GET', `/api/plans/${p.id}/review/evidence?metric=${m}`)).json;
    for (const m of ['planned', 'done', 'delayed', 'blocked']) {
      const e = await ev(m);
      assert.equal(e.tasks.length, r[m], m);
      assert.equal(e.total, r[m], m);
    }
    assert.deepEqual((await ev('done')).tasks.map((t) => t.id), [ids.A]);
    assert.deepEqual((await ev('delayed')).tasks.map((t) => t.id), [ids.B]);
    const blocked = await ev('blocked');
    assert.deepEqual(blocked.tasks.map((t) => t.id), [ids.B]);
    assert.equal(blocked.logs.length, 2);
    const est = await ev('estimated');
    assert.equal(est.total, r.estimated_minutes);
    const act = await ev('actual');
    assert.equal(act.total, r.actual_minutes);
    assert.equal(act.logs.length, 5);
    assert.ok(act.logs.every((l) => l.task_id !== ids.D));
  });
  test('T06-C33 돌아보기의 고칠 점 한 건이 다음 계획으로 넘어간다', async () => {
    const r = await S.call('POST', `/api/plans/${p.id}/retros`, {
      went_well: '서버 집계', went_wrong: '화면 시간이 예상의 2배', improvement: '화면 작업은 예상 시간을 1.5배로 잡는다',
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.snapshot.planned, 4, '저장 시점 집계가 함께 남는다');
    const next = await S.call('POST', '/api/plans', { ...PLAN, title: '다음 계획', carried_from_retro_id: r.json.id });
    assert.equal(next.status, 201, next.text);
    assert.equal(next.json.carried_improvement, '화면 작업은 예상 시간을 1.5배로 잡는다');
    assert.equal(next.json.carried_from_retro_id, r.json.id);
    const list = (await S.call('GET', `/api/plans/${p.id}/retros`)).json;
    assert.equal(list[0].carried_to_plan_id, next.json.id);
    const again = await S.call('POST', '/api/plans', { ...PLAN, carried_from_retro_id: r.json.id });
    assert.equal(again.status, 409, '같은 고칠 점을 두 번 넘기지 않는다');
  });
});

describe('카드 5 — 저장·복원·내보내기·안전', () => {
  test('T06-C34 계획·할 일·실행 기록·돌아보기가 서버 DB 표에 저장된다', async () => {
    const p = await newPlan();
    const t = await newTask(p.id);
    await newLog(t.id);
    await S.call('POST', `/api/plans/${p.id}/retros`, { improvement: '한 줄' });
    for (const tbl of ['plans', 'plan_revisions', 'tasks', 'work_logs', 'retrospectives']) {
      const n = (await S.pool.query(`select count(*)::int n from ${tbl}`)).rows[0].n;
      assert.ok(n > 0, tbl);
    }
  });

  test('T06-C35 새 연결(새로고침)로 다시 읽어도 ID·날짜·값·단위가 같다', async () => {
    const p = await newPlan({ estimated_minutes: 123 });
    const t = await newTask(p.id, { due_date: '2026-10-31', estimated_minutes: 77, tags: ['한글', 'x'] });
    await newLog(t.id, { started_at: '2026-10-12T23:30:00+09:00', ended_at: '2026-10-13T00:15:00+09:00', blocked_reason: '자정 넘김' });
    const snap = async () => ({
      plan: (await S.call('GET', `/api/plans/${p.id}`)).json,
      tasks: (await S.call('GET', `/api/plans/${p.id}/tasks`)).json,
      review: await review(p.id),
    });
    const a = await snap();
    // 서버를 새로 띄우고 새 DB 연결로 다시 읽는다
    const pool2 = createPool(process.env.TEST_DATABASE_URL);
    const srv = http.createServer(createHandler(pool2));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${srv.address().port}`;
    const get = async (u) => (await fetch(base2 + u, { headers: { cookie: S.main.cookie } })).json();
    const b = { plan: await get(`/api/plans/${p.id}`), tasks: await get(`/api/plans/${p.id}/tasks`), review: await get(`/api/plans/${p.id}/review`) };
    await new Promise((r) => srv.close(r));
    await pool2.end();
    assert.deepEqual(b, a);
    const log = b.tasks.tasks[0].logs[0];
    assert.equal(b.tasks.tasks[0].due_date, '2026-10-31');
    assert.equal(log.started_at, '2026-10-12T14:30:00.000Z');
    assert.equal(log.actual_minutes, 45);
    assert.equal(b.review.unit, 'minutes');
  });

  test('T06-C36 내 자료 전체를 파일 하나로 내보낼 수 있다', async () => {
    const r = await S.call('GET', '/api/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="pds-export-tester-\d{4}-\d{2}-\d{2}\.json"/);
    const data = JSON.parse(r.text);
    for (const k of ['plans', 'plan_revisions', 'tasks', 'task_completions', 'work_logs', 'retrospectives', 'reviews']) {
      assert.ok(Array.isArray(data[k]), k);
    }
    const dbPlans = (await S.pool.query('select count(*)::int n from plans')).rows[0].n;
    assert.equal(data.plans.length, dbPlans);
    assert.equal(data.schema, 'contracts/pds-schema-v3.json');
    assert.ok(!r.text.includes('idempotency_key'), '내부 요청 키는 내보내지 않는다');
  });

  test('T06-C82 → T07: 공개 안내 문장은 없어지고, 로그인한 화면에 "나만 보입니다" 안내가 있다', async () => {
    const r = await S.call('GET', '/app');
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('지금은 로그인이 없어'));
    assert.ok(r.text.includes('로그인한 나만 볼 수 있습니다'));
  });

  test('T06-C57 스크립트 모양 글자는 글자 그대로 저장·응답되고, 화면은 textContent만 쓰며 CSP로 인라인 스크립트를 막는다', async () => {
    const p = await newPlan();
    const evil = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const t = await newTask(p.id, { title: evil, description: evil, tags: ['<b>t</b>'] });
    await newLog(t.id, { blocked_reason: evil, note: evil });
    const got = (await S.call('GET', `/api/plans/${p.id}/tasks`)).json.tasks[0];
    assert.equal(got.title, evil);
    assert.equal(got.logs[0].blocked_reason, evil);
    const page = await S.call('GET', '/app');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  test('T06-C58 DB 오류가 나도 응답에 접속 정보가 실리지 않는다', async () => {
    const secret = 'NotARealPassword-zz9';
    const pool = createPool(`postgres://pds_user:${secret}@127.0.0.1:1/nope`);
    const srv = http.createServer(createHandler(pool, { log: { error() {} } }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    for (const u of ['/healthz', '/api/plans', '/api/export', '/app']) {
      // 세션 쿠키 모양의 값을 보내 서버가 DB에서 세션을 찾게 만든다 (DB가 없으니 500이 나야 한다)
      const res = await fetch(base + u, { headers: { cookie: `pds_sid=${'A'.repeat(43)}` }, redirect: 'manual' });
      const text = await res.text();
      assert.equal(res.status, 500);
      assert.ok(!text.includes(secret) && !text.includes('pds_user') && !text.includes('postgres://'), u);
    }
    await new Promise((r) => srv.close(r));
    await pool.end();
  });

  test('계약 파일 contracts/pds-schema-v3.json이 실제 DB 표·칼럼과 일치한다', async () => {
    const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'pds-schema-v3.json'), 'utf8'));
    const { rows } = await S.pool.query(
      `select table_name, column_name from information_schema.columns where table_schema = '${SCHEMA}' order by table_name, ordinal_position`,
    );
    const actual = {};
    for (const r of rows) (actual[r.table_name] ||= []).push(r.column_name);
    const expected = Object.fromEntries(Object.entries(contract.tables).map(([t, def]) => [t, Object.keys(def.columns)]));
    assert.deepEqual(actual, expected);
  });
});
