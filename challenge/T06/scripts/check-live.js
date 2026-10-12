'use strict';
// 배포된 주소를 로그인 없이 열어 핵심 통과 기준을 한 번에 점검한다.
// 실행: node scripts/check-live.js https://<배포 주소>
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('사용법: node scripts/check-live.js https://<배포 주소>');
  process.exit(2);
}

const NOTICE = '지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요';
const SECRET_RE = /postgres(?:ql)?:\/\/[^\s:'"/@]+:[^\s@'"]+@|DATABASE_URL|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\brnd_[A-Za-z0-9]{20,}/;

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
  check('T06-C01', home.res.status === 200, `첫 화면 HTTP ${home.res.status} (로그인·리디렉션 없이 열림)`);
  check('T06-C82', home.text.includes(NOTICE), '첫 화면 공개 안내 문장');
  const csp = home.res.headers.get('content-security-policy') || '';
  check('T06-C57', /script-src 'self'/.test(csp) && !/unsafe-inline/.test(csp), `CSP: ${csp.slice(0, 60)}…`);

  const plans = JSON.parse((await get('/api/plans')).text);
  check('T06-C78', plans.length >= 1, `계획 ${plans.length}개`);
  let best = null;
  for (const p of plans) {
    const tasks = JSON.parse((await get(`/api/plans/${p.id}/tasks`)).text).tasks;
    const logs = tasks.reduce((s, t) => s + t.logs.length, 0);
    if (!best || tasks.length > best.tasks) best = { plan: p, tasks: tasks.length, logs };
  }
  if (best) {
    check('T06-C79', best.tasks >= 5, `계획 #${best.plan.id}의 할 일 ${best.tasks}개`);
    check('T06-C80', best.logs >= 3, `계획 #${best.plan.id}의 실행 기록 ${best.logs}개`);
    const r = JSON.parse((await get(`/api/plans/${best.plan.id}/review`)).text);
    const nums = [r.planned, r.done, r.delayed, r.blocked, r.estimated_minutes, r.actual_minutes];
    check('T06-C81', nums.some((n) => n !== 0), `돌아보기 계획 ${r.planned} · 완료 ${r.done} · 지연 ${r.delayed} · 막힘 ${r.blocked} · 예상 ${r.estimated_minutes}분 · 실제 ${r.actual_minutes}분 · 차이 ${r.diff_minutes}분`);
    let evOk = true;
    for (const m of ['planned', 'done', 'delayed', 'blocked']) {
      const ev = JSON.parse((await get(`/api/plans/${best.plan.id}/review/evidence?metric=${m}`)).text);
      if (ev.tasks.length !== r[m]) evOk = false;
    }
    check('T06-C83', evOk, '집계 숫자와 근거 목록 개수가 같음');
  }

  const exp = await get('/api/export');
  check('T06-C36', exp.res.status === 200 && /attachment/.test(exp.res.headers.get('content-disposition') || ''), `내보내기 ${exp.res.headers.get('content-disposition')}`);

  const bodies = [home.text, (await get('/app.js')).text, (await get('/style.css')).text, exp.text, (await get('/api/meta')).text, (await get('/api/nope')).text];
  check('T06-C58', !bodies.some((b) => SECRET_RE.test(b)), '화면 코드·API 응답에 비밀값 원문 없음');

  console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('점검 중 오류:', err.message);
  process.exit(1);
});
