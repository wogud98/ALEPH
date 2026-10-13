'use strict';
const http = require('node:http');
const { createPool, migrate } = require('./src/db');
const { createHandler } = require('./src/app');

async function main() {
  const pool = createPool(process.env.DATABASE_URL);
  await migrate(pool);
  const port = Number(process.env.PORT) || 3000;
  http.createServer(createHandler(pool)).listen(port, () => {
    console.log(`PDS 다이어리(T07) 서버 시작: 포트 ${port}`);
  });
}

main().catch((err) => {
  console.error('서버를 시작하지 못했습니다:', err.message);
  process.exit(1);
});
