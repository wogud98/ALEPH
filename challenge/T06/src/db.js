'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');

// date 칼럼은 JS Date로 바꾸지 않고 'YYYY-MM-DD' 문자열 그대로 둔다 (시간대 때문에 하루 밀리는 일 방지).
types.setTypeParser(1082, (v) => v);
// bigint(id, count)는 안전 범위 안이므로 숫자로 돌려준다.
types.setTypeParser(20, (v) => Number(v));

function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL 환경 변수가 필요합니다');
  const needsSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === 'require';
  return new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
}

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    // 여러 인스턴스가 동시에 시작해도 한 번에 하나만 스키마를 적용한다.
    await client.query('select pg_advisory_lock(6060606)');
    await client.query(sql);
  } finally {
    await client.query('select pg_advisory_unlock(6060606)').catch(() => {});
    client.release();
  }
}

async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, migrate, tx };
