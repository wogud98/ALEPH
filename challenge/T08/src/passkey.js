'use strict';
// 패스키(WebAuthn) 등록·로그인·로그아웃과 세션. 비밀번호는 어디에도 없다.
//
// 서명 확인은 라이브러리 @simplewebauthn/server 13.3.3에 맡기고, 질문 보관·한 번만 쓰기·세션은 직접 짠다.
//
// 등록 (처음 계정 만들기, 또는 로그인한 뒤 패스키 추가)
//   1. options: 서버가 무작위 질문(challenge 32바이트)을 만들어 challenges 표에 5분 동안 보관하고 브라우저로 보낸다.
//      그 줄을 찾을 무작위 표(ticket)는 HttpOnly 쿠키 t08_ch로 주고, DB에는 표의 SHA-256만 둔다.
//   2. 브라우저(기기)가 열쇠 한 쌍을 만들고 공개키 + 질문에 대한 서명이 든 attestationObject를 돌려준다.
//   3. verify: 표로 질문을 "꺼내면서 다 썼다고 적고"(한 문장), 라이브러리가 질문·출처·RP ID를 확인하면 공개키만 저장한다.
// 로그인
//   1. options: 로그인용 질문을 새로 만들어 보관하고 보낸다 (allowCredentials는 비움: 기기가 이 사이트 패스키를 고르게 함).
//   2. 기기가 개인키로 (authenticatorData + 질문이 든 clientDataJSON의 해시)에 서명한다.
//   3. verify: 질문을 꺼내고, credential_id로 저장된 공개키를 찾아 서명을 확인한 뒤에만 세션을 준다.
const crypto = require('node:crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { tx } = require('./db');
const { HttpError, bad } = require('./validate');

const SID = 't08_sid';
const TICKET = 't08_ch';
const SESSION_HOURS = 12;
const SESSION_MS = SESSION_HOURS * 3600 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const RP_NAME = '지나온 경로와 강점 · 나만 보는 자리';
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS) || 20;
const LOGIN_FAIL = '패스키로 들어가지 못했습니다';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// 패스키가 저장된 곳을 AAGUID(인증기 종류 번호)로 짐작한다. 모르는 번호면 동기화 여부로만 적는다.
const AAGUID_NAMES = {
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google 비밀번호 관리자',
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'iCloud 키체인',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Mac용 Chrome',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  // scripts/soft-authenticator.js (검사·기록용 가상 인증기)
  '7e570000-0000-0000-0000-000000000008': '검사용 가상 인증기',
};
function storage(c) {
  const known = AAGUID_NAMES[c.aaguid];
  if (known) return { place: known, kind: c.device_type === 'multiDevice' ? '동기화 패스키' : '기기 자체' };
  if (c.device_type === 'multiDevice') return { place: '알 수 없는 비밀번호 관리자', kind: '동기화 패스키' };
  if ((c.transports || []).some((t) => ['usb', 'nfc', 'ble'].includes(t))) return { place: '보안 키', kind: '기기 자체' };
  return { place: '이 기기', kind: '기기 자체' };
}

// ---------- 입력 ----------
function username(v) {
  if (typeof v !== 'string') throw bad('아이디를 입력하세요');
  const u = v.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(u)) throw bad('아이디는 영문 소문자·숫자·밑줄(_) 3~30자입니다');
  return u;
}
function passkeyName(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string') throw bad('패스키 이름은 글자여야 합니다');
  const s = v.trim();
  if (!s) return fallback;
  if (s.length > 40) throw bad('패스키 이름은 40자 이하로 적어 주세요');
  return s;
}
const defaultName = () => `패스키 ${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}`;

// ---------- 쿠키 ----------
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function isSecure(req) {
  return process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
}
function cookie(req, name, value, maxAgeSec, cookiePath = '/') {
  return [`${name}=${value}`, `Path=${cookiePath}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`, isSecure(req) ? 'Secure' : null]
    .filter(Boolean).join('; ');
}
const ticketCookie = (req, t) => cookie(req, TICKET, t, CHALLENGE_MS / 1000, '/api/passkey');
const clearTicket = (req) => cookie(req, TICKET, '', 0, '/api/passkey');
const sessionCookie = (req, t) => cookie(req, SID, t, SESSION_MS / 1000);
const clearSession = (req) => cookie(req, SID, '', 0);

// ---------- 일회용 질문 ----------
async function saveChallenge(pool, row) {
  // 오래된 질문은 그때그때 치운다 (하루 지난 것).
  await pool.query("delete from challenges where expires_at < now() - interval '1 day'");
  const ticket = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `insert into challenges (ticket_hash, purpose, challenge, user_id, pending_username, pending_user_id, pending_name, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [sha256(ticket), row.purpose, row.challenge, row.user_id || null, row.pending_username || null,
      row.pending_user_id || null, row.pending_name || null, new Date(Date.now() + CHALLENGE_MS)],
  );
  return ticket;
}

// 표로 질문을 꺼낸다. 꺼내는 순간 used_at을 적으므로, 같은 질문으로는 서명이 맞든 틀리든 두 번째 시도가 없다.
async function takeChallenge(pool, req, purpose, failStatus) {
  const ticket = readCookie(req, TICKET);
  if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new HttpError(failStatus, '질문이 없습니다. 처음부터 다시 시도하세요');
  const { rows } = await pool.query(
    `update challenges set used_at = now()
     where ticket_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
     returning *`,
    [sha256(ticket), purpose],
  );
  if (rows[0]) return rows[0];
  const old = (await pool.query('select used_at, expires_at from challenges where ticket_hash = $1', [sha256(ticket)])).rows[0];
  if (old && old.used_at) throw new HttpError(failStatus, '이 질문은 이미 쓰였습니다. 새 질문을 받아 다시 시도하세요');
  if (old) throw new HttpError(failStatus, '질문의 유효 시간(5분)이 지났습니다. 다시 시도하세요');
  throw new HttpError(failStatus, '질문이 없습니다. 처음부터 다시 시도하세요');
}

// ---------- 세션 ----------
async function createSession(db, userId, credentialRowId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    'insert into sessions (user_id, token_hash, credential_id, expires_at) values ($1, $2, $3, $4)',
    [userId, sha256(token), credentialRowId, new Date(Date.now() + SESSION_MS)],
  );
  return token;
}

async function currentUser(pool, req) {
  const token = readCookie(req, SID);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { rows } = await pool.query(
    `select s.id as session_id, s.credential_id as session_credential_id, s.expires_at, u.id, u.username, u.webauthn_user_id, u.created_at
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] || null;
}

async function logout(pool, req) {
  const token = readCookie(req, SID);
  if (!token) return 0;
  const r = await pool.query('update sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [sha256(token)]);
  return r.rowCount;
}

// ---------- 패스키 목록 (내 것만) ----------
function credOut(c) {
  return {
    id: c.id,
    name: c.name,
    credential_id: c.credential_id,
    created_at: new Date(c.created_at).toISOString(),
    last_used_at: c.last_used_at ? new Date(c.last_used_at).toISOString() : null,
    stored_in: storage(c),
    device_type: c.device_type,
    backed_up: c.backed_up,
    aaguid: c.aaguid,
    transports: c.transports,
    sign_count: Number(c.sign_count),
    // 서버에 저장된 값 그대로 (COSE 형식 공개키). 공개키라 보여 줘도 되는 값이다.
    public_key_cose: isoBase64URL.fromBuffer(new Uint8Array(c.public_key)),
  };
}
async function listPasskeys(pool, userId) {
  const { rows } = await pool.query('select * from credentials where user_id = $1 order by id', [userId]);
  return rows.map(credOut);
}

function userOut(u) {
  return { username: u.username, created_at: new Date(u.created_at).toISOString() };
}

// ---------- 등록 ----------
function registrationOptions(rp, { userName, userID, exclude = [] }) {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName,
    userDisplayName: userName,
    userID,
    timeout: CHALLENGE_MS,
    attestationType: 'none',
    excludeCredentials: exclude.map((c) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    supportedAlgorithmIDs: [-7, -257],
  });
}

async function verifyRegistration(rp, row, response) {
  if (!response || typeof response !== 'object') throw bad('패스키 응답이 없습니다');
  let v;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    throw bad(`패스키 등록을 확인하지 못했습니다: ${err.message}`);
  }
  if (!v.verified || !v.registrationInfo) throw bad('패스키 등록을 확인하지 못했습니다');
  const info = v.registrationInfo;
  return {
    credential_id: info.credential.id,
    public_key: Buffer.from(info.credential.publicKey),
    sign_count: info.credential.counter,
    transports: Array.isArray(response.response?.transports) ? response.response.transports.filter((t) => typeof t === 'string').slice(0, 6) : [],
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp,
    aaguid: info.aaguid,
  };
}

async function insertCredential(c, userId, cred, name) {
  const r = await c.query(
    `insert into credentials (user_id, credential_id, public_key, sign_count, transports, device_type, backed_up, aaguid, name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (credential_id) do nothing returning *`,
    [userId, cred.credential_id, cred.public_key, cred.sign_count, cred.transports, cred.device_type, cred.backed_up, cred.aaguid, name],
  );
  if (!r.rows[0]) throw new HttpError(409, '이미 등록된 패스키입니다');
  return r.rows[0];
}

// 처음 계정 만들기: 아이디와 패스키 이름만 받는다. 계정은 패스키 확인이 끝난 뒤에야 만든다 (취소하면 아무것도 남지 않음).
async function signupOptions(pool, rp, body) {
  if (process.env.SIGNUP_OPEN === '0') throw new HttpError(403, '지금은 새 계정을 만들 수 없습니다');
  const u = username(body.username);
  const name = passkeyName(body.name, defaultName());
  const taken = await pool.query('select 1 from users where username = $1', [u]);
  if (taken.rows[0]) throw new HttpError(409, '이미 쓰이는 아이디입니다');
  const count = (await pool.query('select count(*)::int as n from users')).rows[0].n;
  if (count >= MAX_ACCOUNTS) throw new HttpError(403, '계정 수가 한도에 닿아 새 계정을 만들 수 없습니다');
  const userID = crypto.randomBytes(32);
  const options = await registrationOptions(rp, { userName: u, userID });
  const ticket = await saveChallenge(pool, {
    purpose: 'signup', challenge: options.challenge, pending_username: u, pending_user_id: userID, pending_name: name,
  });
  return { options, ticket };
}

async function signupVerify(pool, rp, req, body) {
  const row = await takeChallenge(pool, req, 'signup', 400);
  const cred = await verifyRegistration(rp, row, body.response);
  return tx(pool, async (c) => {
    const ins = await c.query(
      'insert into users (username, webauthn_user_id) values ($1, $2) on conflict do nothing returning *',
      [row.pending_username, row.pending_user_id],
    );
    if (!ins.rows[0]) throw new HttpError(409, '이미 쓰이는 아이디입니다');
    const user = ins.rows[0];
    const saved = await insertCredential(c, user.id, cred, row.pending_name);
    const token = await createSession(c, user.id, saved.id);
    return { user, passkey: credOut(saved), token };
  });
}

// 로그인한 사람이 두 번째(세 번째…) 패스키를 더한다. 이미 등록된 패스키는 excludeCredentials로 알려 같은 인증기에 겹쳐 만들지 않게 한다.
async function addOptions(pool, rp, user, body) {
  const name = passkeyName(body.name, defaultName());
  const { rows } = await pool.query('select credential_id, transports from credentials where user_id = $1', [user.id]);
  if (rows.length >= 10) throw new HttpError(409, '패스키는 한 계정에 10개까지 둘 수 있습니다');
  const options = await registrationOptions(rp, { userName: user.username, userID: new Uint8Array(user.webauthn_user_id), exclude: rows });
  const ticket = await saveChallenge(pool, { purpose: 'add', challenge: options.challenge, user_id: user.id, pending_name: name });
  return { options, ticket };
}

async function addVerify(pool, rp, req, user, body) {
  const row = await takeChallenge(pool, req, 'add', 400);
  if (Number(row.user_id) !== Number(user.id)) throw new HttpError(403, '다른 계정에서 받은 질문입니다');
  const cred = await verifyRegistration(rp, row, body.response);
  const saved = await insertCredential(pool, user.id, cred, row.pending_name);
  return { passkey: credOut(saved) };
}

// ---------- 로그인 ----------
async function loginOptions(pool, rp) {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID, timeout: CHALLENGE_MS, userVerification: 'preferred', allowCredentials: [],
  });
  const ticket = await saveChallenge(pool, { purpose: 'login', challenge: options.challenge });
  return { options, ticket };
}

async function loginVerify(pool, rp, req, body) {
  const row = await takeChallenge(pool, req, 'login', 401);
  const response = body.response;
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') throw new HttpError(401, LOGIN_FAIL);
  // 서버에 있는 공개키 가운데 이 응답의 credential_id와 같은 것을 찾는다. 없으면(지운 패스키, 남의 사이트 패스키) 거절.
  const { rows } = await pool.query(
    'select c.*, u.webauthn_user_id from credentials c join users u on u.id = c.user_id where c.credential_id = $1',
    [response.id],
  );
  const cred = rows[0];
  if (!cred) throw new HttpError(401, `${LOGIN_FAIL}: 등록되지 않은 패스키입니다`);
  // 패스키 안의 사용자 핸들이 그 공개키의 주인과 같아야 한다.
  const handle = response.response?.userHandle;
  if (handle && handle !== isoBase64URL.fromBuffer(new Uint8Array(cred.webauthn_user_id))) {
    throw new HttpError(401, `${LOGIN_FAIL}: 패스키와 계정이 맞지 않습니다`);
  }
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: row.challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
      credential: {
        id: cred.credential_id,
        publicKey: new Uint8Array(cred.public_key),
        counter: Number(cred.sign_count),
        transports: cred.transports,
      },
    });
  } catch (err) {
    throw new HttpError(401, `${LOGIN_FAIL}: ${err.message}`);
  }
  // 서명이 공개키로 확인되지 않으면 여기서 끝난다. 결과를 버리지 않는다.
  if (!v.verified) throw new HttpError(401, `${LOGIN_FAIL}: 서명이 저장된 공개키와 맞지 않습니다`);
  return tx(pool, async (c) => {
    await c.query('update credentials set sign_count = $2, last_used_at = now() where id = $1', [cred.id, v.authenticationInfo.newCounter]);
    const user = (await c.query('select * from users where id = $1', [cred.user_id])).rows[0];
    const token = await createSession(c, user.id, cred.id);
    return { user, passkey_name: cred.name, token };
  });
}

// ---------- 패스키 관리 (내 것만) ----------
// 마지막 하나는 지우지 않는다: 지우면 이 계정에 들어갈 방법이 없어진다 (비밀번호도, 복구 코드도 없다).
// 지운 패스키로 열었던 세션은 함께 끊는다 (잃어버린 기기에서 이미 들어가 있던 것까지 막기 위해).
async function deletePasskey(pool, user, id) {
  return tx(pool, async (c) => {
    const mine = (await c.query('select id from credentials where user_id = $1 for update', [user.id])).rows;
    if (!mine.some((r) => Number(r.id) === id)) throw new HttpError(404, '찾을 수 없습니다');
    if (mine.length <= 1) {
      throw new HttpError(409, '마지막 패스키는 지울 수 없습니다. 지우면 이 계정에 들어갈 방법이 없어집니다. 먼저 다른 기기에서 패스키를 하나 더 등록하세요');
    }
    const s = await c.query('update sessions set revoked_at = now() where credential_id = $1 and revoked_at is null', [id]);
    await c.query('delete from credentials where id = $1 and user_id = $2', [id, user.id]);
    return { deleted: true, remaining: mine.length - 1, revoked_sessions: s.rowCount, logged_out: Number(user.session_credential_id) === id };
  });
}

async function renamePasskey(pool, user, id, body) {
  const name = passkeyName(body.name, null);
  if (!name) throw bad('패스키 이름을 입력하세요');
  const { rows } = await pool.query('update credentials set name = $3 where id = $1 and user_id = $2 returning *', [id, user.id, name]);
  if (!rows[0]) throw new HttpError(404, '찾을 수 없습니다');
  return { passkey: credOut(rows[0]) };
}

module.exports = {
  SID, TICKET, SESSION_HOURS, LOGIN_FAIL, AAGUID_NAMES,
  signupOptions, signupVerify, addOptions, addVerify, loginOptions, loginVerify,
  logout, currentUser, listPasskeys, deletePasskey, renamePasskey, userOut, storage,
  ticketCookie, clearTicket, sessionCookie, clearSession,
};
