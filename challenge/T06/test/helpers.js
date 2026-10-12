'use strict';
const http = require('node:http');
const { createPool, migrate } = require('../src/db');
const { createHandler } = require('../src/app');

// 실제 PostgreSQL에 붙어 검사한다. TEST_DATABASE_URL의 public 스키마를 매번 비우므로 운영 DB를 넣지 말 것.
async function startTestServer() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL이 필요합니다 (검사용 빈 DB)');
  const pool = createPool(url);
  await pool.query('drop schema public cascade; create schema public;');
  await migrate(pool);
  const server = http.createServer(createHandler(pool, { log: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, headers: res.headers, json, text };
  }

  async function close() {
    await new Promise((r) => server.close(r));
    await pool.end();
  }
  return { pool, base, call, close };
}

function seoulToday(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

let n = 0;
const key = () => `testkey${Date.now()}${++n}`;

module.exports = { startTestServer, seoulToday, key };
