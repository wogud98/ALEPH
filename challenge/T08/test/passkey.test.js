'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestServer } = require('./helpers');
const { SoftAuthenticator, explainRegistration, describeCose } = require('../scripts/soft-authenticator');

let t;
test.before(async () => { t = await startTestServer(); });
test.after(async () => { await t.close(); });

const T01 = fs.readFileSync(path.join(__dirname, '..', '..', 'T01', 'index.html'), 'utf8');
const between = (s, a, b) => s.slice(s.indexOf(a) + a.length, s.indexOf(b));

test('C10·C11·C13·C18: 첫 화면은 1번 소개 페이지 그대로 + 경계 + 잠긴 자리, 소스에 비공개 내용 없음', async () => {
  const a = t.client('a');
  await a.signup('owner_a');
  await a.call('POST', '/api/private/items', { kind: 'retro', title: '비밀회고-XYZ', body: '아무도 몰라야 하는 문장-QQQ' });

  const anon = t.client('anon');
  const r = await anon.call('GET', '/');
  assert.equal(r.status, 200);
  // 1번 <main> 안 내용이 한 글자도 바뀌지 않고 들어 있다.
  const t01Main = between(T01, '<main class="page">', '</main>');
  assert.ok(r.text.includes(t01Main));
  assert.ok(r.text.includes(between(T01, '<style>', '</style>')));
  assert.match(r.text, /여기까지 공개/);
  assert.match(r.text, /여기부터 비공개/);
  assert.doesNotMatch(r.text, /비밀회고-XYZ|QQQ/);
  // 같은 주인이 로그인해도 HTML은 같다 (비공개 내용은 API로만 나간다).
  const r2 = await a.call('GET', '/');
  assert.equal(r2.text, r.text);
  assert.doesNotMatch((await anon.call('GET', '/vault.js')).text, /비밀회고-XYZ/);
  // 비밀번호 입력칸 없음 (C35)
  assert.doesNotMatch(r.text, /type="password"/i);
  // 인라인 스크립트는 1번 원본 것만 해시로 허락
  assert.match(r.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
});

test('C15·C16·C17: 로그인 없이 비공개 자료 요청은 401', async () => {
  const anon = t.client('anon2');
  for (const p of ['/api/private/items', '/api/private/items/1', '/api/me', '/api/passkeys']) {
    const r = await anon.call('GET', p);
    assert.equal(r.status, 401, p);
    assert.doesNotMatch(r.text, /비밀회고/);
  }
  assert.equal((await anon.call('POST', '/api/private/items', { kind: 'retro', title: 'x' })).status, 401);
  assert.equal((await anon.call('POST', '/api/passkey/add/options', {})).status, 401);
  // 쿠키를 지어내도 401
  assert.equal((await anon.call('GET', '/api/private/items', undefined, { cookie: `t08_sid=${'A'.repeat(43)}` })).status, 401);
});

test('C19·C20·C21·C22·C23·C24: 등록 질문은 매번 다르고 서버에 보관되며, 저장되는 것은 공개키와 이름', async () => {
  const c = t.client('b');
  const o1 = await c.call('POST', '/api/passkey/signup/options', { username: 'reg_b', name: '내 휴대폰' });
  const o2 = await c.call('POST', '/api/passkey/signup/options', { username: 'reg_b', name: '내 휴대폰' });
  assert.equal(o1.status, 200);
  assert.notEqual(o1.json.options.challenge, o2.json.options.challenge);
  assert.equal(o1.json.options.challenge.length, 43); // 32바이트
  const stored = await t.pool.query('select challenge, used_at from challenges where challenge = any($1)', [[o1.json.options.challenge, o2.json.options.challenge]]);
  assert.equal(stored.rows.length, 2);
  assert.match(o2.headers.get('set-cookie'), /t08_ch=[^;]+; Path=\/api\/passkey; HttpOnly; SameSite=Strict; Max-Age=300/);

  const response = c.auth.create(o2.json.options);
  const body = { response };
  const ex = explainRegistration(body);
  assert.equal(ex.credentialPublicKey.has_private_d, false);
  assert.ok(!JSON.stringify(body).includes('"d"'));
  const r = await c.call('POST', '/api/passkey/signup/verify', body);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.passkey.name, '내 휴대폰');
  assert.equal(r.json.passkey.stored_in.place, '검사용 가상 인증기');

  const row = (await t.pool.query('select * from credentials where credential_id = $1', [response.id])).rows[0];
  const cose = describeCose(new Uint8Array(row.public_key));
  assert.equal(cose.kty, 2);
  assert.equal(cose.alg, -7);
  assert.equal(cose.has_private_d, false);
  // users 표에 비밀번호 칼럼 자체가 없다.
  const cols = (await t.pool.query("select column_name from information_schema.columns where table_schema = 't08' and table_name = 'users'")).rows.map((x) => x.column_name);
  assert.ok(!cols.some((x) => /pass/.test(x)));
  // 한 번 쓴 등록 질문은 다시 못 쓴다
  const again = await c.call('POST', '/api/passkey/signup/verify', body, { cookie: `t08_ch=${'B'.repeat(43)}` });
  assert.equal(again.status, 400);
});

test('C25: 등록을 중간에 취소하면(verify를 안 보냄) 아무것도 저장되지 않음', async () => {
  const c = t.client('cancel');
  const before = (await t.pool.query('select (select count(*) from users)::int u, (select count(*) from credentials)::int c')).rows[0];
  const o = await c.call('POST', '/api/passkey/signup/options', { username: 'cancel_me' });
  assert.equal(o.status, 200);
  const after = (await t.pool.query('select (select count(*) from users)::int u, (select count(*) from credentials)::int c')).rows[0];
  assert.deepEqual(after, before);
  // 같은 아이디로 다시 시작할 수 있다 = 계정이 생기지 않았다
  assert.equal((await c.call('POST', '/api/passkey/signup/options', { username: 'cancel_me' })).status, 200);
});

test('C27–C31: 로그인 질문은 매번 새것, 서명을 공개키로 확인, 틀린 서명·이미 쓴 질문은 거절', async () => {
  const c = t.client('login');
  await c.signup('login_c');
  await c.call('POST', '/api/passkey/logout');

  const ok = await c.login();
  assert.equal(ok.status, 200, ok.text);
  const ticket = c.cookies.t08_ch; // 성공하면 지워진다
  assert.equal(ticket, undefined);
  const ok2 = await c.login();
  assert.equal(ok2.status, 200);
  assert.notEqual(ok.options.challenge, ok2.options.challenge);

  const badSig = await c.login({ tamper: 'signature' });
  assert.equal(badSig.status, 401);
  assert.match(badSig.json.error, /서명/);

  // 이미 쓴 질문(같은 표)으로 같은 답을 다시 보냄
  const o = await c.call('POST', '/api/passkey/login/options');
  const saved = c.cookies.t08_ch;
  const resp = c.auth.get(o.json.options);
  assert.equal((await c.call('POST', '/api/passkey/login/verify', { response: resp })).status, 200);
  const replay = await c.call('POST', '/api/passkey/login/verify', { response: resp }, { cookie: `t08_ch=${saved}` });
  assert.equal(replay.status, 401);
  assert.match(replay.json.error, /이미 쓰였/);
  // 새 질문을 받고도 예전 답(예전 질문에 대한 서명)을 보냄
  await c.call('POST', '/api/passkey/login/options');
  const replay2 = await c.call('POST', '/api/passkey/login/verify', { response: resp });
  assert.equal(replay2.status, 401);
  // 틀린 서명으로 실패한 질문도 다시 쓸 수 없다
  const o3 = await c.call('POST', '/api/passkey/login/options');
  const t3 = c.cookies.t08_ch;
  assert.equal((await c.call('POST', '/api/passkey/login/verify', { response: c.auth.get(o3.json.options, { tamper: 'signature' }) })).status, 401);
  const r3 = await c.call('POST', '/api/passkey/login/verify', { response: c.auth.get(o3.json.options) }, { cookie: `t08_ch=${t3}` });
  assert.equal(r3.status, 401);
  assert.match(r3.json.error, /이미 쓰였/);
});

test('C32·C33: 세션 쿠키로 알아보고, 로그아웃 뒤 같은 쿠키는 401', async () => {
  const c = t.client('lo');
  const s = await c.signup('logout_d');
  assert.match(s.headers.get('set-cookie'), /t08_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict/);
  const old = c.cookies.t08_sid;
  assert.equal((await c.call('GET', '/api/private/items')).status, 200);
  const out = await c.call('POST', '/api/passkey/logout');
  assert.equal(out.status, 200);
  assert.equal(out.json.revoked_sessions, 1);
  const r = await c.call('GET', '/api/private/items', undefined, { cookie: `t08_sid=${old}` });
  assert.equal(r.status, 401);
});

test('C36–C41: 계정 둘, 서로의 자료는 404, 주소·본문에 남의 계정을 적어도 내 것만', async () => {
  const a = t.client('xa');
  const b = t.client('xb');
  await a.signup('cross_a');
  await b.signup('cross_b');
  await a.call('POST', '/api/private/examples');
  const bItem = (await b.call('POST', '/api/private/items', { kind: 'apply', title: 'B만의 지원 목록' })).json.item;
  const aItems = (await a.call('GET', '/api/private/items')).json;
  assert.equal(aItems.count, 3);
  const aId = aItems.items[0].id;
  const aUser = (await t.pool.query("select id from users where username = 'cross_a'")).rows[0].id;

  assert.equal((await b.call('GET', `/api/private/items/${aId}`)).status, 404);
  assert.equal((await b.call('DELETE', `/api/private/items/${aId}`)).status, 404);
  assert.equal((await a.call('GET', `/api/private/items/${bItem.id}`)).status, 404);
  assert.equal((await a.call('DELETE', `/api/private/items/${bItem.id}`)).status, 404);
  assert.equal((await a.call('GET', '/api/private/items')).json.count, 3);
  assert.equal((await b.call('GET', '/api/private/items')).json.count, 1);

  const q = await b.call('GET', `/api/private/items?user_id=${aUser}&username=cross_a`);
  assert.deepEqual(q.json.items.map((x) => x.title), ['B만의 지원 목록']);
  const p = await b.call('POST', '/api/private/items', { kind: 'retro', title: '주인 바꾸기 시도', user_id: aUser, username: 'cross_a' });
  assert.equal(p.status, 201);
  assert.equal((await a.call('GET', '/api/private/items')).json.count, 3);
  assert.equal((await b.call('GET', '/api/private/items')).json.count, 2);
  // 남의 패스키 지우기·이름 바꾸기도 404
  const aKey = (await a.call('GET', '/api/passkeys')).json.passkeys[0].id;
  assert.equal((await b.call('DELETE', `/api/passkeys/${aKey}`)).status, 404);
  assert.equal((await b.call('PATCH', `/api/passkeys/${aKey}`, { name: '뺏기' })).status, 404);
});

test('남의 패스키·등록 안 된 패스키·사용자 핸들 바꿔치기로는 열리지 않음', async () => {
  const a = t.client('oa');
  const b = t.client('ob');
  await a.signup('other_a');
  await b.signup('other_b');
  await b.call('POST', '/api/private/items', { kind: 'retro', title: 'B의 회고' });
  // 등록하지 않은 새 인증기
  const stranger = new SoftAuthenticator({ origin: t.origin, rpId: 'localhost' });
  stranger.create({ challenge: 'x', user: { id: 'AAAA' } });
  const r1 = await a.login({}, stranger);
  assert.equal(r1.status, 401);
  assert.match(r1.json.error, /등록되지 않은/);
  // A의 패스키로 서명하면서 B의 사용자 핸들을 적음
  const bHandle = b.auth.keys.get(b.auth.credentialIds()[0]).userHandle;
  const r2 = await a.login({ userHandle: bHandle });
  assert.equal(r2.status, 401);
  // A의 공개키 ID를 대고 B 인증기의 서명을 보냄 → 공개키가 맞지 않음
  const o = await a.call('POST', '/api/passkey/login/options');
  const forged = b.auth.get(o.json.options);
  forged.id = forged.rawId = a.auth.credentialIds()[0];
  forged.response.userHandle = a.auth.keys.get(a.auth.credentialIds()[0]).userHandle;
  const r3 = await a.call('POST', '/api/passkey/login/verify', { response: forged });
  assert.equal(r3.status, 401);
  // A로 들어가도 보이는 건 A 자료뿐
  await a.call('POST', '/api/passkey/logout');
  assert.equal((await a.login()).status, 200);
  assert.equal((await a.call('GET', '/api/private/items')).json.count, 0);
});

test('C42–C46: 패스키 두 개, 하나 지운 뒤 남은 것으로 들어가고 지운 것은 거절, 마지막 하나는 못 지움', async () => {
  const c = t.client('two');
  await c.signup('two_keys', '노트북 Chrome');
  // 같은 인증기로 또 만들려 하면 excludeCredentials 때문에 막힌다
  const ex = await c.call('POST', '/api/passkey/add/options', { name: 'x' });
  assert.equal(ex.json.options.excludeCredentials.length, 1);
  assert.throws(() => c.auth.create(ex.json.options), /이미/);
  // 다른 기기(다른 인증기)에서 등록
  const phone = new SoftAuthenticator({ origin: t.origin, rpId: 'localhost' });
  await c.add('휴대폰', phone);
  const list = (await c.call('GET', '/api/passkeys')).json.passkeys;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((k) => k.name), ['노트북 Chrome', '휴대폰']);
  assert.ok(list.every((k) => k.created_at && k.public_key_cose));

  // 지금 세션은 노트북 패스키로 연 것 → 노트북 패스키를 지우면 이 세션도 끊긴다
  const del = await c.call('DELETE', `/api/passkeys/${list[0].id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.remaining, 1);
  assert.equal(del.json.logged_out, true);
  assert.equal((await c.call('GET', '/api/me')).status, 401);

  const gone = await c.login({}, c.auth); // 지운 노트북 패스키
  assert.equal(gone.status, 401);
  assert.match(gone.json.error, /등록되지 않은/);
  const okPhone = await c.login({}, phone);
  assert.equal(okPhone.status, 200);
  const last = await c.call('DELETE', `/api/passkeys/${list[1].id}`);
  assert.equal(last.status, 409);
  assert.match(last.json.error, /마지막 패스키/);
  assert.equal((await c.call('GET', '/api/passkeys')).json.passkeys.length, 1);
});

test('다른 계정에서 받은 추가 질문은 쓸 수 없음 · 다른 사이트 Origin 거절 · 출처가 다른 응답 거절', async () => {
  const a = t.client('ga');
  const b = t.client('gb');
  await a.signup('guard_a');
  await b.signup('guard_b');
  const o = await a.call('POST', '/api/passkey/add/options', {});
  const resp = new SoftAuthenticator({ origin: t.origin, rpId: 'localhost' }).create(o.json.options);
  const r = await b.call('POST', '/api/passkey/add/verify', { response: resp }, { cookie: `${b.cookieHeader()}; t08_ch=${a.cookies.t08_ch}` });
  assert.equal(r.status, 403);
  assert.equal((await a.call('POST', '/api/private/items', { kind: 'retro', title: 'x' }, { origin: 'https://evil.example' })).status, 403);
  // 가짜 사이트(다른 출처)에서 받은 서명
  const evil = new SoftAuthenticator({ origin: 'https://evil.example', rpId: 'localhost' });
  const o2 = await a.call('POST', '/api/passkey/add/options', {});
  const r2 = await a.call('POST', '/api/passkey/add/verify', { response: evil.create(o2.json.options) });
  assert.equal(r2.status, 400);
});

test('질문은 5분이 지나면 못 씀', async () => {
  const c = t.client('exp');
  await c.signup('expire_e');
  const o = await c.call('POST', '/api/passkey/login/options');
  await t.pool.query("update challenges set expires_at = now() - interval '1 second' where challenge = $1", [o.json.options.challenge]);
  const r = await c.call('POST', '/api/passkey/login/verify', { response: c.auth.get(o.json.options) });
  assert.equal(r.status, 401);
  assert.match(r.json.error, /유효 시간/);
});
