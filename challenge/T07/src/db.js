'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');

// date 칼럼은 JS Date로 바꾸지 않고 'YYYY-MM-DD' 문자열 그대로 둔다 (시간대 때문에 하루 밀리는 일 방지).
types.setTypeParser(1082, (v) => v);
// bigint(id, count)는 안전 범위 안이므로 숫자로 돌려준다.
types.setTypeParser(20, (v) => Number(v));

// T07은 T06과 같은 PostgreSQL을 쓰되, 표는 별도 스키마(t07)에 둔다.
// T06 서버(public 스키마)는 T07의 표를 볼 수 없고, T07 서버는 T06 표를 옮겨 올 때만 public.* 으로 읽는다.
const SCHEMA = process.env.DB_SCHEMA || 't07';
if (!/^[a-z_][a-z0-9_]{0,30}$/.test(SCHEMA) || SCHEMA === 'public') throw new Error('DB_SCHEMA는 public이 아닌 소문자 이름이어야 합니다');

function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL 환경 변수가 필요합니다');
  const needsSsl = /sslmode=require/.test(connectionString) || process.env.PGSSL === 'require';
  return new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    // 모든 접속의 기본 스키마를 t07 하나로 고정한다 (public을 넣지 않아 T06 표를 실수로 읽지 않는다).
    options: `-c search_path=${SCHEMA}`,
  });
}

async function migrate(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    // 여러 인스턴스가 동시에 시작해도 한 번에 하나만 스키마를 적용한다.
    await client.query('select pg_advisory_lock(7070707)');
    await client.query(`create schema if not exists ${SCHEMA}`);
    await client.query(sql);
  } finally {
    await client.query('select pg_advisory_unlock(7070707)').catch(() => {});
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

module.exports = { createPool, migrate, tx, SCHEMA };
