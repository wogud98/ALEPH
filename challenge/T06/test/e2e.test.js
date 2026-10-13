'use strict';
// 실제 브라우저(Chromium)로 화면을 눌러 보는 검사. playwright가 없으면 건너뛴다.
// 실행: TEST_DATABASE_URL=... node --test test/e2e.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startTestServer, seoulToday } = require('./helpers');

let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  chromium = null;
}

const NOTICE = '지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요';
const EVIL = '<script>alert("xss")</script><img src=x onerror=alert(1)>';

let S; let browser; let page; let planId; const dialogs = []; const consoleErrors = [];
before(async () => {
  if (!chromium) return;
  S = await startTestServer();
  const p = (await S.call('POST', '/api/plans', {
    title: 'E2E 계획', start_date: seoulToday(-3), end_date: seoulToday(3), priority: 1, success_criteria: '화면 검사', estimated_minutes: 300,
  })).json;
  planId = p.id;
  await S.call('POST', `/api/plans/${p.id}/tasks`, { title: '첫 할 일', due_date: seoulToday(-1), estimated_minutes: 60, tags: ['e2e'] });
  await S.call('POST', `/api/plans/${p.id}/tasks`, { title: EVIL, due_date: seoulToday(2), estimated_minutes: 30 });
  browser = await chromium.launch();
  page = await browser.newPage({ acceptDownloads: true });
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(S.base + '/');
  await page.waitForSelector('#task-list .task', { state: 'attached' });
});
after(async () => {
  if (browser) await browser.close();
  if (S) await S.close();
});

const opts = { skip: chromium ? false : 'playwright 없음' };
const tileNum = async (m) => Number(await page.locator(`.tile.t-${m} .tile-num`).textContent());
const go = async (view) => {
  await page.click(`a.step[data-view=${view}]`);
  await page.locator(`section.view[data-view=${view}]`).waitFor();
};
const expand = async (card) => {
  if (await card.locator('.task-body').isHidden()) await card.locator('.task-toggle').click();
};

test('T06-C82 첫 화면에 공개 안내가 보인다', opts, async () => {
  const text = await page.locator('#public-notice').innerText();
  assert.ok(text.replace(/\s+/g, ' ').includes(NOTICE));
  assert.ok(await page.locator('#public-notice').isVisible());
});

test('T06-C57 스크립트 모양 글자가 실행되지 않고 글자 그대로 보인다', opts, async () => {
  await go('do');
  const title = page.locator('.task h3', { hasText: '<script>' });
  assert.equal(await title.innerText(), EVIL);
  assert.equal(await page.locator('#task-list img').count(), 0, 'img 태그가 만들어지지 않는다');
  assert.equal(await page.locator('#task-list script').count(), 0);
  assert.equal(dialogs.length, 0, 'alert이 뜨지 않는다');
});

test('T06-C21, C22 완료 버튼을 연달아 두 번 눌러도 기록 1건, 완료 수 +1', opts, async () => {
  const before = await tileNum('done');
  await go('do');
  const card = page.locator('.task', { hasText: '첫 할 일' });
  await card.getByRole('button', { name: '완료', exact: true }).dblclick();
  await page.locator('.task.done', { hasText: '첫 할 일' }).waitFor();
  await page.waitForTimeout(300);
  const n = (await S.pool.query(`select count(*)::int n from task_completions c join tasks t on t.id = c.task_id where t.title = '첫 할 일'`)).rows[0].n;
  assert.equal(n, 1);
  assert.equal(await tileNum('done'), before + 1);
});

test('T06-C83 집계 숫자를 누르면 근거 기록으로 갈 수 있다', opts, async () => {
  await go('see');
  await page.locator('.tile.t-done').click();
  const ev = page.locator('#evidence');
  await ev.waitFor({ state: 'visible' });
  const link = ev.locator('a', { hasText: '첫 할 일' });
  assert.equal(await ev.locator('ol.ev-list > li').count(), await tileNum('done'));
  await link.click();
  const target = page.locator('.task.flash', { hasText: '첫 할 일' });
  await target.waitFor();
  assert.ok(await target.isVisible());
  assert.match(page.url(), /#task-\d+$/);
});

test('T06-C08 화면에서 계획을 고치면 수정 이력에 1판이 남는다', opts, async () => {
  await go('plan');
  await page.click('#edit-plan-btn');
  await page.fill('#plan-form [name=estimated_minutes]', '420');
  await page.fill('#plan-form [name=change_reason]', '할 일이 늘어남');
  await page.click('#plan-form [type=submit]');
  await page.locator('#history-table tbody tr').nth(1).waitFor();
  const rows = await page.locator('#history-table tbody tr').allInnerTexts();
  assert.equal(rows.length, 2);
  assert.match(rows[0], /1판 \(처음\)[\s\S]*300분/);
  assert.match(rows[1], /420분[\s\S]*할 일이 늘어남/);
});

test('계획 기간을 줄이면 기간 밖 할 일에 표시가 붙고, 할 일은 그대로 남는다', opts, async () => {
  const before = await page.locator('#task-list .task').count();
  await go('plan');
  await page.click('#edit-plan-btn');
  await page.fill('#plan-form [name=end_date]', seoulToday(1));
  await page.click('#plan-form [type=submit]');
  await page.locator('#history-table tbody tr').nth(2).waitFor();
  await go('do');
  const evil = page.locator('.task', { hasText: '<script>' });
  await evil.locator('.outside').waitFor();
  assert.equal(await page.locator('#task-list .task').count(), before, '할 일은 지워지지 않는다');
  assert.match(await page.locator('#task-count').textContent(), /계획 기간 밖 1개/);
  assert.equal(await page.locator('.task', { hasText: '첫 할 일' }).locator('.outside').count(), 0);
});

test('T06-C23~C27 화면에서 실행 기록을 남기면 할 일에 붙고 예상 값은 그대로다', opts, async () => {
  await go('do');
  const card = page.locator('.task', { hasText: '첫 할 일' });
  await expand(card);
  await card.locator('.log-add summary').click();
  const day = seoulToday(0);
  await card.locator('[name=started_at]').fill(`${day}T09:00`);
  await card.locator('[name=ended_at]').fill(`${day}T10:30`);
  await card.locator('[name=blocked_reason]').fill('테스트 데이터 준비');
  await card.getByRole('button', { name: '실행 기록 저장' }).click();
  await card.locator('.log', { hasText: '테스트 데이터 준비' }).waitFor();
  const log = (await S.pool.query(`select * from work_logs w join tasks t on t.id = w.task_id where t.title = '첫 할 일'`)).rows[0];
  assert.equal(log.actual_minutes, 90);
  assert.equal(new Date(log.started_at).toISOString(), new Date(`${day}T09:00:00+09:00`).toISOString());
  assert.equal(log.estimated_minutes, 60, '할 일의 예상 시간은 그대로');
  assert.equal(await tileNum('blocked'), 1);
  assert.equal(await tileNum('actual'), 90);
});

test('T06-C35 새로고침 뒤에도 같은 값이 보인다', opts, async () => {
  const snap = async () => ({
    tiles: await page.locator('#tiles').textContent(),
    tasks: await page.locator('#task-list').textContent(),
    plan: await page.locator('#plan-view').textContent(),
  });
  const a = await snap();
  await page.reload();
  await page.waitForSelector('#task-list .task', { state: 'attached' });
  await page.waitForSelector('#tiles .tile', { state: 'attached' });
  await page.waitForTimeout(300);
  const b = await snap();
  assert.deepEqual(b, a);
});

test('T06-C33 돌아보기의 고칠 점이 다음 계획으로 넘어간다', opts, async () => {
  await go('see');
  await page.click('#retro-open');
  await page.fill('#retro-form [name=improvement]', '테스트 준비 시간을 따로 잡는다');
  await page.click('#retro-form [type=submit]');
  const btn = page.getByRole('button', { name: '이 고칠 점으로 다음 계획 만들기' });
  await btn.click();
  await page.fill('#plan-form [name=title]', '다음 주 계획');
  await page.fill('#plan-form [name=estimated_minutes]', '300');
  await page.click('#plan-form [type=submit]');
  await page.locator('.plan-card .carry', { hasText: '테스트 준비 시간을 따로 잡는다' }).waitFor();
  const p = (await S.pool.query(`select * from plans where title = '다음 주 계획'`)).rows[0];
  assert.equal(p.carried_improvement, '테스트 준비 시간을 따로 잡는다');
  await page.selectOption('#plan-select', String(planId));
  await page.locator('#retro-list a', { hasText: `계획 #${p.id}` }).waitFor({ state: 'attached' });
});

test('T06-C36 내보내기 버튼으로 JSON 파일 하나를 받는다', opts, async () => {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-link')]);
  const file = await dl.path();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(dl.suggestedFilename(), /^pds-export-\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(data.plans.length >= 2 && data.tasks.length >= 2 && data.work_logs.length >= 1 && data.retrospectives.length >= 1);
});

test('콘솔 오류가 없다', opts, async () => {
  assert.deepEqual(consoleErrors, []);
});
