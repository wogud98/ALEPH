'use strict';
const http = require('node:http');
const { createPool, migrate } = require('./src/db');
const { createHandler, rpFromEnv } = require('./src/app');

async function main() {
  const pool = createPool(process.env.DATABASE_URL);
  await migrate(pool);
  const port = Number(process.env.PORT) || 3000;
  const rp = rpFromEnv();
  http.createServer(createHandler(pool, { rp })).listen(port, () => {
    console.log(`소개 페이지(T08) 서버 시작: 포트 ${port}, RP ID ${rp.rpID}, 출처 ${rp.origins.join(', ')}`);
  });
}

main().catch((err) => {
  console.error('서버를 시작하지 못했습니다:', err.message);
  process.exit(1);
});
