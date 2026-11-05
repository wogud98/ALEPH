'use strict';
const http = require('node:http');
const { createPool, migrate, SCHEMA } = require('../src/db');
const { createHandler } = require('../src/app');
const { SoftAuthenticator } = require('../scripts/soft-authenticator');

// 실제 PostgreSQL에 붙어 검사한다. TEST_DATABASE_URL의 t08 스키마를 매번 비우므로 운영 DB를 넣지 말 것.
async function startTestServer() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL이 필요합니다 (검사용 빈 DB)');
  const pool = createPool(url);
  await pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await migrate(pool);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://localhost:${port}`;
  server.on('request', createHandler(pool, { rp: { rpID: 'localhost', origins: [origin] }, log: process.env.TEST_LOG ? console : { error() {} } }));
  const base = `http://127.0.0.1:${port}`;

  // 브라우저 하나처럼 쿠키(세션·질문 표)를 들고 다니는 요청 도우미 + 그 브라우저의 인증기
  function client(label) {
    const c = { cookies: {}, auth: new SoftAuthenticator({ origin, rpId: 'localhost', label }) };
    c.cookieHeader = () => Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    c.call = async (method, path, body, headers = {}) => {
      const h = { ...headers };
      if (body !== undefined) h['content-type'] = 'application/json';
      if (!('cookie' in h) && Object.keys(c.cookies).length) h.cookie = c.cookieHeader();
      const res = await fetch(base + path, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
      for (const sc of res.headers.getSetCookie()) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i);
        const v = kv.slice(i + 1);
        if (v) c.cookies[k] = v; else delete c.cookies[k];
      }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: res.status, headers: res.headers, json, text };
    };
    c.signup = async (username, name = '첫 패스키') => {
      const o = await c.call('POST', '/api/passkey/signup/options', { username, name });
      if (o.status !== 200) throw new Error(`options ${o.status} ${o.text}`);
      const r = await c.call('POST', '/api/passkey/signup/verify', { response: c.auth.create(o.json.options) });
      if (r.status !== 201) throw new Error(`verify ${r.status} ${r.text}`);
      return r;
    };
    c.add = async (name, auth = c.auth) => {
      const o = await c.call('POST', '/api/passkey/add/options', { name });
      if (o.status !== 200) throw new Error(`add options ${o.status} ${o.text}`);
      const r = await c.call('POST', '/api/passkey/add/verify', { response: auth.create(o.json.options) });
      if (r.status !== 201) throw new Error(`add verify ${r.status} ${r.text}`);
      return r;
    };
    c.login = async (getOpts = {}, auth = c.auth) => {
      const o = await c.call('POST', '/api/passkey/login/options');
      const response = auth.get(o.json.options, getOpts);
      const r = await c.call('POST', '/api/passkey/login/verify', { response });
      return Object.assign(r, { options: o.json.options, sent: response });
    };
    return c;
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await pool.end();
  }
  return { pool, base, origin, client, close };
}

module.exports = { startTestServer };
