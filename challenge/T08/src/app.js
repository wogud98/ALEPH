'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pk = require('./passkey');
const priv = require('./private');
const { HttpError, idParam } = require('./validate');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// 1번 과제 소개 페이지 원본. 복사하지 않고 그 파일을 그대로 읽어, 1번의 공개 내용이 바뀌지 않게 한다.
const T01_HTML = process.env.T01_HTML || path.join(__dirname, '..', '..', 'T01', 'index.html');

// 소개 페이지 = 1번 원본 + 맨 아래 "나만 보는 자리" 틀. 틀에는 단추와 안내 글자만 있고 비공개 내용은 없다.
// 비공개 내용은 패스키로 들어온 뒤 /api/private/items 로만 내려간다.
function buildPage() {
  const t01 = fs.readFileSync(T01_HTML, 'utf8');
  const vault = fs.readFileSync(path.join(PUBLIC_DIR, 'vault.html'), 'utf8');
  if (!t01.includes('</main>') || !t01.includes('</head>') || !t01.includes('</body>')) throw new Error('T01 index.html 모양이 예상과 다릅니다');
  const html = t01
    .replace('</head>', '<link rel="stylesheet" href="/vault.css">\n</head>')
    .replace('</main>', `${vault}\n</main>`)
    .replace('</body>', '<script src="/vault.js" defer></script>\n</body>');
  // 1번 원본에 있는 인라인 <script>·<style>만 해시로 허락하고, 그 밖의 인라인 코드는 막는다.
  const hashes = (re) => [...t01.matchAll(re)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`).join(' ');
  const csp =
    `default-src 'self'; script-src 'self' ${hashes(/<script>([\s\S]*?)<\/script>/g)}; ` +
    `style-src 'self' https://fonts.googleapis.com ${hashes(/<style>([\s\S]*?)<\/style>/g)}; ` +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  return { html, csp };
}

const STATIC = {
  '/vault.js': ['vault.js', 'text/javascript; charset=utf-8'],
  '/vault.css': ['vault.css', 'text/css; charset=utf-8'],
};

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  const h = {
    ...BASE_HEADERS,
    'Content-Security-Policy': API_CSP,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };
  // 쿠키 두 개(세션·질문 표)를 한 번에 보낼 수 있게 배열로 받는다.
  if (Array.isArray(h['Set-Cookie']) && !h['Set-Cookie'].length) delete h['Set-Cookie'];
  res.writeHead(status, h);
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
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

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
// 다른 사이트에서 몰래 보내는 요청을 막는다: 바꾸는 요청에 Origin이 붙어 있으면 이 서버 주소와 같아야 한다.
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

// RP(이 사이트) 설정. Render는 RENDER_EXTERNAL_HOSTNAME·RENDER_EXTERNAL_URL을 스스로 넣어 준다.
function rpFromEnv() {
  const port = Number(process.env.PORT) || 3000;
  const rpID = process.env.RP_ID || process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost';
  const origin = process.env.ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  return { rpID, origins: origin.split(',').map((s) => s.trim()).filter(Boolean) };
}

// 로그인한 사람만 부를 수 있는 API. handler(pool, user, match, query, body)
// user는 세션 쿠키로 찾은 사람이다. 주소·본문에 다른 계정을 적어 보내도 쓰지 않는다.
const ROUTES = [
  ['GET', /^\/api\/me$/, async (p, u) => ({ user: pk.userOut(u), current_passkey_id: u.session_credential_id, passkeys: await pk.listPasskeys(p, u.id) })],
  ['GET', /^\/api\/passkeys$/, async (p, u) => ({ passkeys: await pk.listPasskeys(p, u.id) })],
  ['PATCH', /^\/api\/passkeys\/(\d+)$/, (p, u, m, q, b) => pk.renamePasskey(p, u, idParam(m[1]), b)],
  ['DELETE', /^\/api\/passkeys\/(\d+)$/, (p, u, m) => pk.deletePasskey(p, u, idParam(m[1]))],
  ['GET', /^\/api\/private\/items$/, (p, u) => priv.list(p, u.id)],
  ['POST', /^\/api\/private\/items$/, (p, u, m, q, b) => priv.create(p, u.id, b), 201],
  ['POST', /^\/api\/private\/examples$/, (p, u) => priv.addExamples(p, u.id), 201],
  ['GET', /^\/api\/private\/items\/(\d+)$/, (p, u, m) => priv.get(p, u.id, idParam(m[1]))],
  ['DELETE', /^\/api\/private\/items\/(\d+)$/, (p, u, m) => priv.remove(p, u.id, idParam(m[1]))],
];

function createHandler(pool, { rp = rpFromEnv(), log = console } = {}) {
  const page = buildPage();
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/healthz') {
        await pool.query('select 1');
        return send(res, 200, { ok: true });
      }
      checkOrigin(req);

      // ---------- 화면: 누구나 열 수 있다 (같은 HTML을 모두에게 준다) ----------
      if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname === '/index.html')) {
        return send(res, 200, page.html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': page.csp, 'Cache-Control': 'no-cache' });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      }
      if (!pathname.startsWith('/api/')) throw new HttpError(404, '찾을 수 없습니다');
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) checkJson(req);

      // ---------- 패스키 등록·로그인·로그아웃 ----------
      if (req.method === 'POST' && pathname === '/api/passkey/signup/options') {
        const { options, ticket } = await pk.signupOptions(pool, rp, await readJson(req));
        return send(res, 200, { options }, { 'Set-Cookie': pk.ticketCookie(req, ticket) });
      }
      if (req.method === 'POST' && pathname === '/api/passkey/signup/verify') {
        const out = await pk.signupVerify(pool, rp, req, await readJson(req));
        return send(res, 201, { user: pk.userOut(out.user), passkey: out.passkey },
          { 'Set-Cookie': [pk.sessionCookie(req, out.token), pk.clearTicket(req)] });
      }
      if (req.method === 'POST' && pathname === '/api/passkey/login/options') {
        const { options, ticket } = await pk.loginOptions(pool, rp);
        return send(res, 200, { options }, { 'Set-Cookie': pk.ticketCookie(req, ticket) });
      }
      if (req.method === 'POST' && pathname === '/api/passkey/login/verify') {
        const out = await pk.loginVerify(pool, rp, req, await readJson(req));
        return send(res, 200, { user: pk.userOut(out.user), passkey_name: out.passkey_name, session_hours: pk.SESSION_HOURS },
          { 'Set-Cookie': [pk.sessionCookie(req, out.token), pk.clearTicket(req)] });
      }
      if (req.method === 'POST' && pathname === '/api/passkey/logout') {
        const n = await pk.logout(pool, req);
        return send(res, 200, { logged_out: true, revoked_sessions: n }, { 'Set-Cookie': pk.clearSession(req) });
      }

      // ---------- 여기부터는 패스키로 들어온 사람만 ----------
      const user = await pk.currentUser(pool, req);
      if (!user) throw new HttpError(401, '패스키로 들어와야 볼 수 있습니다');

      if (req.method === 'POST' && pathname === '/api/passkey/add/options') {
        const { options, ticket } = await pk.addOptions(pool, rp, user, await readJson(req));
        return send(res, 200, { options }, { 'Set-Cookie': pk.ticketCookie(req, ticket) });
      }
      if (req.method === 'POST' && pathname === '/api/passkey/add/verify') {
        const out = await pk.addVerify(pool, rp, req, user, await readJson(req));
        return send(res, 201, out, { 'Set-Cookie': pk.clearTicket(req) });
      }

      const allowed = [];
      for (const [method, re, fn, okStatus] of ROUTES) {
        const m = pathname.match(re);
        if (!m) continue;
        allowed.push(method);
        if (method !== req.method) continue;
        const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readJson(req) : {};
        const out = await fn(pool, user, m, Object.fromEntries(url.searchParams), body);
        // 지금 쓰는 세션을 연 패스키를 지웠으면 이 브라우저도 로그아웃된다.
        const extra = out && out.logged_out ? { 'Set-Cookie': pk.clearSession(req) } : {};
        return send(res, okStatus || 200, out, extra);
      }
      if (allowed.length) throw new HttpError(405, '허용되지 않은 방법입니다');
      throw new HttpError(404, '찾을 수 없습니다');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      // DB 오류 원문(접속 정보 포함 가능)은 응답에 싣지 않는다.
      log.error('[server]', req.method, pathname, err && err.code, err && err.message);
      return send(res, 500, { error: '서버에서 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' });
    }
  };
}

module.exports = { createHandler, buildPage, rpFromEnv };
