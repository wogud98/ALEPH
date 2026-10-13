'use strict';
const http = require('node:http');
const { createPool, migrate, SCHEMA } = require('../src/db');
const { createHandler } = require('../src/app');
const auth = require('../src/auth');

// 실제 PostgreSQL에 붙어 검사한다. TEST_DATABASE_URL의 t07·public 스키마를 매번 비우므로 운영 DB를 넣지 말 것.
// 검사용 비밀번호는 매번 무작위로 만든다 (어디에도 적어 두지 않는다).
const crypto = require('node:crypto');
const testPassword = () => `pw-${crypto.randomBytes(9).toString('base64url')}`;

async function startTestServer({ resetPublic = false } = {}) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL이 필요합니다 (검사용 빈 DB)');
  const pool = createPool(url);
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  if (resetPublic) await pool.query('drop schema if exists public cascade; create schema public;');
  await migrate(pool);
  auth._resetThrottle();
  const server = http.createServer(createHandler(pool, { log: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 브라우저 하나처럼 쿠키를 들고 다니는 요청 도우미
  function client() {
    const c = { cookie: '' };
    c.call = async (method, path, body, headers = {}) => {
      const h = { ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      if (c.cookie && !('cookie' in h)) h.cookie = c.cookie;
      const res = await fetch(base + path, {
        method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) {
        const v = setCookie.split(';')[0];
        c.cookie = v.endsWith('=') ? '' : v;
      }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: res.status, headers: res.headers, json, text };
    };
    c.signup = async (username, password = testPassword()) => {
      const r = await c.call('POST', '/api/auth/signup', { username, password });
      if (r.status !== 201) throw new Error(`가입 실패 ${r.status} ${r.text}`);
      c.username = username;
      c.password = password;
      return r;
    };
    return c;
  }

  const main = client();
  await main.signup('tester');

  async function close() {
    await new Promise((r) => server.close(r));
    await pool.end();
  }
  return { pool, base, call: main.call, main, client, close };
}

function seoulToday(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

let n = 0;
const key = () => `testkey${Date.now()}${++n}`;

module.exports = { startTestServer, seoulToday, key, testPassword };
