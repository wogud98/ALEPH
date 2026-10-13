'use strict';
// 배포된 주소를 로그인 없이(새 시크릿 창처럼) 열어, 공개되는 것과 잠긴 것을 한 번에 점검한다.
// 실행: node scripts/check-live.js https://<배포 주소>
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('사용법: node scripts/check-live.js https://<배포 주소>');
  process.exit(2);
}

const SECRET_RE = /postgres(?:ql)?:\/\/[^\s:'"/@]+:[^\s@'"]+@|DATABASE_URL=|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\brnd_[A-Za-z0-9]{20,}|\$argon2id\$/;

let failed = 0;
const check = (id, ok, detail) => {
  console.log(`${ok ? '통과' : '실패'}  ${id}  ${detail}`);
  if (!ok) failed++;
};

async function get(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { res, text: await res.text() };
}

(async () => {
  const home = await get('/');
  check('T07-C01/C03', home.res.status === 200 && home.text.includes('id="login-form"'), `첫 화면 HTTP ${home.res.status}, 로그인 화면이 계정 없이 열림`);
  const app = await get('/app');
  check('T07-C97', app.res.status === 302 && app.res.headers.get('location') === '/login', `로그인 없이 /app → ${app.res.status} ${app.res.headers.get('location')}`);
  for (const u of ['/api/plans', '/api/plans/1', '/api/plans/1/tasks', '/api/export', '/api/experiment', '/api/auth/me']) {
    const r = await get(u);
    check('T07-C124', r.res.status === 401, `로그인 없이 ${u} → ${r.res.status} ${r.text.slice(0, 60)}`);
  }
  const csp = home.res.headers.get('content-security-policy') || '';
  check('T06-C57', /script-src 'self'/.test(csp) && !/unsafe-inline/.test(csp), `CSP: ${csp.slice(0, 60)}…`);
  const bodies = [home.text, (await get('/login.js')).text, (await get('/app.js')).text, (await get('/style.css')).text, (await get('/api/nope')).text];
  check('T07-C46/C113', !bodies.some((b) => SECRET_RE.test(b)), '공개 화면·화면 코드·응답에 비밀값 원문 없음');
  const js = bodies[1] + bodies[2];
  check('T07-C112', !/document\.cookie|localStorage|sessionStorage/.test(js), '화면 코드가 세션 값을 읽거나 주소·저장소에 싣지 않음 (HttpOnly 쿠키)');

  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('점검 중 오류:', err.message);
  process.exit(1);
});
