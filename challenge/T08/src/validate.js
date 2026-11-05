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

function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(404, '찾을 수 없습니다');
  return n;
}

module.exports = { HttpError, bad, text, idParam };
