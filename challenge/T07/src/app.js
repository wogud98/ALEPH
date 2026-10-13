'use strict';
const fs = require('node:fs');
const path = require('node:path');
const svc = require('./service');
const auth = require('./auth');
const exp = require('./experiment');
const { importT06IfOwner, importStatus } = require('./import-t06');
const { HttpError, idParam } = require('./validate');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// 누구나 열 수 있는 파일 (로그인 화면과 화면 코드). 내 자료는 이 파일들에 들어 있지 않고 /api/* 로만 나간다.
const STATIC = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/signup': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

// 인라인 스크립트·외부 스크립트를 막아, 저장된 글자가 혹시 HTML로 들어가도 실행되지 않게 한 겹 더 막는다.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

function redirect(res, location) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

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

// 로그인한 사람만 부를 수 있는 API. [method, pattern, handler(pool, user, params, query, body), 성공 상태]
// 모든 handler는 세션에서 찾은 user.id만 주인으로 쓴다. 주소·헤더·본문에 다른 계정을 적어 보내도 쓰지 않는다.
const ROUTES = [
  ['GET', /^\/api\/meta$/, (p) => svc.meta(p)],
  ['GET', /^\/api\/plans$/, (p, u) => svc.listPlans(p, u.id)],
  ['POST', /^\/api\/plans$/, (p, u, m, q, b) => svc.createPlan(p, u.id, b), 201],
  ['GET', /^\/api\/plans\/(\d+)$/, (p, u, m) => svc.getPlan(p, u.id, idParam(m[1]))],
  ['PUT', /^\/api\/plans\/(\d+)$/, (p, u, m, q, b) => svc.updatePlan(p, u.id, idParam(m[1]), b)],
  ['GET', /^\/api\/plans\/(\d+)\/tasks$/, (p, u, m, q) => svc.listTasks(p, u.id, idParam(m[1]), q)],
  ['POST', /^\/api\/plans\/(\d+)\/tasks$/, (p, u, m, q, b) => svc.createTask(p, u.id, idParam(m[1]), b), 201],
  ['GET', /^\/api\/plans\/(\d+)\/review$/, (p, u, m, q) => svc.review(p, u.id, idParam(m[1]), q)],
  ['GET', /^\/api\/plans\/(\d+)\/review\/evidence$/, (p, u, m, q) => svc.evidence(p, u.id, idParam(m[1]), q)],
  ['GET', /^\/api\/plans\/(\d+)\/retros$/, (p, u, m) => svc.listRetros(p, u.id, idParam(m[1]))],
  ['POST', /^\/api\/plans\/(\d+)\/retros$/, (p, u, m, q, b) => svc.createRetro(p, u.id, idParam(m[1]), b), 201],
  ['PATCH', /^\/api\/tasks\/(\d+)$/, (p, u, m, q, b) => svc.updateTask(p, u.id, idParam(m[1]), b)],
  ['DELETE', /^\/api\/tasks\/(\d+)$/, (p, u, m) => svc.deleteTask(p, u.id, idParam(m[1]))],
  ['POST', /^\/api\/tasks\/(\d+)\/complete$/, (p, u, m, q, b) => svc.completeTask(p, u.id, idParam(m[1]), b)],
  ['POST', /^\/api\/tasks\/(\d+)\/reopen$/, (p, u, m) => svc.reopenTask(p, u.id, idParam(m[1]))],
  ['POST', /^\/api\/tasks\/(\d+)\/logs$/, (p, u, m, q, b) => svc.createLog(p, u.id, idParam(m[1]), b), 201],
  ['DELETE', /^\/api\/logs\/(\d+)$/, (p, u, m) => svc.deleteLog(p, u.id, idParam(m[1]))],
  ['GET', /^\/api\/experiment$/, (p, u) => exp.get(p, u.id)],
  ['PUT', /^\/api\/experiment$/, (p, u, m, q, b) => exp.define(p, u.id, b)],
  ['POST', /^\/api\/experiment\/days$/, (p, u, m, q, b) => exp.addDay(p, u.id, b), 201],
  ['DELETE', /^\/api\/experiment\/days\/(\d+)$/, (p, u, m) => exp.deleteDay(p, u.id, idParam(m[1]))],
  ['POST', /^\/api\/experiment\/rule-change$/, (p, u, m, q, b) => exp.changeRule(p, u.id, b), 201],
];

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

// 다른 사이트에서 몰래 보내는 요청(CSRF)을 막는다: 바꾸는 요청에 Origin이 붙어 있으면 이 서버 주소와 같아야 한다.
// (쿠키도 SameSite=Lax라 다른 사이트의 POST에는 실리지 않는다.)
function checkOrigin(req) {
  if (!MUTATING.includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { host = null; }
  if (host !== req.headers.host) throw new HttpError(403, '다른 사이트에서 보낸 요청은 받지 않습니다');
}

function checkJson(req) {
  const ct = req.headers['content-type'] || '';
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (hasBody && !ct.startsWith('application/json')) throw new HttpError(415, 'Content-Type은 application/json이어야 합니다');
}

function createHandler(pool, { log = console } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/healthz') {
        await pool.query('select 1');
        return send(res, 200, { ok: true });
      }
      checkOrigin(req);

      // ---------- 화면 ----------
      // 첫 화면(/)과 자료 화면(/app)은 서버가 세션을 먼저 확인한다. 로그인하지 않았으면 자료 대신 로그인 화면으로 보낸다.
      if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/app' || pathname === '/index.html')) {
        const user = await auth.currentUser(pool, req);
        if (!user) {
          if (pathname === '/') {
            const buf = fs.readFileSync(path.join(PUBLIC_DIR, 'login.html'));
            return send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          }
          return redirect(res, '/login');
        }
        if (pathname !== '/app') return redirect(res, '/app');
        const buf = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        return send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        const buf = fs.readFileSync(path.join(PUBLIC_DIR, file));
        return send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      }

      // ---------- 가입·로그인·로그아웃 (세션 없이 부를 수 있음) ----------
      if (pathname.startsWith('/api/auth/')) {
        if (req.method === 'POST') checkJson(req);
        if (req.method === 'POST' && pathname === '/api/auth/signup') {
          const { user, session } = await auth.signup(pool, await readJson(req));
          const imported = await importT06IfOwner(pool, user);
          return send(res, 201, { user: auth.userOut(user, session.expires), t06_import: imported },
            { 'Set-Cookie': auth.sessionCookie(req, session.token, session.expires) });
        }
        if (req.method === 'POST' && pathname === '/api/auth/login') {
          const { user, session } = await auth.login(pool, await readJson(req));
          const imported = await importT06IfOwner(pool, user);
          return send(res, 200, { user: auth.userOut(user, session.expires), t06_import: imported },
            { 'Set-Cookie': auth.sessionCookie(req, session.token, session.expires) });
        }
        if (req.method === 'POST' && pathname === '/api/auth/logout') {
          await auth.logout(pool, req);
          return send(res, 200, { logged_out: true }, { 'Set-Cookie': auth.clearCookie(req) });
        }
        if (!(req.method === 'GET' && pathname === '/api/auth/me')) throw new HttpError(404, '찾을 수 없습니다');
      }

      // ---------- 여기부터는 로그인한 사람만 ----------
      if (!pathname.startsWith('/api/')) throw new HttpError(404, '찾을 수 없습니다');
      const user = await auth.currentUser(pool, req);
      if (!user) throw new HttpError(401, '로그인이 필요합니다');

      if (req.method === 'GET' && pathname === '/api/auth/me') {
        return send(res, 200, { user: auth.userOut(user, user.expires_at), t06_import: await importStatus(pool, user.id) });
      }
      if (req.method === 'POST' && pathname === '/api/account/password') {
        checkJson(req);
        const out = await auth.changePassword(pool, user, await readJson(req));
        return send(res, 200, { changed: true, revoked_sessions: out.revoked_sessions },
          { 'Set-Cookie': auth.sessionCookie(req, out.session.token, out.session.expires) });
      }
      if (req.method === 'DELETE' && pathname === '/api/account') {
        checkJson(req);
        const out = await auth.deleteAccount(pool, user, await readJson(req));
        return send(res, 200, out, { 'Set-Cookie': auth.clearCookie(req) });
      }
      if (req.method === 'GET' && pathname === '/api/export') {
        const data = await svc.exportAll(pool, user, {
          experiment: await exp.get(pool, user.id),
          t06_import: await importStatus(pool, user.id),
        });
        const stamp = data.today_seoul;
        return send(res, 200, JSON.stringify(data, null, 2), {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="pds-export-${user.username}-${stamp}.json"`,
        });
      }
      const allowed = [];
      for (const [method, re, fn, okStatus] of ROUTES) {
        const m = pathname.match(re);
        if (!m) continue;
        allowed.push(method);
        if (method !== req.method) continue;
        if (['POST', 'PUT', 'PATCH'].includes(method)) checkJson(req);
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(req) : {};
        const query = Object.fromEntries(url.searchParams);
        const out = await fn(pool, user, m, query, body);
        return send(res, okStatus || 200, out);
      }
      if (allowed.length) throw new HttpError(405, '허용되지 않은 방법입니다');
      throw new HttpError(404, '찾을 수 없습니다');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      // DB 오류 원문(접속 정보 포함 가능)과 요청 본문(비밀번호 포함 가능)은 응답에도 로그에도 싣지 않는다.
      log.error('[server]', req.method, pathname, err && err.code, err && err.message);
      return send(res, 500, { error: '서버에서 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  };
}

module.exports = { createHandler };
