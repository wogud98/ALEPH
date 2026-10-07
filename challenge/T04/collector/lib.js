// T04 공통 로직: live 수집기(collect.js, Node)와 공개 화면의 합성 재생(index.html, 브라우저)이 같은 함수를 씀.
// 이 파일은 네트워크·파일 I/O를 하지 않음. Node에서는 require, 브라우저에서는 window.T04Lib로 불러옴.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.T04Lib = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const SIGNAL = Object.freeze({
  signal_id: 'usd-krw',
  unit: 'KRW/USD',
  source_name: 'ExchangeRate-API (Open Access)',
  source_url: 'https://open.er-api.com/v6/latest/USD',
  record_timezone: 'Asia/Seoul'
});

const NORMALIZED_KEYS = Object.freeze([
  'signal_id',
  'normalized_value',
  'unit',
  'source_name',
  'source_url',
  'source_time',
  'fetched_at',
  'record_timezone',
  'record_date'
]);

const ERROR_CODES = Object.freeze(['timeout', 'auth', 'rate_limit', 'offline', 'schema_error']);

class SourceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.httpStatus = extra.httpStatus ?? null;
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
  }
}

// fetched_at(UTC ISO)을 Asia/Seoul 기준 날짜(YYYY-MM-DD)로 바꿈. 일별 키는 반드시 여기서만 만듦.
function kstDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) throw new TypeError('유효한 ISO 시각이 아님: ' + isoString);
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

// HTTP 상태 → error_code. 공개 참조 adapter(adapter-reset.example.js)와 같은 규칙:
// 401/403 → auth, 429 → rate_limit, 그 밖의 비정상 상태 → schema_error
function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  return 'schema_error';
}

// ExchangeRate-API 원 응답(JSON) → normalized-reading.schema.json 형식
function normalize(raw, fetchedAtIso) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SourceError('schema_error', '응답이 JSON 객체가 아님');
  }
  if (raw.result !== 'success') {
    throw new SourceError('schema_error', `result가 success가 아님: ${raw.result} (${raw['error-type'] || '사유 없음'})`);
  }
  if (raw.base_code !== 'USD') {
    throw new SourceError('schema_error', `base_code가 USD가 아님: ${raw.base_code}`);
  }
  const value = raw.rates && raw.rates.KRW;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SourceError('schema_error', `rates.KRW가 양의 숫자가 아님: ${JSON.stringify(value)}`);
  }

  // 출처 시각 = 원천이 값을 갱신한 시각. unix 초 필드를 우선 쓰고, 없으면 UTC 문자열을 파싱함.
  let sourceTime = null;
  if (typeof raw.time_last_update_unix === 'number') {
    sourceTime = new Date(raw.time_last_update_unix * 1000);
  } else if (typeof raw.time_last_update_utc === 'string') {
    sourceTime = new Date(raw.time_last_update_utc);
  }
  if (!sourceTime || Number.isNaN(sourceTime.getTime())) {
    throw new SourceError('schema_error', '원천 갱신 시각(time_last_update_*)을 읽을 수 없음');
  }

  const reading = {
    signal_id: SIGNAL.signal_id,
    normalized_value: value,
    unit: SIGNAL.unit,
    source_name: SIGNAL.source_name,
    source_url: SIGNAL.source_url,
    source_time: sourceTime.toISOString(),
    fetched_at: fetchedAtIso,
    record_timezone: SIGNAL.record_timezone,
    record_date: kstDate(fetchedAtIso)
  };
  validateNormalizedReading(reading);
  return reading;
}

// 공개 참조 adapter(adapter-reset.example.js)의 검사와 같은 규칙
function validateNormalizedReading(reading) {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) {
    throw new TypeError('정규화 값이 객체가 아님');
  }
  const keys = Object.keys(reading).sort();
  const expected = [...NORMALIZED_KEYS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    throw new TypeError('정규화 키가 스키마와 다름');
  }
  if (typeof reading.signal_id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(reading.signal_id) || reading.signal_id.length > 100) {
    throw new TypeError('signal_id 형식 오류');
  }
  if (typeof reading.normalized_value !== 'number' || !Number.isFinite(reading.normalized_value)) {
    throw new TypeError('normalized_value는 유한한 숫자여야 함');
  }
  for (const field of ['unit', 'source_name']) {
    if (typeof reading[field] !== 'string' || reading[field].trim() === '') {
      throw new TypeError(`${field}는 비어 있지 않은 문자열이어야 함`);
    }
  }
  if (typeof reading.source_url !== 'string' || !/^https:\/\/[^\s]+$/.test(reading.source_url)) {
    throw new TypeError('source_url은 HTTPS여야 함');
  }
  if (reading.source_time !== null && (typeof reading.source_time !== 'string' || Number.isNaN(new Date(reading.source_time).getTime()))) {
    throw new TypeError('source_time은 유효한 시각이거나 null이어야 함');
  }
  if (typeof reading.fetched_at !== 'string' || Number.isNaN(new Date(reading.fetched_at).getTime())) {
    throw new TypeError('fetched_at은 유효한 시각이어야 함');
  }
  if (reading.record_timezone !== 'Asia/Seoul') throw new TypeError('record_timezone은 Asia/Seoul이어야 함');
  if (typeof reading.record_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reading.record_date) || reading.record_date !== kstDate(reading.fetched_at)) {
    throw new TypeError('record_date는 fetched_at의 Asia/Seoul 날짜여야 함');
  }
  return true;
}

function recordIdFor(reading) {
  return `${reading.signal_id}-${reading.record_date}`;
}

// 같은 signal_id + record_date면 기존 행을 갱신, 아니면 새 행 추가. 입력 배열은 바꾸지 않음.
function upsertDaily(rows, reading) {
  validateNormalizedReading(reading);
  const next = rows.map((r) => ({ ...r }));
  const idx = next.findIndex((r) => r.signal_id === reading.signal_id && r.record_date === reading.record_date);
  const existing = idx >= 0 ? next[idx] : null;
  const row = {
    record_id: existing ? existing.record_id : recordIdFor(reading),
    signal_id: reading.signal_id,
    record_date: reading.record_date,
    normalized_value: reading.normalized_value,
    unit: reading.unit,
    first_fetched_at: existing ? existing.first_fetched_at : reading.fetched_at,
    last_fetched_at: reading.fetched_at,
    reading: { ...reading }
  };
  if (existing) next[idx] = row;
  else next.push(row);
  next.sort((a, b) => a.record_date.localeCompare(b.record_date));
  return { rows: next, action: existing ? 'update' : 'insert', row };
}

// 전날 대비: 현재 행과, 그보다 앞선 가장 최근 기록일 행의 저장값으로 다시 계산함.
function comparisonFor(rows, current) {
  const previous = rows
    .filter((r) => r.signal_id === current.signal_id && r.record_date < current.record_date)
    .sort((a, b) => b.record_date.localeCompare(a.record_date))[0];
  if (!previous) return { state: 'insufficient', direction: null, magnitude: null, unit: null, previous: null };
  if (previous.unit !== current.unit) {
    return { state: 'unit_mismatch', direction: null, magnitude: null, unit: null, previous };
  }
  const signed = current.normalized_value - previous.normalized_value;
  return {
    state: 'comparable',
    direction: signed > 0 ? 'increase' : signed < 0 ? 'decrease' : 'unchanged',
    magnitude: Math.abs(signed),
    unit: current.unit,
    previous
  };
}

// ---- 합성 재생 (공개 fixture 전용) ----
// 상태 모양은 live의 data/daily.json(rows)·data/status.json(status)과 같게 맞춰 화면이 같은 그리기 함수를 씀.
function resetReplayState() {
  return { rows: [], status: null };
}

// fixture 한 건을 재생해 새 상태를 돌려줌. 분류 규칙은 collect.js와 같음:
// timeout/offline 전송 → 해당 코드, 비정상 HTTP → classifyHttpStatus, 2xx인데 형식이 깨짐 → schema_error.
// 실패는 rows(마지막 정상값과 일별 기록)를 건드리지 않음.
function replayFixture(state, fixture) {
  const t = fixture.transport;
  const at = fixture.virtual_now;
  const retryHeader = t.headers && t.headers['retry-after'];
  const prev = state.status;

  const fail = (code, message) => ({
    rows: state.rows.map((r) => ({ ...r })),
    status: {
      status: { freshness: 'stale', error_code: code },
      last_success_at: prev ? prev.last_success_at || null : null,
      last_success_record_id: prev ? prev.last_success_record_id || null : null,
      last_run: {
        at, outcome: 'error', error_code: code, http_status: t.status ?? null,
        retry_after_seconds: retryHeader && !Number.isNaN(Number(retryHeader)) ? Number(retryHeader) : null,
        message, fixture_id: fixture.fixture_id
      }
    }
  });

  if (t.mode === 'timeout') return fail('timeout', `${t.deadline_ms}ms 안에 응답이 오지 않음`);
  if (t.mode === 'offline') return fail('offline', '원천에 연결하지 못함');
  if (!(t.status >= 200 && t.status < 300)) return fail(classifyHttpStatus(t.status), `HTTP ${t.status}`);

  let result;
  try {
    result = upsertDaily(state.rows, fixture.payload);
  } catch (err) {
    return fail('schema_error', err.message);
  }
  return {
    rows: result.rows,
    status: {
      status: { freshness: 'fresh', error_code: 'none' },
      last_success_at: at,
      last_success_record_id: result.row.record_id,
      last_run: {
        at, outcome: 'success', error_code: 'none', http_status: t.status, retry_after_seconds: null,
        message: `일별 기록 ${result.action === 'insert' ? '추가' : '갱신'}`, fixture_id: fixture.fixture_id
      }
    }
  };
}

return {
  SIGNAL,
  NORMALIZED_KEYS,
  ERROR_CODES,
  SourceError,
  kstDate,
  classifyHttpStatus,
  normalize,
  validateNormalizedReading,
  upsertDaily,
  comparisonFor,
  resetReplayState,
  replayFixture
};
});
