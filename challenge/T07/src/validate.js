'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);

function text(body, key, { label, required = false, max = 2000, def } = {}) {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw bad(`${label}을(를) 입력하세요`);
    return def;
  }
  if (typeof v !== 'string') throw bad(`${label}은(는) 글자여야 합니다`);
  const s = v.trim();
  if (required && !s) throw bad(`${label}을(를) 입력하세요`);
  if (s.length > max) throw bad(`${label}은(는) ${max}자 이하로 적어 주세요`);
  return s;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function date(body, key, { label, required = false } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label}을(를) 입력하세요`);
    return v === undefined ? undefined : null;
  }
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw bad(`${label}은(는) YYYY-MM-DD 형식이어야 합니다`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${label}이(가) 올바른 날짜가 아닙니다`);
  return v;
}

// 시각은 시간대가 붙은 ISO 8601만 받는다 (예: 2026-10-12T09:00:00+09:00). 시간대 없는 값은 거절해 서버 시간대에 따라 달라지지 않게 한다.
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
function timestamp(body, key, { label, required = false } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label}을(를) 입력하세요`);
    return null;
  }
  if (typeof v !== 'string' || !TS_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw bad(`${label}은(는) 시간대가 붙은 시각이어야 합니다 (예: 2026-10-12T09:00+09:00)`);
  }
  return new Date(v);
}

function int(body, key, { label, required = false, min = 0, max = 100000, def } = {}) {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label}을(를) 입력하세요`);
    return def;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label}은(는) ${min}~${max} 사이 정수여야 합니다`);
  return n;
}

function priority(body, key, opts = {}) {
  return int(body, key, { label: '우선순위', min: 1, max: 3, ...opts });
}

function tags(body, key) {
  const v = body[key];
  if (v === undefined) return undefined;
  let list = v;
  if (typeof v === 'string') list = v.split(',');
  if (!Array.isArray(list)) throw bad('태그는 쉼표로 나눈 글자여야 합니다');
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw bad('태그는 글자여야 합니다');
    const t = raw.trim().replace(/^#/, '');
    if (!t) continue;
    if (t.length > 30) throw bad('태그는 하나에 30자 이하로 적어 주세요');
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > 10) throw bad('태그는 10개까지 넣을 수 있습니다');
  return out;
}

function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, '찾을 수 없습니다');
  return n;
}

function idemKey(body) {
  const v = body.idempotency_key;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(v)) {
    throw bad('요청 키(idempotency_key)가 필요합니다');
  }
  return v;
}

module.exports = { HttpError, bad, text, date, timestamp, int, priority, tags, idParam, idemKey };
