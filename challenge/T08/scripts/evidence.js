'use strict';
// T08 확인 기록 만들기: 실제 서버에 요청을 보내고 요청·응답을 Markdown으로 적는다. 세션·질문 표 쿠키 값은 가린다.
// 실행: node scripts/evidence.js https://<배포 주소>  > evidence.md
//   * 가상 인증기(scripts/soft-authenticator.js)로 계정 두 개(ev_a_…, ev_b_…)를 새로 만든다. 내 실제 계정은 건드리지 않는다.
//   * 비공개 항목은 모두 만들어 넣은 내용이다.
const crypto = require('node:crypto');
const { SoftAuthenticator, explainRegistration, describeCose } = require('./soft-authenticator');

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const origin = new URL(base).origin;
const rpId = new URL(base).hostname;
const tag = crypto.randomBytes(2).toString('hex');
const out = [];
const p = (s = '') => out.push(s);

const mask = (v) => (v ? `${v.slice(0, 4)}…(가림, ${v.length}자)` : v);
const maskCookies = (s) => s.replace(/(t08_(?:sid|ch)=)([A-Za-z0-9_-]{8,})/g, (m, k, v) => k + mask(v));
const short = (s, n = 16) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(${s.length}자)` : s);
function shrinkResponse(r) {
  if (!r || typeof r !== 'object') return r;
  const x = JSON.parse(JSON.stringify(r));
  for (const k of ['id', 'rawId']) if (x[k]) x[k] = short(x[k]);
  for (const k of Object.keys(x.response || {})) if (typeof x.response[k] === 'string') x.response[k] = short(x.response[k], 24);
  return x;
}

function browser(label, auth = new SoftAuthenticator({ origin, rpId, label })) {
  const c = { cookies: {}, auth, label };
  c.cookieHeader = () => Object.entries(c.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  c.call = async (method, path, body, { cookie, note, show = true, showBody } = {}) => {
    const h = {};
    if (body !== undefined) h['content-type'] = 'application/json';
    const ck = cookie !== undefined ? cookie : c.cookieHeader();
    if (ck) h.cookie = ck;
    const res = await fetch(base + path, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      if (kv.slice(i + 1)) c.cookies[kv.slice(0, i)] = kv.slice(i + 1); else delete c.cookies[kv.slice(0, i)];
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (show) {
      if (note) p(`*${note}*`);
      p('```http');
      p(`${method} ${path}`);
      if (ck) p(maskCookies(`Cookie: ${ck}`));
      if (body !== undefined) p(`\n${JSON.stringify(showBody !== undefined ? showBody : body, null, 1).slice(0, 1500)}`);
      p('```');
      p('```http');
      p(`HTTP ${res.status}`);
      for (const sc of setCookies) p(maskCookies(`Set-Cookie: ${sc}`));
      const shown = json !== undefined ? JSON.stringify(json, null, 1) : text;
      p(`\n${shown.length > 1800 ? `${shown.slice(0, 1800)}\n…(줄임)` : shown}`);
      p('```');
      p();
    }
    return { status: res.status, json, text };
  };
  return c;
}

async function signup(c, username, name) {
  const o = await c.call('POST', '/api/passkey/signup/options', { username, name }, { show: false });
  const response = c.auth.create(o.json.options);
  return c.call('POST', '/api/passkey/signup/verify', { response }, { show: false });
}
async function login(c, opts = {}, { show = true, note } = {}) {
  const o = await c.call('POST', '/api/passkey/login/options', undefined, { show: false });
  const response = (opts.auth || c.auth).get(o.json.options, opts);
  const r = await c.call('POST', '/api/passkey/login/verify', { response }, { show, note, showBody: { response: shrinkResponse(response) } });
  return Object.assign(r, { challenge: o.json.options.challenge, response, ticket: null });
}

async function main() {
  p(`# T08 확인 기록 (${new Date().toISOString()})`);
  p();
  p(`- 대상: ${base}`);
  p('- 인증기: 검사용 가상 인증기(`scripts/soft-authenticator.js`). 실제 기기와 똑같이 P-256 열쇠 쌍을 만들고 질문에 서명한다. 개인키는 스크립트 안에만 있다.');
  p(`- 계정: \`ev_a_${tag}\`, \`ev_b_${tag}\` (이번 기록용으로 새로 만듦). 비공개 항목은 모두 만들어 넣은 내용.`);
  p('- 세션 쿠키 `t08_sid`와 질문 표 쿠키 `t08_ch` 값은 앞 4자만 남기고 가렸다. 긴 base64url 값은 앞부분만 적었다.');
  p();

  const anon = browser('anon');
  const A = browser('A');
  const B = browser('B');

  // ---------- 1. 로그인 없이 ----------
  p('## 1. 로그인 없이 열기 (C15–C18)');
  p();
  const page = await anon.call('GET', '/', undefined, { show: false });
  p(`\`GET /\` → HTTP ${page.status}, 본문 ${page.text.length}자. 경계 글자 「여기까지 공개」 ${page.text.includes('여기까지 공개') ? '있음' : '없음'}, 「여기부터 비공개」 ${page.text.includes('여기부터 비공개') ? '있음' : '없음'}.`);
  p();

  // ---------- 2. 등록 ----------
  p('## 2. 패스키 등록 (C19–C26)');
  p();
  p('### 2-1. 등록 질문은 요청마다 다르다 (C19·C20)');
  p();
  const r1 = await A.call('POST', '/api/passkey/signup/options', { username: `ev_a_${tag}`, name: 'A 노트북' }, { note: '첫 번째 등록 질문' });
  const r2 = await A.call('POST', '/api/passkey/signup/options', { username: `ev_a_${tag}`, name: 'A 노트북' }, { show: false });
  const r3 = await A.call('POST', '/api/passkey/signup/options', { username: `ev_a_${tag}`, name: 'A 노트북' }, { show: false });
  p('| 요청 | challenge |');
  p('|---|---|');
  [r1, r2, r3].forEach((r, i) => p(`| ${i + 1}번째 | \`${r.json.options.challenge}\` |`));
  p();
  p(`세 값이 모두 다르다: **${new Set([r1, r2, r3].map((r) => r.json.options.challenge)).size === 3 ? '예' : '아니오'}**. 서버는 이 값을 challenges 표에 5분 동안 보관하고, 브라우저에는 그 줄을 찾을 표만 HttpOnly 쿠키로 준다.`);
  p();

  p('### 2-2. 등록을 중간에 취소하면 아무것도 남지 않는다 (C25)');
  p();
  p('위에서 질문을 세 번 받고 기기 창에서 취소했다고 치고 verify를 보내지 않았다. 계정이 생겼다면 같은 아이디로 다시 시작할 때 409가 나야 한다.');
  p();
  await A.call('POST', '/api/passkey/signup/options', { username: `ev_a_${tag}`, name: 'A 노트북' }, { note: '같은 아이디로 다시 시작 → 200 (계정이 없음)' });

  p('### 2-3. 등록 요청 본문 (C21·C23)');
  p();
  const o = await A.call('POST', '/api/passkey/signup/options', { username: `ev_a_${tag}`, name: 'A 노트북' }, { show: false });
  const regBody = { response: A.auth.create(o.json.options) };
  p('브라우저가 서버로 보내는 본문을 풀어 본 것:');
  p('```json');
  p(JSON.stringify(explainRegistration(regBody), null, 1));
  p('```');
  p(`본문 전체에 개인키(COSE \`-4\`/JWK \`d\`)가 있나: **${explainRegistration(regBody).credentialPublicKey.has_private_d ? '있음' : '없음'}**. 보낸 키 이름은 ${Object.keys(regBody.response.response).map((k) => `\`${k}\``).join(', ')} 뿐이다.`);
  p();
  const reg = await A.call('POST', '/api/passkey/signup/verify', regBody, { note: '등록 확인 (본문은 줄여 적음)', showBody: { response: shrinkResponse(regBody.response) } });

  p('### 2-4. 서버에 저장된 값 (C22·C24·C26)');
  p();
  const keys = await A.call('GET', '/api/passkeys', undefined, { show: false });
  const k0 = keys.json.passkeys[0];
  p('`GET /api/passkeys` (DB credentials 표를 그대로 읽어 돌려줌):');
  p('```json');
  p(JSON.stringify({ ...k0, public_key_cose: short(k0.public_key_cose, 40) }, null, 1));
  p('```');
  p('저장된 `public_key_cose`를 풀면:');
  p('```json');
  p(JSON.stringify(describeCose(Buffer.from(k0.public_key_cose, 'base64url')), null, 1));
  p('```');
  p('kty 2(EC2)·alg -7(ES256)·crv 1(P-256)·x·y 다섯 값만 있고 개인키 d는 없다. 이것은 **공개키**이며 비밀번호가 아니다: 누가 이 값을 가져가도 서명을 만들 수 없고, 서명을 "확인"하는 데만 쓸 수 있다.');
  p();

  // ---------- 3. 로그인 ----------
  p('## 3. 패스키로 들어가기 (C27–C35)');
  p();
  await A.call('POST', '/api/passkey/logout', undefined, { show: false });
  const l1 = await login(A, {}, { note: '성공: 저장된 공개키로 서명 확인' });
  await A.call('POST', '/api/passkey/logout', undefined, { show: false });
  const l2 = await login(A, {}, { show: false });
  await A.call('POST', '/api/passkey/logout', undefined, { show: false });
  const l3 = await login(A, { tamper: 'signature' }, { note: '실패: 서명 한 바이트를 바꿔 보냄 (C30)' });
  p('| 로그인 요청 | challenge | 결과 |');
  p('|---|---|---|');
  [l1, l2, l3].forEach((l, i) => p(`| ${i + 1}번째 | \`${l.challenge}\` | HTTP ${l.status} |`));
  p();

  p('### 3-1. 이미 쓴 질문 다시 쓰기 (C31)');
  p();
  const lo = await A.call('POST', '/api/passkey/login/options', undefined, { show: false });
  const usedTicket = A.cookies.t08_ch;
  const ans = A.auth.get(lo.json.options);
  await A.call('POST', '/api/passkey/login/verify', { response: ans }, { note: '처음 보낸 답 → 통과', showBody: { response: shrinkResponse(ans) } });
  await A.call('POST', '/api/passkey/login/verify', { response: ans }, { cookie: `t08_ch=${usedTicket}`, note: '같은 질문 표·같은 답을 그대로 다시 보냄 → 거절', showBody: { response: shrinkResponse(ans) } });
  await A.call('POST', '/api/passkey/login/options', undefined, { show: false });
  await A.call('POST', '/api/passkey/login/verify', { response: ans }, { note: '새 질문을 받은 뒤 예전 답을 보냄 → 질문이 달라 거절', showBody: { response: shrinkResponse(ans) } });

  p('### 3-2. 로그아웃 뒤 같은 세션 값 (C32·C33)');
  p();
  await login(A, {}, { show: false });
  const sid = A.cookies.t08_sid;
  await A.call('GET', '/api/me', undefined, { note: '로그인 상태: 세션 쿠키로 사람을 알아봄', show: false });
  await A.call('POST', '/api/passkey/logout', undefined, { note: '로그아웃' });
  await A.call('GET', '/api/private/items', undefined, { cookie: `t08_sid=${sid}`, note: '로그아웃 전 쿠키 값을 그대로 다시 보냄' });

  // ---------- 4. 계정 둘 ----------
  p('## 4. 계정 두 개, 서로의 자료 (C36–C41)');
  p();
  await login(A, {}, { show: false });
  await A.call('POST', '/api/private/examples', undefined, { show: false });
  await signup(B, `ev_b_${tag}`, 'B 휴대폰');
  for (const [kind, title, body] of [
    ['project', '[예시] B의 프로젝트 메모: 사진 정리 앱', '주말에 화면 두 개만 먼저. (만들어 넣은 내용)'],
    ['apply', '[예시] 가상의 회사 Z · 백엔드 인턴', '실제 회사 아님. (만들어 넣은 내용)'],
    ['retro', '[예시] B의 회고: 아침 운동 3일째', '만들어 넣은 내용'],
  ]) await B.call('POST', '/api/private/items', { kind, title, body }, { show: false });
  const aList = (await A.call('GET', '/api/private/items', undefined, { show: false })).json;
  const bList = (await B.call('GET', '/api/private/items', undefined, { show: false })).json;
  p(`- A(\`ev_a_${tag}\`) 항목 ${aList.count}개: ${aList.items.map((x) => x.title).join(' / ')}`);
  p(`- B(\`ev_b_${tag}\`) 항목 ${bList.count}개: ${bList.items.map((x) => x.title).join(' / ')}`);
  p();
  const aId = aList.items[0].id;
  const bId = bList.items[0].id;
  p('### A → B (C37)');
  p();
  await A.call('GET', `/api/private/items/${bId}`, undefined, { note: 'A로 들어가 B의 항목 번호를 직접 요청' });
  await A.call('DELETE', `/api/private/items/${bId}`, undefined, { note: 'A로 B의 항목 지우기 시도' });
  p('### B → A (C38)');
  p();
  await B.call('GET', `/api/private/items/${aId}`, undefined, { note: 'B로 들어가 A의 항목 번호를 직접 요청' });
  await B.call('DELETE', `/api/private/items/${aId}`, undefined, { note: 'B로 A의 항목 지우기 시도' });
  const aKeyId = (await A.call('GET', '/api/passkeys', undefined, { show: false })).json.passkeys[0].id;
  await B.call('DELETE', `/api/passkeys/${aKeyId}`, undefined, { note: 'B로 A의 패스키 지우기 시도' });
  p('### 주소·본문에 다른 계정을 적어 보냄 (C40)');
  p();
  await B.call('GET', `/api/private/items?username=ev_a_${tag}`, undefined, { note: 'B로 주소에 A를 적어 목록 요청 → B 것만' });
  const forged = await B.call('POST', '/api/private/items', { kind: 'retro', title: '[예시] 주인 바꾸기 시도', username: `ev_a_${tag}`, owner: `ev_a_${tag}` }, { note: 'B로 본문에 A를 주인으로 적어 만들기 → B 항목으로 생김' });
  await B.call('DELETE', `/api/private/items/${forged.json.item.id}`, undefined, { show: false });
  const aAfter = (await A.call('GET', '/api/private/items', undefined, { show: false })).json.count;
  const bAfter = (await B.call('GET', '/api/private/items', undefined, { show: false })).json.count;
  p('### 거절 앞뒤 건수 (C39)');
  p();
  p('| 계정 | 거절 전 | 거절 뒤 |');
  p('|---|---|---|');
  p(`| A | ${aList.count} | ${aAfter} |`);
  p(`| B | ${bList.count} | ${bAfter} |`);
  p();

  // ---------- 5. 남의 패스키 ----------
  p('## 5. 남의 패스키·등록 안 된 패스키로 열기');
  p();
  const stranger = new SoftAuthenticator({ origin, rpId, label: 'stranger' });
  stranger.create({ challenge: 'AAAA', user: { id: 'AAAA' } });
  const S = browser('S', stranger);
  await login(S, {}, { note: '이 사이트에 등록하지 않은 새 패스키로 들어가기' });
  const bHandle = B.auth.keys.get(B.auth.credentialIds()[0]).userHandle;
  const A2 = browser('A2', A.auth);
  await login(A2, { userHandle: bHandle }, { note: 'A의 패스키로 서명하면서 패스키 안의 사용자 핸들을 B로 바꿔 보냄' });
  await login(B, {}, { note: 'B의 패스키로 들어가면 B로만 들어감 (성공, 비교용)' });

  // ---------- 6. 두 개, 하나 지우기 ----------
  p('## 6. 패스키 두 개 → 하나 지운 뒤 (C42–C46)');
  p();
  const phone = new SoftAuthenticator({ origin, rpId, label: 'A-phone' });
  const ao = await A.call('POST', '/api/passkey/add/options', { name: 'A 휴대폰' }, { show: false });
  p(`두 번째 등록 질문의 excludeCredentials: ${ao.json.options.excludeCredentials.length}개 (이미 등록한 노트북 패스키를 알려 같은 인증기에 겹쳐 만들지 않게 함)`);
  p();
  await A.call('POST', '/api/passkey/add/verify', { response: phone.create(ao.json.options) }, { show: false });
  const two = (await A.call('GET', '/api/passkeys', undefined, { show: false })).json.passkeys;
  p('| id | 이름 | 등록한 날짜 | 저장된 곳 |');
  p('|---|---|---|---|');
  for (const k of two) p(`| ${k.id} | ${k.name} | ${k.created_at} | ${k.stored_in.place} (${k.stored_in.kind}) |`);
  p();
  await A.call('DELETE', `/api/passkeys/${two[0].id}`, undefined, { note: '노트북 패스키(잃어버린 기기라고 침) 지우기' });
  const AL = browser('A-laptop', A.auth);
  await login(AL, {}, { note: '지운 노트북 패스키로 들어가기 → 거절' });
  const AP = browser('A-phone', phone);
  await login(AP, {}, { note: '남은 휴대폰 패스키로 들어가기 → 통과' });
  await AP.call('DELETE', `/api/passkeys/${two[1].id}`, undefined, { note: '마지막 남은 패스키 지우기 → 거절 (C46)' });
  await AP.call('POST', '/api/passkey/logout', undefined, { show: false });
  await B.call('POST', '/api/passkey/logout', undefined, { show: false });
  await A.call('POST', '/api/passkey/logout', undefined, { show: false });

  // 로그인 없이 받은 페이지 소스에 위 비공개 항목이 없는지 (C18)
  const page2 = await anon.call('GET', '/', undefined, { show: false });
  const leaked = [...aList.items, ...bList.items].filter((x) => page2.text.includes(x.title));
  await anon.call('GET', '/api/private/items', undefined, { note: '로그인 없이 비공개 자료 직접 요청 (C16·C17)' });
  p(`로그인 없이 받은 \`GET /\` 본문(${page2.text.length}자)에 위 비공개 항목 제목 ${aList.count + bList.count}개 가운데 들어 있는 것: **${leaked.length}개**`);
  p();
  process.stdout.write(out.join('\n') + '\n');
}

main().catch((e) => {
  process.stdout.write(out.join('\n') + '\n');
  console.error('기록을 다 만들지 못했습니다:', e.message);
  process.exit(1);
});
