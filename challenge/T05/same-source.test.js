'use strict';

// T05 고정 검사 10개. 작업 시작 전에 고정했으며 삭제·완화·기대값 변경 금지.
// 실행: node challenge/T05/same-source.test.js  (저장소 루트에서, Node 18 이상, 외부 네트워크 없음)
// 대상: challenge/T04/collector/collect.js 의 run() — 가짜 원천과 가짜 시계로 실제 저장 결과를 관찰함
// 버그: 원천이 아직 전날 값을 주는데(원천 갱신 시각이 같음) 수집 시각의 KST 날짜로 새 행이 생김

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const collect = require('../T04/collector/collect');

// 수집기의 콘솔 출력을 감춰 검사 결과만 보이게 함
async function run(opts) {
  const { log, error } = console;
  console.log = console.error = () => {};
  try { return await collect.run(opts); } finally { console.log = log; console.error = error; }
}

const SRC_A = 1767225600; // 2026-01-01T00:00:00Z, 원천 갱신 시각(가상)
const SKIP_MESSAGE = '같은 원천 시각이라 새 기록을 만들지 않음';

function body(krw, unix) {
  return JSON.stringify({ result: 'success', base_code: 'USD', time_last_update_unix: unix, time_last_update_utc: new Date(unix * 1000).toUTCString(), rates: { USD: 1, KRW: krw } });
}
function source(krw, unix) {
  return async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body(krw, unix) });
}
const at = (iso) => () => new Date(iso);
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 't05-')); }
function read(dir, f) { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
function lastRun(dir) { const lines = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n'); return JSON.parse(lines[lines.length - 1]); }

// 1일차 10:00 KST 정상 수집 → 다음 날 04:18 KST(cron 지연)에 같은 원천 시각의 값을 다시 받음
async function delayedRerun() {
  const dir = tmp();
  assert.strictEqual(await run({ dataDir: dir, fetchImpl: source(1300, SRC_A), now: at('2026-01-01T01:00:00Z') }), 0);
  const before = fs.readFileSync(path.join(dir, 'daily.json'), 'utf8');
  const code = await run({ dataDir: dir, fetchImpl: source(1300, SRC_A), now: at('2026-01-01T19:18:00Z') });
  return { dir, before, code };
}

const tests = [
  ['S01 다음 KST 날짜인데 원천 시각이 같으면 새 행을 만들지 않음(1행 유지, 종료 코드 0)', async () => {
    const { dir, code } = await delayedRerun();
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(read(dir, 'daily.json').map((r) => r.record_date), ['2026-01-01']);
  }],
  ['S02 건너뛴 실행은 daily.json 내용을 한 글자도 바꾸지 않음', async () => {
    const { dir, before } = await delayedRerun();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'daily.json'), 'utf8'), before);
  }],
  ['S03 건너뛴 실행은 새 날짜의 raw 파일을 만들지 않음', async () => {
    const { dir } = await delayedRerun();
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'raw')).sort(), ['2026-01-01.json']);
  }],
  ['S04 runs.jsonl 마지막 줄: outcome success, action skip_same_source, source_time 기록', async () => {
    const { dir } = await delayedRerun();
    const r = lastRun(dir);
    assert.strictEqual(r.outcome, 'success');
    assert.strictEqual(r.action, 'skip_same_source');
    assert.strictEqual(r.source_time, '2026-01-01T00:00:00.000Z');
  }],
  ['S05 status.json: fresh/none, 마지막 성공 기록은 1일차 그대로, 안내 문구', async () => {
    const { dir } = await delayedRerun();
    const st = read(dir, 'status.json');
    assert.deepStrictEqual(st.status, { freshness: 'fresh', error_code: 'none' });
    assert.strictEqual(st.last_success_record_id, 'usd-krw-2026-01-01');
    assert.strictEqual(st.last_run.outcome, 'success');
    assert.strictEqual(st.last_run.message, SKIP_MESSAGE);
  }],
  ['S06 다음 날 원천 시각이 바뀌면 새 행 추가(정상 동작 유지)', async () => {
    const dir = tmp();
    await run({ dataDir: dir, fetchImpl: source(1300, SRC_A), now: at('2026-01-01T01:00:00Z') });
    assert.strictEqual(await run({ dataDir: dir, fetchImpl: source(1310, SRC_A + 86400), now: at('2026-01-02T01:00:00Z') }), 0);
    const rows = read(dir, 'daily.json');
    assert.deepStrictEqual(rows.map((r) => [r.record_date, r.normalized_value]), [['2026-01-01', 1300], ['2026-01-02', 1310]]);
    assert.strictEqual(lastRun(dir).action, 'insert');
  }],
  ['S07 같은 KST 날짜의 재수집은 원천 시각이 같아도 그 행을 갱신(기존 동작 유지)', async () => {
    const dir = tmp();
    await run({ dataDir: dir, fetchImpl: source(1300, SRC_A), now: at('2026-01-01T01:00:00Z') });
    await run({ dataDir: dir, fetchImpl: source(1300, SRC_A), now: at('2026-01-01T13:00:00Z') });
    const rows = read(dir, 'daily.json');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].last_fetched_at, '2026-01-01T13:00:00.000Z');
    assert.strictEqual(lastRun(dir).action, 'update');
  }],
  ['S08 건너뛴 뒤 같은 날 원천이 갱신되면 그 날 행을 추가', async () => {
    const { dir } = await delayedRerun();
    await run({ dataDir: dir, fetchImpl: source(1320, SRC_A + 86400), now: at('2026-01-02T01:00:00Z') });
    const rows = read(dir, 'daily.json');
    assert.deepStrictEqual(rows.map((r) => [r.record_date, r.normalized_value]), [['2026-01-01', 1300], ['2026-01-02', 1320]]);
  }],
  ['S09 경계: 원천 시각이 1초만 달라도 새 행 추가', async () => {
    const dir = tmp();
    await run({ dataDir: dir, fetchImpl: source(1300, SRC_A), now: at('2026-01-01T01:00:00Z') });
    await run({ dataDir: dir, fetchImpl: source(1300, SRC_A + 1), now: at('2026-01-01T19:18:00Z') });
    assert.deepStrictEqual(read(dir, 'daily.json').map((r) => r.record_date), ['2026-01-01', '2026-01-02']);
  }],
  ['S10 기존 T04 검사(challenge/T04/collector/test.js)가 계속 모두 통과', () => {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'T04', 'collector', 'test.js')], { stdio: 'pipe' });
  }]
];

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed += 1; console.log(`ok    ${name}`); }
    catch (err) { console.log(`FAIL  ${name}\n      ${String(err.message).split('\n')[0]}`); }
  }
  console.log(`\n${passed}/${tests.length} 통과`);
  process.exitCode = passed === tests.length ? 0 : 1;
})();
