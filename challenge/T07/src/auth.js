'use strict';
// 계정·로그인·세션. 비밀번호 해시는 argon2 라이브러리(argon2id)에 맡기고, 세션은 DB 표 하나로 직접 관리한다.
//
// 세션 방식
//   * 로그인하면 crypto.randomBytes(32)로 무작위 토큰을 만들어 쿠키(pds_sid)로 준다.
//   * DB에는 토큰 원문이 아니라 SHA-256 값만 저장한다. 서명용 비밀키는 없다 (그래서 새어 나갈 비밀키도 없다).
//   * 요청마다 쿠키 토큰의 SHA-256으로 sessions를 찾고, 끊기지 않았고(revoked_at 없음) 만료 전인지 본다.
//   * 로그아웃: 그 세션에 revoked_at을 적는다. 비밀번호 변경: 그 계정의 모든 세션에 revoked_at을 적는다.
const crypto = require('node:crypto');
const argon2 = require('argon2');
const { tx } = require('./db');
const { HttpError, bad } = require('./validate');

const COOKIE = 'pds_sid';
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const LOGIN_FAIL = '아이디 또는 비밀번호가 맞지 않습니다';

// argon2id 기본값(메모리 64MiB, 반복 3, 병렬 4). 소금값은 라이브러리가 해시마다 새로 만들어 해시 문자열 안에 넣는다.
const HASH_OPTS = { type: argon2.argon2id };

// 없는 아이디로 로그인할 때도 같은 시간만큼 해시 검사를 하도록 쓰는 가짜 해시 (아무 비밀번호의 해시가 아님).
let dummyHash;
const getDummy = async () => (dummyHash ||= await argon2.hash(crypto.randomBytes(32).toString('hex'), HASH_OPTS));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function username(body) {
  const v = body.username;
  if (typeof v !== 'string') throw bad('아이디를 입력하세요');
  const u = v.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(u)) throw bad('아이디는 영문 소문자·숫자·밑줄(_) 3~30자입니다');
  return u;
}

function password(body, key = 'password', label = '비밀번호') {
  const v = body[key];
  if (typeof v !== 'string' || !v) throw bad(`${label}를 입력하세요`);
  if (v.length < 10) throw bad(`${label}는 10자 이상이어야 합니다`);
  if (Buffer.byteLength(v, 'utf8') > 256) throw bad(`${label}가 너무 깁니다`);
  return v;
}

// ---------- 로그인 실패 제한 (아이디별, 서버 메모리) ----------
// 같은 아이디로 15분 안에 10번 틀리면 15분 동안 그 아이디의 로그인을 막는다. 아이디가 있든 없든 똑같이 센다.
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();
function checkThrottle(u) {
  const f = fails.get(u);
  if (f && f.count >= FAIL_LIMIT && Date.now() - f.first < FAIL_WINDOW_MS) {
    throw new HttpError(429, '로그인 시도가 너무 많습니다. 15분 뒤 다시 시도하세요');
  }
}
function recordFail(u) {
  const f = fails.get(u);
  if (!f || Date.now() - f.first >= FAIL_WINDOW_MS) fails.set(u, { count: 1, first: Date.now() });
  else f.count++;
  if (fails.size > 10000) fails.clear();
}

// ---------- 세션 ----------
async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_MS);
  await db.query('insert into sessions (user_id, token_hash, expires_at) values ($1, $2, $3)', [userId, sha256(token), expires]);
  return { token, expires };
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

// 요청의 쿠키로 로그인한 사람을 찾는다. 없거나 끊겼거나 만료됐으면 null.
async function currentUser(pool, req) {
  const token = readCookie(req);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await pool.query(
    `select s.id as session_id, s.expires_at, u.id, u.username, u.created_at
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] || null;
}

function isSecure(req) {
  return process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
}

// 토큰은 쿠키로만 오간다 (주소창·응답 본문에 싣지 않는다). HttpOnly라 화면 스크립트도 읽지 못한다.
function sessionCookie(req, token, expires) {
  return [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`, `Expires=${expires.toUTCString()}`,
    isSecure(req) ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}
function clearCookie(req) {
  return [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', isSecure(req) ? 'Secure' : null].filter(Boolean).join('; ');
}

const userOut = (u, s) => ({
  username: u.username,
  created_at: new Date(u.created_at).toISOString(),
  session_expires_at: s ? new Date(s).toISOString() : undefined,
});

// ---------- 가입·로그인·로그아웃 ----------
async function signup(pool, body) {
  const u = username(body);
  const pw = password(body);
  const hash = await argon2.hash(pw, HASH_OPTS);
  return tx(pool, async (c) => {
    const ins = await c.query(
      'insert into users (username, password_hash) values ($1, $2) on conflict (username) do nothing returning *',
      [u, hash],
    );
    if (!ins.rows[0]) throw new HttpError(409, '이미 쓰이는 아이디입니다');
    const s = await createSession(c, ins.rows[0].id);
    return { user: ins.rows[0], session: s };
  });
}

async function login(pool, body) {
  const u = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!u || !pw) throw new HttpError(401, LOGIN_FAIL);
  checkThrottle(u);
  const { rows } = await pool.query('select * from users where username = $1', [u]);
  const user = rows[0];
  // 아이디가 없어도 해시 검사를 한 번 해서, 응답 문구와 걸리는 시간이 아이디 유무를 드러내지 않게 한다.
  const ok = await argon2.verify(user ? user.password_hash : await getDummy(), pw).catch(() => false);
  if (!user || !ok) {
    recordFail(u);
    throw new HttpError(401, LOGIN_FAIL);
  }
  fails.delete(u);
  const s = await createSession(pool, user.id);
  return { user, session: s };
}

async function logout(pool, req) {
  const token = readCookie(req);
  if (token) await pool.query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [sha256(token)]);
}

async function verifyPassword(pool, userId, pw) {
  const { rows } = await pool.query('select password_hash from users where id = $1', [userId]);
  if (!rows[0] || !(await argon2.verify(rows[0].password_hash, pw).catch(() => false))) {
    throw new HttpError(403, '지금 비밀번호가 맞지 않습니다');
  }
}

// 비밀번호를 바꾸면 이 계정의 모든 세션(지금 것 포함)을 끊고, 지금 브라우저에만 새 세션을 준다.
async function changePassword(pool, user, body) {
  const cur = typeof body.current_password === 'string' ? body.current_password : '';
  const next = password(body, 'new_password', '새 비밀번호');
  await verifyPassword(pool, user.id, cur);
  const hash = await argon2.hash(next, HASH_OPTS);
  return tx(pool, async (c) => {
    await c.query('update users set password_hash = $2, password_changed_at = now() where id = $1', [user.id, hash]);
    const r = await c.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [user.id]);
    const s = await createSession(c, user.id);
    return { revoked_sessions: r.rowCount, session: s };
  });
}

// 계정 지우기: 비밀번호를 한 번 더 받고, users 한 줄을 지운다. 계획·할 일·실행 기록·돌아보기·5일 기록·세션은 cascade로 함께 지워진다.
async function deleteAccount(pool, user, body) {
  await verifyPassword(pool, user.id, typeof body.password === 'string' ? body.password : '');
  return tx(pool, async (c) => {
    const counts = (await c.query(
      `select (select count(*) from plans where owner_id = $1)::int as plans,
              (select count(*) from tasks t join plans p on p.id = t.plan_id where p.owner_id = $1)::int as tasks`,
      [user.id],
    )).rows[0];
    await c.query('delete from users where id = $1', [user.id]);
    return { deleted: true, removed: counts };
  });
}

module.exports = {
  COOKIE, SESSION_DAYS, LOGIN_FAIL,
  signup, login, logout, currentUser, changePassword, deleteAccount,
  sessionCookie, clearCookie, userOut, readCookie,
  _resetThrottle: () => fails.clear(),
};
