'use strict';
const http = require('node:http');
const { createPool, migrate } = require('./src/db');
const { createHandler } = require('./src/app');
const { seedIfEmpty } = require('./src/seed');

async function main() {
  const pool = createPool(process.env.DATABASE_URL);
  await migrate(pool);
  if (process.env.SEED_FILE !== 'none') await seedIfEmpty(pool, process.env.SEED_FILE);
  const port = Number(process.env.PORT) || 3000;
  http.createServer(createHandler(pool)).listen(port, () => {
    console.log(`PDS 다이어리 서버 시작: 포트 ${port}`);
  });
}

main().catch((err) => {
  console.error('서버를 시작하지 못했습니다:', err.message);
  process.exit(1);
});
