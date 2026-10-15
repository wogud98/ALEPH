'use strict';
// 복구 코드도 잃어버렸을 때, DB에 접속할 수 있는 운영자(나)가 비밀번호를 임시 비밀번호로 다시 정한다.
//   DATABASE_URL='<Render의 External Database URL>' node scripts/reset-password.js <아이디>
// 임시 비밀번호는 이 터미널에 한 번만 찍히고 어디에도 저장하지 않는다. 그 계정의 모든 로그인은 끊긴다.
// 들어간 뒤 바로 "계정 → 비밀번호 바꾸기"로 바꾸고, "복구 코드 새로 받기"로 코드를 받아 둔다.
const crypto = require('node:crypto');
const argon2 = require('argon2');
const { createPool, tx } = require('../src/db');

async function main() {
  const username = (process.argv[2] || '').trim().toLowerCase();
  if (!username) throw new Error('사용법: DATABASE_URL=... node scripts/reset-password.js <아이디>');
  let url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 환경 변수가 필요합니다');
  // Render의 External URL은 SSL이 있어야 접속된다.
  if (/render\.com/.test(url) && !/sslmode=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'sslmode=require';
  const pool = createPool(url);
  try {
    const temp = crypto.randomBytes(12).toString('base64url');
    const hash = await argon2.hash(temp, { type: argon2.argon2id });
    const out = await tx(pool, async (c) => {
      const u = await c.query('update users set password_hash = $2, password_changed_at = now() where username = $1 returning id', [username, hash]);
      if (!u.rows[0]) return null;
      const r = await c.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [u.rows[0].id]);
      return { revoked: r.rowCount };
    });
    if (!out) throw new Error(`'${username}' 아이디가 없습니다`);
    console.log(`'${username}'의 비밀번호를 임시 비밀번호로 바꿨습니다. 끊은 로그인: ${out.revoked}개`);
    console.log(`임시 비밀번호: ${temp}`);
    console.log('이 값은 다시 볼 수 없습니다. 로그인한 뒤 바로 "계정 → 비밀번호 바꾸기"로 바꾸세요.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
