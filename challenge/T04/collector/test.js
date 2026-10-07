'use strict';

// T04 자동 검증: GitHub Actions(t04-test.yml)가 push마다 실행함. 외부 네트워크를 쓰지 않음.
// 1) 공개 fixture 9종을 lib.replayFixture로 재생해 expected와 대조
// 2) collect.run에 가짜 fetch와 가짜 시계를 넣어 실제 수집기의 저장·실패 규칙을 확인

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Lib = require('./lib');
const { run } = require('./collect');

const REPLAY_DIR = path.join(__dirname, '..', 'replay');
let passed = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed += 1; console.log(`ok  ${name}`); });
}

function fixture(id) {
  const file = { 'T04-NORMAL-D1-A': 'normal-d1-a', 'T04-NORMAL-D1-B': 'normal-d1-b', 'T04-NORMAL-D2': 'normal-d2', 'T04-TIMEOUT': 'timeout', 'T04-AUTH-401': 'auth-401', 'T04-RATE-429': 'rate-429', 'T04-OFFLINE': 'offline', 'T04-SCHEMA-BREAK': 'schema-break', 'T04-RECOVER-D2': 'recover-d2' }[id];
  return JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'fixtures', `${file}.json`), 'utf8'));
}

function observed(state) {
  const latest = state.rows[state.rows.length - 1];
  const c = Lib.comparisonFor(state.rows, latest);
  return {
    freshness: state.status.status.freshness,
    error_code: state.status.status.error_code,
    row_count: state.rows.length,
    stored_value: latest.normalized_value,
    delta: c.state === 'comparable' ? c.magnitude : null
  };
}

function play(ids) {
  let state = Lib.resetReplayState();
  for (const id of ids) {
    const fx = fixture(id);
    state = Lib.replayFixture(state, fx);
    const { freshness, error_code, row_count, stored_value, delta } = fx.expected;
    assert.deepStrictEqual(observed(state), { freshness, error_code, row_count, stored_value, delta }, id);
    if (fx.expected.record_date) assert.strictEqual(state.rows[state.rows.length - 1].record_date, fx.expected.record_date, id);
  }
  return state;
}

// ---- 가짜 원천 ----
function rawBody(krw, unix) {
  return JSON.stringify({ result: 'success', base_code: 'USD', time_last_update_unix: unix, time_last_update_utc: new Date(unix * 1000).toUTCString(), rates: { USD: 1, KRW: krw } });
}
function okFetch(body) {
  return async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
}
function httpFetch(status, headers = {}) {
  return async () => ({ ok: false, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => '{}' });
}
const offlineFetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
const hangFetch = (_url, opts) => new Promise((_, reject) => {
  opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
});
const clock = (iso) => () => new Date(iso);
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

(async () => {
  await check('fixture 9종 SHA-256이 공개 asset-manifest와 일치', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPLAY_DIR, 'asset-manifest.json'), 'utf8'));
    const entries = manifest.files.filter((f) => f.path.startsWith('fixtures/'));
    assert.strictEqual(entries.length, 9);
    for (const f of entries) {
      const hex = crypto.createHash('sha256').update(fs.readFileSync(path.join(REPLAY_DIR, f.path))).digest('hex');
      assert.strictEqual(hex, f.sha256, f.path);
    }
  });

  await check('정상: D1-A → D1-B → D1-B(재실행) → D2, 같은 날 1행·다음 날 새 행·변화 15', () => {
    const s = play(['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B']);
    const again = Lib.replayFixture(s, fixture('T04-NORMAL-D1-B'));
    assert.strictEqual(again.rows.length, 1);
    assert.strictEqual(again.rows[0].record_id, s.rows[0].record_id);
    const d2 = Lib.replayFixture(again, fixture('T04-NORMAL-D2'));
    assert.deepStrictEqual(observed(d2), { freshness: 'fresh', error_code: 'none', row_count: 2, stored_value: 120, delta: 15 });
  });

  for (const id of ['T04-TIMEOUT', 'T04-AUTH-401', 'T04-RATE-429', 'T04-OFFLINE', 'T04-SCHEMA-BREAK']) {
    await check(`실패 ${id}: 마지막 정상값 105 보존·stale, 다시 시도(RECOVER-D2)로 fresh/none·행 1건 추가`, () => {
      const s = play(['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', id]);
      const recovered = Lib.replayFixture(s, fixture('T04-RECOVER-D2'));
      assert.deepStrictEqual(observed(recovered), { freshness: 'fresh', error_code: 'none', row_count: 2, stored_value: 120, delta: 15 });
      assert.strictEqual(recovered.rows.filter((r) => r.record_date === '2026-08-25').length, 1);
    });
  }

  await check('rate_limit은 Retry-After 60초를 남김', () => {
    const s = play(['T04-NORMAL-D1-A', 'T04-NORMAL-D1-B', 'T04-RATE-429']);
    assert.strictEqual(s.status.last_run.retry_after_seconds, 60);
  });

  // ---- 실제 수집기(collect.js) ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't04-'));
  const day1 = 1791331352; // 임의의 합성 unix 시각
  await check('수집기: 같은 KST 날짜 두 번 성공 → 1행 갱신, record_id·first_fetched_at 유지', async () => {
    assert.strictEqual(await run({ dataDir: dir, fetchImpl: okFetch(rawBody(1000, day1)), now: clock('2026-01-01T01:00:00Z') }), 0);
    assert.strictEqual(await run({ dataDir: dir, fetchImpl: okFetch(rawBody(1001, day1)), now: clock('2026-01-01T13:00:00Z') }), 0);
    const rows = readJson(dir, 'daily.json');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].record_date, '2026-01-01');
    assert.strictEqual(rows[0].normalized_value, 1001);
    assert.strictEqual(rows[0].first_fetched_at, '2026-01-01T01:00:00.000Z');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'raw', '2026-01-01.json'), 'utf8')).rates.KRW, 1001);
  });

  await check('수집기: UTC 15:00 = 다음 KST 날짜 → 새 행', async () => {
    await run({ dataDir: dir, fetchImpl: okFetch(rawBody(1010, day1 + 86400)), now: clock('2026-01-01T15:00:00Z') });
    const rows = readJson(dir, 'daily.json');
    assert.deepStrictEqual(rows.map((r) => r.record_date), ['2026-01-01', '2026-01-02']);
  });

  const failures = [
    ['timeout', hangFetch, { timeoutMs: 50 }],
    ['auth', httpFetch(401)],
    ['auth', httpFetch(403)],
    ['rate_limit', httpFetch(429, { 'retry-after': '120' })],
    ['offline', offlineFetch],
    ['schema_error', okFetch('<html>not json</html>')],
    ['schema_error', okFetch(JSON.stringify({ result: 'success', base_code: 'USD', time_last_update_unix: day1, rates: { KRW: '1000' } }))]
  ];
  for (const [code, fetchImpl, extra] of failures) {
    await check(`수집기 실패 ${code}: daily.json·raw 그대로, status stale/${code}`, async () => {
      const before = fs.readFileSync(path.join(dir, 'daily.json'), 'utf8');
      const rawBefore = fs.readdirSync(path.join(dir, 'raw')).sort().join();
      assert.strictEqual(await run({ dataDir: dir, fetchImpl, now: clock('2026-01-02T03:00:00Z'), ...(extra || {}) }), 1);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'daily.json'), 'utf8'), before);
      assert.strictEqual(fs.readdirSync(path.join(dir, 'raw')).sort().join(), rawBefore);
      const st = readJson(dir, 'status.json');
      assert.deepStrictEqual(st.status, { freshness: 'stale', error_code: code });
      assert.strictEqual(st.last_success_at, '2026-01-01T15:00:00.000Z');
    });
  }

  await check('수집기: 실패 뒤 성공하면 fresh/none으로 복구', async () => {
    assert.strictEqual(await run({ dataDir: dir, fetchImpl: okFetch(rawBody(1020, day1 + 86400)), now: clock('2026-01-02T04:00:00Z') }), 0);
    assert.deepStrictEqual(readJson(dir, 'status.json').status, { freshness: 'fresh', error_code: 'none' });
    assert.strictEqual(readJson(dir, 'daily.json').length, 2);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed}개 검사 모두 통과`);
})().catch((err) => {
  console.error('\n실패:', err.message);
  process.exitCode = 1;
});
