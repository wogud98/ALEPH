'use strict';
const fs = require('node:fs');
const path = require('node:path');
const svc = require('./service');
const { HttpError, idParam } = require('./validate');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

// 인라인 스크립트·외부 스크립트를 막아, 저장된 글자가 혹시 HTML로 들어가도 실행되지 않게 한 겹 더 막는다.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        reject(new HttpError(413, '요청이 너무 큽니다'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'JSON 형식이 아닙니다'));
      }
    });
    req.on('error', reject);
  });
}

// [method, pattern, handler(pool, params, query, body)]
const ROUTES = [
  ['GET', /^\/api\/meta$/, (p) => svc.meta(p)],
  ['GET', /^\/api\/plans$/, (p) => svc.listPlans(p)],
  ['POST', /^\/api\/plans$/, (p, m, q, b) => svc.createPlan(p, b), 201],
  ['GET', /^\/api\/plans\/(\d+)$/, (p, m) => svc.getPlan(p, idParam(m[1]))],
  ['PUT', /^\/api\/plans\/(\d+)$/, (p, m, q, b) => svc.updatePlan(p, idParam(m[1]), b)],
  ['GET', /^\/api\/plans\/(\d+)\/tasks$/, (p, m, q) => svc.listTasks(p, idParam(m[1]), q)],
  ['POST', /^\/api\/plans\/(\d+)\/tasks$/, (p, m, q, b) => svc.createTask(p, idParam(m[1]), b), 201],
  ['GET', /^\/api\/plans\/(\d+)\/review$/, (p, m, q) => svc.review(p, idParam(m[1]), q)],
  ['GET', /^\/api\/plans\/(\d+)\/review\/evidence$/, (p, m, q) => svc.evidence(p, idParam(m[1]), q)],
  ['GET', /^\/api\/plans\/(\d+)\/retros$/, (p, m) => svc.listRetros(p, idParam(m[1]))],
  ['POST', /^\/api\/plans\/(\d+)\/retros$/, (p, m, q, b) => svc.createRetro(p, idParam(m[1]), b), 201],
  ['PATCH', /^\/api\/tasks\/(\d+)$/, (p, m, q, b) => svc.updateTask(p, idParam(m[1]), b)],
  ['DELETE', /^\/api\/tasks\/(\d+)$/, (p, m) => svc.deleteTask(p, idParam(m[1]))],
  ['POST', /^\/api\/tasks\/(\d+)\/complete$/, (p, m, q, b) => svc.completeTask(p, idParam(m[1]), b)],
  ['POST', /^\/api\/tasks\/(\d+)\/reopen$/, (p, m) => svc.reopenTask(p, idParam(m[1]))],
  ['POST', /^\/api\/tasks\/(\d+)\/logs$/, (p, m, q, b) => svc.createLog(p, idParam(m[1]), b), 201],
  ['DELETE', /^\/api\/logs\/(\d+)$/, (p, m) => svc.deleteLog(p, idParam(m[1]))],
];

function createHandler(pool, { log = console } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/healthz') {
        await pool.query('select 1');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/api/export') {
        const data = await svc.exportAll(pool);
        const stamp = data.today_seoul;
        return send(res, 200, JSON.stringify(data, null, 2), {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="pds-export-${stamp}.json"`,
        });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        const buf = fs.readFileSync(path.join(PUBLIC_DIR, file));
        return send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      }
      if (pathname.startsWith('/api/')) {
        const allowed = [];
        for (const [method, re, fn, okStatus] of ROUTES) {
          const m = pathname.match(re);
          if (!m) continue;
          allowed.push(method);
          if (method !== req.method) continue;
          if (['POST', 'PUT', 'PATCH'].includes(method)) {
            const ct = req.headers['content-type'] || '';
            const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
            if (hasBody && !ct.startsWith('application/json')) throw new HttpError(415, 'Content-Type은 application/json이어야 합니다');
          }
          const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(req) : {};
          const query = Object.fromEntries(url.searchParams);
          const out = await fn(pool, m, query, body);
          return send(res, okStatus || 200, out);
        }
        if (allowed.length) throw new HttpError(405, '허용되지 않은 방법입니다');
      }
      throw new HttpError(404, '찾을 수 없습니다');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      // DB 오류 원문(접속 정보 포함 가능)은 응답에 싣지 않는다.
      log.error('[server]', req.method, pathname, err && err.code, err && err.message);
      return send(res, 500, { error: '서버에서 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  };
}

module.exports = { createHandler };
