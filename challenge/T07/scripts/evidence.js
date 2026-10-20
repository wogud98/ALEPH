'use strict';
// 인증 구현 설명서 ④ "안 열리는 것을 확인한 기록"을 만드는 스크립트.
// 실제 서버에 HTTP로 요청을 보내고, 요청과 응답을 나란히 Markdown으로 적는다. 비밀번호·세션 값은 가려서 적는다.
//
// 실행: node scripts/evidence.js https://<배포 주소> > evidence.md
//       DATABASE_URL=... 을 함께 주면 DB에 저장된 비밀번호 해시도 읽어 적는다 (②용).
//       --keep 을 주지 않으면 끝에 검사용 계정 두 개를 지운다.
//
// 검사용 계정 두 개(check_a_xxxx, check_b_xxxx)를 새로 만들고, 비밀번호는 매번 무작위로 만들어 어디에도 적지 않는다.
const crypto = require('node:crypto');

const base = (process.argv[2] || '').replace(/\/+$/, '');
const keep = process.argv.includes('--keep');
if (!/^https?:\/\//.test(base)) {
  console.error('사용법: node scripts/evidence.js https://<배포 주소> [--keep]');
  process.exit(2);
}

const tag = crypto.randomBytes(2).toString('hex');
const PW = `pw-${crypto.randomBytes(12).toString('base64url')}`; // 두 계정이 같은 비밀번호를 쓴다 (② 같은 비밀번호 → 다른 해시)
const raw = []; // 받은 응답 원문 전체 (비밀번호 원문 검사용)
const out = [];
const w = (s = '') => out.push(s);

const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' KST';
const maskTok = (t) => (t ? `${t.slice(0, 4)}…(가림)` : t);
function maskText(s) {
  return String(s)
    .split(PW).join('********')
    .replace(/pds_sid=([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{39}/g, 'pds_sid=$1…(가림)')
    .replace(/"recovery_code":"([A-Z0-9]{5})(-[A-Z0-9]{5}){3}"/g, '"recovery_code":"$1-…(가림)"');
}

function browser(name) {
  return { name, cookie: '' };
}

// 요청 한 번: 보낸 것과 받은 것을 기록용 문자열로 돌려준다
async function req(b, method, path, body, extraHeaders = {}, { cookie } = {}) {
  const headers = { ...extraHeaders };
  const useCookie = cookie !== undefined ? cookie : b && b.cookie;
  if (useCookie) headers.cookie = useCookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const setCookie = res.headers.get('set-cookie');
  raw.push(`${res.status} ${JSON.stringify([...res.headers])} ${text}`);
  if (b && setCookie) {
    const v = setCookie.split(';')[0];
    b.cookie = v.endsWith('=') ? '' : v;
  }
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const reqLines = [`${method} ${path}`];
  for (const [k, v] of Object.entries(headers)) if (k !== 'content-type') reqLines.push(`${k}: ${maskText(v)}`);
  if (body !== undefined) reqLines.push('', maskText(JSON.stringify(body)));
  const resLines = [`HTTP ${res.status}`];
  if (res.headers.get('location')) resLines.push(`location: ${res.headers.get('location')}`);
  if (setCookie) resLines.push(`set-cookie: ${maskText(setCookie)}`);
  let shown = text;
  if (res.headers.get('content-type')?.startsWith('text/html')) shown = `(HTML ${text.length}자: ${/<title>(.*?)<\/title>/.exec(text)?.[1] || ''})`;
  else if (shown.length > 600) shown = `${shown.slice(0, 600)}…(이하 생략, 전체 ${text.length}자)`;
  resLines.push('', maskText(shown));
  return { status: res.status, json, text, at: kst(), reqText: reqLines.join('\n'), resText: resLines.join('\n') };
}

function pair(title, ok, okLabel, bad, badLabel) {
  w(`**${title}**`);
  w();
  w(`| ${okLabel} | ${badLabel} |`);
  w('|---|---|');
  const cell = (r) => `<pre>${(`[${r.at}]\n` + r.reqText + '\n\n→ ' + r.resText).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\|/g, '&#124;').replace(/\n/g, '<br>')}</pre>`;
  w(`| ${cell(ok)} | ${cell(bad)} |`);
  w();
}

function one(title, r) {
  w(`**${title}**`);
  w();
  w('```http');
  w(`[${r.at}]`);
  w(r.reqText);
  w('```');
  w('```http');
  w(r.resText);
  w('```');
  w();
}

async function counts(b) {
  const plans = (await req(b, 'GET', '/api/plans')).json;
  let tasks = 0; let logs = 0; const titles = [];
  for (const p of plans) {
    const t = (await req(b, 'GET', `/api/plans/${p.id}/tasks`)).json.tasks;
    tasks += t.length;
    logs += t.reduce((s, x) => s + x.logs.length, 0);
    titles.push(...t.map((x) => `${x.title}|${x.status}`));
  }
  return { plans: plans.length, tasks, logs, plan_titles: plans.map((p) => p.title), task_sig: titles.join(',') };
}

async function fill(b, label) {
  const plan = (await req(b, 'POST', '/api/plans', {
    title: `${label}의 계획`, start_date: '2026-10-13', end_date: '2026-10-17', priority: 2, success_criteria: '검사용', estimated_minutes: 60,
  })).json;
  const task = (await req(b, 'POST', `/api/plans/${plan.id}/tasks`, { title: `${label}의 할 일`, estimated_minutes: 30 })).json;
  const task2 = (await req(b, 'POST', `/api/plans/${plan.id}/tasks`, { title: `${label}의 두 번째 할 일`, estimated_minutes: 20 })).json;
  const log = (await req(b, 'POST', `/api/tasks/${task.id}/logs`, {
    idempotency_key: crypto.randomUUID().replace(/-/g, ''), started_at: '2026-10-13T09:00:00+09:00', ended_at: '2026-10-13T09:40:00+09:00',
  })).json.log;
  return { plan, task, task2, log };
}

(async () => {
  const health = await fetch(`${base}/healthz`).then((r) => r.status).catch(() => 0);
  if (health !== 200) {
    console.error(`서버가 응답하지 않습니다 (${base}/healthz → ${health}). 잠든 무료 서버라면 1분 뒤 다시 실행하세요.`);
    process.exit(1);
  }
  const A = browser('A');
  const B = browser('B');
  const ua = `check_a_${tag}`;
  const ub = `check_b_${tag}`;

  w(`# ④ 안 열리는 것을 확인한 기록`);
  w();
  w(`- 대상: ${base}`);
  w(`- 만든 시각: ${kst()} · 만든 방법: \`node scripts/evidence.js ${base}\``);
  w(`- 검사용 계정 두 개: \`${ua}\`(A), \`${ub}\`(B). 비밀번호는 실행할 때마다 무작위로 만들고 여기 적지 않는다(요청 본문에서 \`********\`로 가림).`);
  w('- 세션 값(쿠키 `pds_sid`)은 앞 4글자만 남기고 가렸다. 같은 값인지 알아볼 수 있도록 앞 4글자는 남긴다.');
  w();

  // ---------- 1. 로그인 없이 자료 화면 ----------
  w('## 1. 로그인하지 않고 자료 화면을 열면 로그인 화면이 나온다 (C97, C03)');
  w();
  const anon = browser('anon');
  const home = await req(anon, 'GET', '/');
  const appAnon = await req(anon, 'GET', '/app');
  const sA = await req(A, 'POST', '/api/auth/signup', { username: ua, password: PW });
  const sB = await req(B, 'POST', '/api/auth/signup', { username: ub, password: PW });
  const appA = await req(A, 'GET', '/app');
  pair('같은 주소 GET /app: 로그인한 A는 자료 화면, 쿠키 없는 브라우저는 /login으로', appA, '성공 (A 로그인 상태)', appAnon, '거절 (쿠키 없음 → 302 /login)');
  one('첫 화면 GET / (쿠키 없음): 로그인 화면 HTML이 바로 열린다', home);
  one('가입 (A). 응답 본문에 비밀번호·세션 값이 없고, 세션 값은 HttpOnly 쿠키로만 온다', sA);

  // ---------- 2. 가입·로그인 실패 문구, 비밀번호 저장 ----------
  w('## 2. 비밀번호는 원문으로 남지 않는다 (C98, C99, C101~C107)');
  w();
  const dup = await req(browser('x'), 'POST', '/api/auth/signup', { username: ua.toUpperCase(), password: PW });
  pair('같은 아이디로 두 번 가입 (대문자로 바꿔도)', sB, '성공 (B 새 아이디)', dup, '거절 (A와 같은 아이디)');
  const loginOk = await req(browser('y'), 'POST', '/api/auth/login', { username: ua, password: PW });
  const loginBadPw = await req(browser('y'), 'POST', '/api/auth/login', { username: ua, password: `${PW}-wrong` });
  const loginNoUser = await req(browser('y'), 'POST', '/api/auth/login', { username: `nobody_${tag}`, password: PW });
  pair('로그인: 맞는 비밀번호 vs 틀린 비밀번호', loginOk, '성공', loginBadPw, '거절 (아이디는 맞고 비밀번호만 틀림)');
  one('로그인: 아이디 자체가 없음 → 위 "비밀번호만 틀림"과 상태·문구가 똑같다', loginNoUser);
  if (process.env.DATABASE_URL) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: /sslmode=require|render\.com/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined });
    await c.connect();
    const schema = process.env.DB_SCHEMA || 't07';
    const { rows } = await c.query(`select username, password_hash from ${schema}.users where username = any($1) order by username`, [[ua, ub]]);
    await c.end();
    w('**DB에 저장된 모습** (`select username, password_hash from t07.users`) — A와 B는 같은 비밀번호로 가입했다');
    w();
    w('```');
    for (const r of rows) w(`${r.username} | ${r.password_hash}`);
    w('```');
    w();
    const salts = rows.map((r) => r.password_hash.split('$')[4]);
    w(`- 두 값 모두 \`$argon2id$\`로 시작하고 입력한 글자가 들어 있지 않다: ${rows.every((r) => r.password_hash.startsWith('$argon2id$') && !r.password_hash.includes(PW)) ? '확인' : '실패'}`);
    w(`- 같은 비밀번호인데 저장 값이 다르다: ${rows.length === 2 && rows[0].password_hash !== rows[1].password_hash ? '확인' : '실패'} (소금값 \`${salts[0]}\` / \`${salts[1]}\`)`);
    w();
  } else {
    w('_(DB 해시 확인은 DATABASE_URL을 주고 실행했을 때만 적힌다)_');
    w();
  }

  // ---------- 3. 로그아웃 뒤 같은 값 ----------
  w('## 3. 로그아웃하면 같은 세션 값으로 다시 요청해도 거절된다 (C108~C115)');
  w();
  const L = browser('L');
  await req(L, 'POST', '/api/auth/login', { username: ua, password: PW });
  const saved = L.cookie;
  const before = await req(L, 'GET', '/api/plans', undefined, {}, { cookie: saved });
  const lo = await req(L, 'POST', '/api/auth/logout', undefined, {}, { cookie: saved });
  const afterLo = await req(L, 'GET', '/api/plans', undefined, {}, { cookie: saved });
  pair('같은 주소(GET /api/plans)·같은 쿠키 값. 달라진 것은 가운데의 로그아웃 한 번뿐', before, '로그인 상태 → 성공', afterLo, '로그아웃 뒤 같은 값 → 거절');
  one('가운데에 보낸 로그아웃 요청 (서버 DB의 세션에 revoked_at을 적고, 브라우저 쿠키도 지운다)', lo);
  const me = await req(A, 'GET', '/api/auth/me');
  one('만료 시각: 로그인한 뒤 7일 (쿠키 Max-Age=604800, 서버 DB expires_at도 같은 시각)', me);
  // 비밀번호 변경 → 이전 값 거절
  const P1 = browser('P1');
  await req(P1, 'POST', '/api/auth/login', { username: ub, password: PW });
  const oldB = P1.cookie;
  const NEWPW = `pw-${crypto.randomBytes(12).toString('base64url')}`;
  const okOld = await req(P1, 'GET', '/api/plans', undefined, {}, { cookie: oldB });
  const chg = await req(B, 'POST', '/api/account/password', { current_password: PW, new_password: NEWPW });
  const badOld = await req(P1, 'GET', '/api/plans', undefined, {}, { cookie: oldB });
  pair('비밀번호를 바꾸면 다른 브라우저에 발급했던 값도 끊긴다 (같은 주소·같은 값)', okOld, '바꾸기 전 → 성공', badOld, '바꾼 뒤 → 거절');
  one('가운데에 보낸 비밀번호 바꾸기 요청 (B가 가입한 다른 브라우저에서). 새 비밀번호도 가렸다', { ...chg, reqText: chg.reqText.split(NEWPW).join('********') });

  // ---------- 4. 남의 자료 읽기·수정·삭제 ----------
  w('## 4. 남의 자료는 읽기·수정·삭제가 양방향으로 모두 거절된다 (C116~C122, C126)');
  w();
  const a = await fill(A, 'A');
  const b = await fill(B, 'B');
  w(`- A에 계획 1개·할 일 2개·실행 기록 1개, B에 계획 1개·할 일 2개·실행 기록 1개를 넣었다. A의 계획 #${a.plan.id}·할 일 #${a.task.id}·실행 기록 #${a.log.id}, B의 계획 #${b.plan.id}·할 일 #${b.task.id}·실행 기록 #${b.log.id}.`);
  w();
  for (const [me2, myName, mine, theirs, other, otherName] of [[A, 'A', a, b, B, 'B'], [B, 'B', b, a, A, 'A']]) {
    const cBefore = await counts(other);
    w(`### ${myName} → ${otherName}`);
    w();
    w(`거절 전 ${otherName}의 자료 (${otherName}로 로그인해 센 값): 계획 ${cBefore.plans}개 · 할 일 ${cBefore.tasks}개 · 실행 기록 ${cBefore.logs}개`);
    w();
    pair(`읽기: 같은 모양의 주소, 내 것 vs ${otherName}의 것`,
      await req(me2, 'GET', `/api/plans/${mine.plan.id}`), `내 계획 #${mine.plan.id}`,
      await req(me2, 'GET', `/api/plans/${theirs.plan.id}`), `${otherName}의 계획 #${theirs.plan.id}`);
    pair('수정: 할 일 이름 바꾸기',
      await req(me2, 'PATCH', `/api/tasks/${mine.task2.id}`, { title: `${myName}의 두 번째 할 일(고침)` }), `내 할 일 #${mine.task2.id}`,
      await req(me2, 'PATCH', `/api/tasks/${theirs.task.id}`, { title: '바꿔치기' }), `${otherName}의 할 일 #${theirs.task.id}`);
    pair('삭제: 할 일 지우기',
      await req(me2, 'DELETE', `/api/tasks/${mine.task2.id}`), `내 할 일 #${mine.task2.id}`,
      await req(me2, 'DELETE', `/api/tasks/${theirs.task.id}`), `${otherName}의 할 일 #${theirs.task.id}`);
    const extra = [
      await req(me2, 'PUT', `/api/plans/${theirs.plan.id}`, { title: '바꿔치기', change_reason: '검사' }),
      await req(me2, 'DELETE', `/api/logs/${theirs.log.id}`),
      await req(me2, 'POST', `/api/tasks/${theirs.task.id}/complete`, { idempotency_key: crypto.randomUUID().replace(/-/g, '') }),
      await req(me2, 'POST', `/api/plans/${theirs.plan.id}/tasks`, { title: '끼워넣기' }),
      await req(me2, 'GET', `/api/plans/${theirs.plan.id}/tasks`),
    ];
    w(`그 밖에 ${otherName}의 자료에 보낸 요청: ${extra.map((r) => `\`${r.reqText.split('\n')[0]}\` → ${r.status}`).join(' · ')}`);
    w();
    const cAfter = await counts(other);
    const same = JSON.stringify(cBefore) === JSON.stringify(cAfter);
    w(`거절 뒤 ${otherName}의 자료: 계획 ${cAfter.plans}개 · 할 일 ${cAfter.tasks}개 · 실행 기록 ${cAfter.logs}개 — 이름·상태까지 거절 전과 ${same ? '같다 (새로 생긴 것도, 바뀐 것도 없다)' : '다르다 (실패)'}`);
    w();
  }

  // ---------- 5. 다른 계정 적어 보내기 · 로그인 없이 · 목록 ----------
  w('## 5. 주소·헤더·본문에 남의 계정을 적어도, 로그인하지 않아도, 목록에도 남의 자료는 나오지 않는다 (C123~C125)');
  w();
  const listOk = await req(A, 'GET', '/api/plans');
  const listForged = await req(A, 'GET', `/api/plans?username=${ub}&owner=${ub}`, undefined, { 'x-username': ub, 'x-user': ub });
  pair('목록: 그냥 부른 것 vs 주소·헤더에 B를 적은 것 → 둘 다 A의 것만', listOk, 'A 그냥', listForged, 'A가 주소·헤더에 B를 적음');
  const forgedCreate = await req(A, 'POST', '/api/plans', {
    title: 'A가 B 이름을 적어 만든 계획', start_date: '2026-10-13', end_date: '2026-10-13', priority: 3, success_criteria: '검사', estimated_minutes: 0, owner: ub, username: ub,
  });
  const bList = await req(B, 'GET', '/api/plans');
  pair('본문에 owner·username으로 B를 적어 만든 계획은 A의 것이 되고, B의 목록에는 없다', forgedCreate, 'A가 본문에 B를 적어 만들기', bList, 'B의 목록 (A가 만든 계획 없음)');
  const anonList = await req(browser('anon2'), 'GET', '/api/plans');
  const anonOne = await req(browser('anon3'), 'GET', `/api/plans/${a.plan.id}/tasks`);
  pair('로그인하지 않고 자료를 직접 요청', listOk, 'A 로그인 → 성공', anonList, '쿠키 없음 → 거절');
  one('로그인하지 않고 A의 할 일 목록 주소를 직접 요청', anonOne);
  const ids = new Set([b.plan.id]);
  const aPlans = listOk.json || [];
  w(`- A의 목록 응답에 B의 계획 ID(#${b.plan.id})가 ${aPlans.some((p) => ids.has(p.id)) ? '있다 (실패)' : '하나도 없다'}. A의 내보내기 파일에 "B의" 글자가 ${(await req(A, 'GET', '/api/export')).text.includes('B의') ? '있다 (실패)' : '없다'}.`);
  w();

  // ---------- 정리 ----------
  const leaked = raw.filter((r) => r.includes(PW) || r.includes(NEWPW)).length;
  w('## 이 기록에 대한 자동 확인');
  w();
  w(`- 받은 응답 ${raw.length}개(상태·헤더·본문 전체) 가운데 비밀번호 원문이 들어 있는 것: ${leaked}개`);
  w(`- 이 문서에 세션 값 원문(43자)이 그대로 들어 있는 곳: ${out.join('\n').match(/pds_sid=[A-Za-z0-9_-]{43}/g)?.length || 0}곳`);
  if (!keep) {
    const d1 = await req(A, 'DELETE', '/api/account', { password: PW });
    const d2 = await req(B, 'DELETE', '/api/account', { password: NEWPW });
    w(`- 끝나고 검사용 계정 두 개를 지웠다 (DELETE /api/account → ${d1.status}, ${d2.status}). 계정과 함께 위에서 넣은 자료도 지워졌다.`);
  }
  w();
  console.log(out.join('\n'));
})().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
