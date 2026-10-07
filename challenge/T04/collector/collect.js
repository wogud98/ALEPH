'use strict';

// T04 live 수집기: GitHub Actions가 하루 두 번 실행함. 비밀키 없음.
// 성공 → data/raw/<기록일>.json(원자료 그대로), data/daily.json(일별 1행), data/status.json(fresh/none)
// 실패 → daily.json과 raw/는 건드리지 않고 status.json만 stale/<error_code>로 바꿈
// 모든 시도 → data/runs.jsonl에 한 줄 추가

const fs = require('fs');
const path = require('path');
const { SIGNAL, SourceError, classifyHttpStatus, normalize, upsertDaily } = require('./lib');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_TIMEOUT_MS = 10000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// 임시 파일에 쓴 뒤 rename → 중간에 죽어도 반쯤 쓰인 파일이 남지 않음
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

async function fetchSource(fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(SIGNAL.source_url, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new SourceError('timeout', `${timeoutMs}ms 안에 응답이 오지 않음`);
    }
    throw new SourceError('offline', `원천에 연결하지 못함: ${err && err.cause ? err.cause.code || err.cause.message : err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const retryAfter = response.headers && response.headers.get ? response.headers.get('retry-after') : null;
    throw new SourceError(classifyHttpStatus(response.status), `HTTP ${response.status}`, {
      httpStatus: response.status,
      retryAfterSeconds: retryAfter && !Number.isNaN(Number(retryAfter)) ? Number(retryAfter) : null
    });
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new SourceError('timeout', '본문을 받는 중 시간 초과');
    throw new SourceError('offline', `본문을 받는 중 연결 끊김: ${err.message}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SourceError('schema_error', '응답 본문이 JSON이 아님', { httpStatus: response.status });
  }
  return { text, json, httpStatus: response.status };
}

async function run(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => new Date());
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const files = {
    daily: path.join(dataDir, 'daily.json'),
    status: path.join(dataDir, 'status.json'),
    runs: path.join(dataDir, 'runs.jsonl'),
    rawDir: path.join(dataDir, 'raw')
  };

  const fetchedAt = now().toISOString();
  const previousStatus = readJson(files.status, null);
  let runLog;

  try {
    const { text, json, httpStatus } = await fetchSource(fetchImpl, timeoutMs);
    const reading = normalize(json, fetchedAt);

    const rows = readJson(files.daily, []);
    const { rows: nextRows, action, row } = upsertDaily(rows, reading);

    // 원자료는 받은 그대로(가공 없이) 기록일별로 보관 → 원자료·저장값·화면값 대조에 사용
    writeAtomic(path.join(files.rawDir, `${reading.record_date}.json`), text);
    writeAtomic(files.daily, JSON.stringify(nextRows, null, 2) + '\n');

    const status = {
      status: { freshness: 'fresh', error_code: 'none' },
      last_success_at: fetchedAt,
      last_success_record_id: row.record_id,
      last_run: { at: fetchedAt, outcome: 'success', error_code: 'none', http_status: httpStatus, retry_after_seconds: null, message: `일별 기록 ${action === 'insert' ? '추가' : '갱신'}` }
    };
    writeAtomic(files.status, JSON.stringify(status, null, 2) + '\n');

    runLog = { at: fetchedAt, outcome: 'success', action, record_date: reading.record_date, value: reading.normalized_value, source_time: reading.source_time, http_status: httpStatus };
    console.log(`[성공] ${reading.record_date} 1달러 = ${reading.normalized_value}원 (${action}), 출처 시각 ${reading.source_time}`);
  } catch (err) {
    const code = err instanceof SourceError ? err.code : 'schema_error';
    const status = {
      status: { freshness: 'stale', error_code: code },
      last_success_at: previousStatus ? previousStatus.last_success_at || null : null,
      last_success_record_id: previousStatus ? previousStatus.last_success_record_id || null : null,
      last_run: { at: fetchedAt, outcome: 'error', error_code: code, http_status: err.httpStatus ?? null, retry_after_seconds: err.retryAfterSeconds ?? null, message: err.message }
    };
    writeAtomic(files.status, JSON.stringify(status, null, 2) + '\n');
    runLog = { at: fetchedAt, outcome: 'error', error_code: code, http_status: err.httpStatus ?? null, message: err.message };
    console.error(`[실패] ${code}: ${err.message} (기존 일별 기록은 그대로 둠)`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(files.runs, JSON.stringify(runLog) + '\n');
  return runLog.outcome === 'success' ? 0 : 1;
}

if (require.main === module) {
  run().then((code) => {
    // 실패면 1로 끝내서 Actions 화면에 빨간 표시가 뜨게 함 (커밋 단계는 always()로 계속 실행됨)
    process.exitCode = code;
  });
}

module.exports = { run };
