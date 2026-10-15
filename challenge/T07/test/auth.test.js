'use strict';
// T07 카드 1~4, 5(내보내기·계정 삭제) 통과 기준별 검사. 실행: TEST_DATABASE_URL=... node --test test/auth.test.js
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Client } = require('pg');
const { startTestServer, key, testPassword } = require('./helpers');
const { createHandler } = require('../src/app');

let S;
before(async () => { S = await startTestServer({ resetPublic: true }); });
after(async () => { await S.close(); });

const PLAN = {
  title: '내 계획', start_date: '2026-10-13', end_date: '2026-10-17', priority: 2, success_criteria: '기준', estimated_minutes: 60,
};

// 계정 하나에 계획·할 일·실행 기록·돌아보기를 넣는다
async function fill(c, label) {
  const plan = (await c.call('POST', '/api/plans', { ...PLAN, title: `${label}의 계획` })).json;
  const task = (await c.call('POST', `/api/plans/${plan.id}/tasks`, { title: `${label}의 할 일`, estimated_minutes: 30 })).json;
  const log = (await c.call('POST', `/api/tasks/${task.id}/logs`, {
    idempotency_key: key(), started_at: '2026-10-13T09:00:00+09:00', ended_at: '2026-10-13T09:40:00+09:00',
  })).json.log;
  const retro = (await c.call('POST', `/api/plans/${plan.id}/retros`, { improvement: `${label}의 고칠 점` })).json;
  return { plan, task, log, retro };
}

async function countsOf(username) {
  const { rows } = await S.pool.query(
    `select (select count(*) from plans p join users u on u.id = p.owner_id where u.username = $1)::int as plans,
            (select count(*) from tasks t join plans p on p.id = t.plan_id join users u on u.id = p.owner_id where u.username = $1 and t.deleted_at is null)::int as tasks,
            (select count(*) from work_logs w join tasks t on t.id = w.task_id join plans p on p.id = t.plan_id join users u on u.id = p.owner_id where u.username = $1)::int as logs,
            (select count(*) from retrospectives r join plans p on p.id = r.plan_id join users u on u.id = p.owner_id where u.username = $1)::int as retros,
            (select max(p.updated_at) from plans p join users u on u.id = p.owner_id where u.username = $1) as plan_updated,
            (select string_agg(t.title || '|' || t.status, ',') from tasks t join plans p on p.id = t.plan_id join users u on u.id = p.owner_id where u.username = $1) as task_sig`,
    [username],
  );
  return rows[0];
}

describe('카드 1 — 가입·로그인·로그아웃', () => {
  test('T07-C94~C96 가입하면 바로 로그인되고, 로그인·로그아웃할 수 있다', async () => {
    const c = S.client();
    const r = await c.signup('card1_user');
    assert.equal(r.json.user.username, 'card1_user');
    assert.equal((await c.call('GET', '/api/auth/me')).status, 200);
    assert.equal((await c.call('POST', '/api/auth/logout')).status, 200);
    assert.equal(c.cookie, '', '로그아웃 응답이 쿠키를 지운다');
    assert.equal((await c.call('GET', '/api/auth/me')).status, 401);
    const l = await c.call('POST', '/api/auth/login', { username: 'card1_user', password: c.password });
    assert.equal(l.status, 200, l.text);
    assert.equal((await c.call('GET', '/api/auth/me')).status, 200);
  });

  test('T07-C97 로그인 없이 자료 화면(/app)을 열면 로그인 화면으로 가고, 첫 화면(/)은 로그인 화면이다', async () => {
    const anon = S.client();
    const app = await anon.call('GET', '/app');
    assert.equal(app.status, 302);
    assert.equal(app.headers.get('location'), '/login');
    const home = await anon.call('GET', '/');
    assert.equal(home.status, 200);
    assert.ok(home.text.includes('id="login-form"'));
    assert.ok(!home.text.includes('내 계획'));
    const login = await anon.call('GET', '/login');
    assert.equal(login.status, 200);
    // 로그인한 사람은 /app에서 자료 화면을 받는다
    assert.equal((await S.call('GET', '/app')).status, 200);
  });

  test('T07-C98 같은 아이디로 두 번 가입되지 않는다 (대소문자만 바꿔도)', async () => {
    const a = S.client();
    await a.signup('dup_user');
    const b = S.client();
    const r = await b.call('POST', '/api/auth/signup', { username: 'DUP_user', password: testPassword() });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, '이미 쓰이는 아이디입니다');
    const n = (await S.pool.query(`select count(*)::int n from users where username = 'dup_user'`)).rows[0].n;
    assert.equal(n, 1);
  });

  test('T07-C99 비밀번호만 틀렸을 때와 아이디가 없을 때 응답이 같다', async () => {
    const a = S.client();
    await a.signup('c99_user');
    const wrongPw = await S.client().call('POST', '/api/auth/login', { username: 'c99_user', password: testPassword() });
    const noUser = await S.client().call('POST', '/api/auth/login', { username: 'c99_nobody', password: testPassword() });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.equal(wrongPw.text, noUser.text);
    assert.equal(wrongPw.json.error, '아이디 또는 비밀번호가 맞지 않습니다');
  });

  test('입력 검증: 짧은 비밀번호·이상한 아이디는 가입되지 않는다', async () => {
    const c = S.client();
    assert.equal((await c.call('POST', '/api/auth/signup', { username: 'short_pw', password: 'abc' })).status, 400);
    assert.equal((await c.call('POST', '/api/auth/signup', { username: 'a b', password: testPassword() })).status, 400);
  });
});

describe('카드 2 — 비밀번호 보관', () => {
  test('T07-C101~C104 argon2id로 저장되고, 원문이 보이지 않으며, 같은 비밀번호라도 저장 값이 다르다', async () => {
    const pw = testPassword();
    const a = S.client();
    await a.signup('same_pw_a', pw);
    const b = S.client();
    await b.signup('same_pw_b', pw);
    const { rows } = await S.pool.query(`select username, password_hash from users where username in ('same_pw_a','same_pw_b') order by username`);
    for (const r of rows) {
      assert.match(r.password_hash, /^\$argon2id\$v=19\$m=65536,p=4,t=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
      assert.ok(!r.password_hash.includes(pw));
    }
    assert.notEqual(rows[0].password_hash, rows[1].password_hash);
    const salt = (h) => h.split('$')[4];
    assert.notEqual(salt(rows[0].password_hash), salt(rows[1].password_hash), '소금값이 계정마다 다르다');
  });

  test('T07-C105, C106 로그인 응답·쿠키·서버 로그·DB 어디에도 비밀번호 원문이 없다', async () => {
    const logged = [];
    const srv = http.createServer(createHandler(S.pool, { log: { error: (...a) => logged.push(a.join(' ')) } }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const pw = testPassword();
    const post = (u, body) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const responses = [];
    for (const [u, body] of [
      ['/api/auth/signup', { username: 'c105_user', password: pw }],
      ['/api/auth/login', { username: 'c105_user', password: pw }],
      ['/api/auth/login', { username: 'c105_user', password: `${pw}x` }],
      ['/api/auth/signup', { username: 'c105_user', password: pw }],
    ]) {
      const res = await post(u, body);
      responses.push(`${res.status} ${JSON.stringify([...res.headers])} ${await res.text()}`);
    }
    await new Promise((r) => srv.close(r));
    for (const r of responses) assert.ok(!r.includes(pw), r);
    for (const l of logged) assert.ok(!l.includes(pw), l);
    const dump = (await S.pool.query(`select row_to_json(u)::text t from users u`)).rows.map((r) => r.t).join('\n');
    assert.ok(!dump.includes(pw));
  });

  test('T07-C107 비밀번호는 널리 쓰이는 argon2 라이브러리가 다룬다', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.argon2, '0.45.1');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth.js'), 'utf8');
    assert.match(src, /require\('argon2'\)/);
  });
});

describe('카드 3 — 세션', () => {
  test('T07-C109, C110 같은 주소·같은 쿠키로: 로그인 상태 200, 로그아웃 뒤 401', async () => {
    const c = S.client();
    await c.signup('c109_user');
    const cookie = c.cookie;
    const before = await c.call('GET', '/api/plans', undefined, { cookie });
    await c.call('POST', '/api/auth/logout');
    const afterRes = await c.call('GET', '/api/plans', undefined, { cookie });
    assert.equal(before.status, 200);
    assert.equal(afterRes.status, 401);
    assert.equal(afterRes.json.error, '로그인이 필요합니다');
    const row = (await S.pool.query(
      `select revoked_at from sessions s join users u on u.id = s.user_id where u.username = 'c109_user'`,
    )).rows[0];
    assert.ok(row.revoked_at, '서버 DB에서도 세션이 끊겼다');
  });

  test('T07-C111 세션은 7일 뒤 만료되고, 만료된 값은 거절된다', async () => {
    const c = S.client();
    const r = await c.signup('c111_user');
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /Max-Age=604800/);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    const s = (await S.pool.query(
      `select extract(epoch from s.expires_at - s.created_at)::int as secs from sessions s join users u on u.id = s.user_id where u.username = 'c111_user'`,
    )).rows[0];
    assert.ok(Math.abs(s.secs - 7 * 24 * 3600) <= 5, String(s.secs));
    await S.pool.query(`update sessions set expires_at = now() - interval '1 second' where user_id = (select id from users where username = 'c111_user')`);
    assert.equal((await c.call('GET', '/api/plans')).status, 401);
  });

  test('T07-C112 세션 값은 쿠키로만 오가고 응답 본문·주소에 실리지 않는다', async () => {
    const c = S.client();
    const r = await c.signup('c112_user');
    const token = c.cookie.split('=')[1];
    assert.equal(token.length, 43);
    assert.ok(!r.text.includes(token));
    assert.ok(!r.headers.get('location'));
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'public', 'login.js'), 'utf8');
    assert.doesNotMatch(js, /document\.cookie|localStorage|sessionStorage|[?&](token|sid)=/);
    // 주소에 세션 값을 실어 보내도 받지 않는다
    const anon = S.client();
    assert.equal((await anon.call('GET', `/api/plans?pds_sid=${token}`)).status, 401);
  });

  test('T07-C113 DB에는 세션 토큰 원문 대신 SHA-256 값만 있다 (서명용 비밀키가 없다)', async () => {
    const c = S.client();
    await c.signup('c113_user');
    const token = c.cookie.split('=')[1];
    const { rows } = await S.pool.query(`select encode(token_hash, 'hex') h from sessions s join users u on u.id = s.user_id where u.username = 'c113_user'`);
    const expected = require('node:crypto').createHash('sha256').update(token).digest('hex');
    assert.equal(rows[0].h, expected);
    const dump = (await S.pool.query(`select row_to_json(s)::text t from sessions s`)).rows.map((r) => r.t).join('\n');
    assert.ok(!dump.includes(token));
  });

  test('T07-C114 비밀번호를 바꾸면 이전에 발급한 값(다른 브라우저 포함)이 모두 끊긴다', async () => {
    const a = S.client();
    await a.signup('c114_user');
    const other = S.client();
    await other.call('POST', '/api/auth/login', { username: 'c114_user', password: a.password });
    const oldCookie = a.cookie;
    const newPw = testPassword();
    const r = await a.call('POST', '/api/account/password', { current_password: a.password, new_password: newPw });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.revoked_sessions, 2);
    assert.equal((await a.call('GET', '/api/plans', undefined, { cookie: oldCookie })).status, 401, '이전 값');
    assert.equal((await other.call('GET', '/api/plans')).status, 401, '다른 브라우저');
    assert.equal((await a.call('GET', '/api/plans')).status, 200, '바꾼 브라우저는 새 값');
    assert.equal((await S.client().call('POST', '/api/auth/login', { username: 'c114_user', password: a.password })).status, 401);
    assert.equal((await S.client().call('POST', '/api/auth/login', { username: 'c114_user', password: newPw })).status, 200);
    const wrong = await a.call('POST', '/api/account/password', { current_password: testPassword(), new_password: testPassword() });
    assert.equal(wrong.status, 403);
  });

  test('같은 아이디로 15분 안에 10번 틀리면 잠시 막는다 (있는 아이디·없는 아이디 똑같이)', async () => {
    for (const u of ['throttle_nobody']) {
      const c = S.client();
      for (let i = 0; i < 10; i++) assert.equal((await c.call('POST', '/api/auth/login', { username: u, password: testPassword() })).status, 401);
      assert.equal((await c.call('POST', '/api/auth/login', { username: u, password: testPassword() })).status, 429);
    }
  });

  test('다른 사이트(Origin)에서 보낸 바꾸는 요청은 403', async () => {
    const r = await S.call('POST', '/api/plans', PLAN, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });
});

describe('카드 4 — 남의 자료', () => {
  let A; let B; let a; let b;
  before(async () => {
    A = S.client(); await A.signup('iso_a'); a = await fill(A, 'A');
    B = S.client(); await B.signup('iso_b'); b = await fill(B, 'B');
  });

  for (const [who, other] of [['A→B', () => [A, b, 'iso_b']], ['B→A', () => [B, a, 'iso_a']]]) {
    test(`T07-C117~C122 ${who}: 읽기·수정·삭제 모두 404, 반대편 건수·내용 그대로`, async () => {
      const [me, theirs, theirName] = other();
      const beforeCounts = await countsOf(theirName);
      const reqs = [
        ['GET', `/api/plans/${theirs.plan.id}`],
        ['GET', `/api/plans/${theirs.plan.id}/tasks`],
        ['GET', `/api/plans/${theirs.plan.id}/review`],
        ['GET', `/api/plans/${theirs.plan.id}/retros`],
        ['PUT', `/api/plans/${theirs.plan.id}`, { title: '바꿔치기', change_reason: 'x' }],
        ['PATCH', `/api/tasks/${theirs.task.id}`, { title: '바꿔치기' }],
        ['POST', `/api/tasks/${theirs.task.id}/complete`, { idempotency_key: key() }],
        ['POST', `/api/tasks/${theirs.task.id}/reopen`],
        ['POST', `/api/tasks/${theirs.task.id}/logs`, { idempotency_key: key(), started_at: '2026-10-13T10:00:00+09:00', ended_at: '2026-10-13T10:10:00+09:00' }],
        ['POST', `/api/plans/${theirs.plan.id}/tasks`, { title: '끼워넣기' }],
        ['POST', `/api/plans/${theirs.plan.id}/retros`, { improvement: '끼워넣기' }],
        ['POST', '/api/plans', { ...PLAN, carried_from_retro_id: theirs.retro.id }],
        ['DELETE', `/api/tasks/${theirs.task.id}`],
        ['DELETE', `/api/logs/${theirs.log.id}`],
      ];
      for (const [m, u, body] of reqs) {
        const r = await me.call(m, u, body);
        assert.equal(r.status, 404, `${m} ${u} ${r.text}`);
      }
      const afterCounts = await countsOf(theirName);
      assert.deepEqual(afterCounts, beforeCounts);
    });
  }

  test('T07-C123 주소·헤더·본문에 다른 계정을 적어도 내 자료만 돌아온다', async () => {
    const bId = (await S.pool.query(`select id from users where username = 'iso_b'`)).rows[0].id;
    const list = await A.call('GET', `/api/plans?owner_id=${bId}&user=iso_b`, undefined, { 'x-user-id': String(bId), 'x-username': 'iso_b' });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.map((p) => p.title), ['A의 계획']);
    const created = await A.call('POST', '/api/plans', { ...PLAN, title: 'A가 B 이름으로 만든 계획', owner_id: bId, username: 'iso_b' }, { 'x-user-id': String(bId) });
    assert.equal(created.status, 201);
    const owner = (await S.pool.query(`select u.username from plans p join users u on u.id = p.owner_id where p.id = $1`, [created.json.id])).rows[0].username;
    assert.equal(owner, 'iso_a');
    await S.pool.query('delete from plans where id = $1', [created.json.id]);
  });

  test('T07-C124 로그인하지 않고 자료를 직접 요청하면 401', async () => {
    const anon = S.client();
    for (const u of ['/api/plans', `/api/plans/${a.plan.id}`, `/api/plans/${a.plan.id}/tasks`, '/api/export', '/api/experiment']) {
      const r = await anon.call('GET', u);
      assert.equal(r.status, 401, u);
      assert.deepEqual(r.json, { error: '로그인이 필요합니다' });
    }
    const w = await anon.call('DELETE', `/api/tasks/${a.task.id}`);
    assert.equal(w.status, 401);
  });

  test('T07-C125 목록 응답에 다른 계정의 자료가 하나도 없다', async () => {
    const bIds = new Set([b.plan.id]);
    const plans = (await A.call('GET', '/api/plans')).json;
    assert.ok(plans.every((p) => !bIds.has(p.id)));
    const exp = JSON.parse((await A.call('GET', '/api/export')).text);
    const text = JSON.stringify(exp);
    assert.ok(!text.includes('B의'), '내보내기에도 B의 글자가 없다');
    assert.ok(exp.plans.every((p) => p.id !== b.plan.id));
    assert.ok(exp.tasks.every((t) => t.id !== b.task.id));
    assert.ok(exp.work_logs.every((l) => l.id !== b.log.id));
  });
});

describe('카드 5 — 내보내기·계정 지우기', () => {
  test('T07-C133 내 자료 전체를 파일 하나(JSON)로 받는다 (비밀번호 해시·세션 없이)', async () => {
    const c = S.client();
    await c.signup('export_user');
    await fill(c, 'E');
    const r = await c.call('GET', '/api/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="pds-export-export_user-\d{4}-\d{2}-\d{2}\.json"/);
    const data = JSON.parse(r.text);
    assert.equal(data.account.username, 'export_user');
    assert.equal(data.plans.length, 1);
    assert.ok('experiment' in data);
    assert.doesNotMatch(r.text, /argon2|password|token_hash|pds_sid/);
  });

  test('T07-C134 계정을 지우면 내 자료가 모두 함께 지워진다 (다른 계정은 그대로)', async () => {
    const c = S.client();
    await c.signup('bye_user');
    await fill(c, 'Z');
    const otherBefore = await countsOf('iso_a');
    const wrong = await c.call('DELETE', '/api/account', { password: testPassword() });
    assert.equal(wrong.status, 403);
    const r = await c.call('DELETE', '/api/account', { password: c.password });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.removed, { plans: 1, tasks: 1 });
    const left = await countsOf('bye_user');
    assert.equal(left.plans + left.tasks + left.logs + left.retros, 0);
    assert.equal((await S.pool.query(`select count(*)::int n from users where username = 'bye_user'`)).rows[0].n, 0);
    const orphan = (await S.pool.query(`select count(*)::int n from work_logs w left join tasks t on t.id = w.task_id where t.id is null`)).rows[0].n;
    assert.equal(orphan, 0);
    assert.equal((await c.call('GET', '/api/plans')).status, 401);
    assert.deepEqual(await countsOf('iso_a'), otherBefore);
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(page.includes('계정을 지우면 내 계획·할 일·실행 기록·돌아보기·5일 기록이 모두 함께 지워지고 되돌릴 수 없습니다'));
  });
});

describe('비밀번호 찾기 (복구 코드)', () => {
  test('가입 응답에 복구 코드가 한 번 나오고, DB에는 argon2id 해시만 있다', async () => {
    const c = S.client();
    const r = await c.signup('rc_user');
    assert.match(r.json.recovery_code, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const row = (await S.pool.query(`select recovery_hash from users where username = 'rc_user'`)).rows[0];
    assert.match(row.recovery_hash, /^\$argon2id\$/);
    assert.ok(!row.recovery_hash.includes(r.json.recovery_code.replace(/-/g, '')));
    assert.equal((await c.call('GET', '/api/auth/me')).json.has_recovery_code, true);
    assert.equal((await c.call('GET', '/api/auth/me')).json.recovery_code, undefined, '로그인 뒤에는 다시 보여 주지 않는다');
  });

  test('아이디 + 복구 코드로 새 비밀번호를 정하면 이전 로그인이 모두 끊기고, 코드는 한 번만 쓰인다', async () => {
    const a = S.client();
    const code = (await a.signup('rc_reset')).json.recovery_code;
    const other = S.client();
    await other.call('POST', '/api/auth/login', { username: 'rc_reset', password: a.password });
    const b = S.client();
    const newPw = testPassword();
    // 소문자·하이픈 빼고 넣어도 같은 코드로 본다
    const r = await b.call('POST', '/api/auth/reset', { username: 'rc_reset', recovery_code: code.toLowerCase().replace(/-/g, ' '), new_password: newPw });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.revoked_sessions, 2);
    assert.match(r.json.recovery_code, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    assert.notEqual(r.json.recovery_code, code);
    assert.ok(!JSON.stringify(r.json).includes(newPw));
    assert.equal((await a.call('GET', '/api/plans')).status, 401, '예전 브라우저 1');
    assert.equal((await other.call('GET', '/api/plans')).status, 401, '예전 브라우저 2');
    assert.equal((await b.call('GET', '/api/plans')).status, 200, '찾은 브라우저는 로그인됨');
    assert.equal((await S.client().call('POST', '/api/auth/login', { username: 'rc_reset', password: a.password })).status, 401);
    assert.equal((await S.client().call('POST', '/api/auth/login', { username: 'rc_reset', password: newPw })).status, 200);
    const again = await S.client().call('POST', '/api/auth/reset', { username: 'rc_reset', recovery_code: code, new_password: testPassword() });
    assert.equal(again.status, 401, '쓴 코드는 다시 못 쓴다');
  });

  test('틀린 코드·없는 아이디·남의 코드는 같은 401, 10번 틀리면 429', async () => {
    const a = S.client();
    const codeA = (await a.signup('rc_a')).json.recovery_code;
    await S.client().signup('rc_b');
    const wrong = await S.client().call('POST', '/api/auth/reset', { username: 'rc_b', recovery_code: codeA, new_password: testPassword() });
    const nobody = await S.client().call('POST', '/api/auth/reset', { username: 'rc_nobody', recovery_code: codeA, new_password: testPassword() });
    assert.equal(wrong.status, 401);
    assert.equal(nobody.status, 401);
    assert.equal(wrong.json.error, nobody.json.error);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const c = S.client();
    for (let i = 0; i < 9; i++) {
      assert.equal((await c.call('POST', '/api/auth/reset', { username: 'rc_b', recovery_code: 'AAAAA-AAAAA-AAAAA-AAAAA', new_password: testPassword() })).status, 401);
    }
    assert.equal((await c.call('POST', '/api/auth/reset', { username: 'rc_b', recovery_code: 'AAAAA-AAAAA-AAAAA-AAAAA', new_password: testPassword() })).status, 429);
    const short = await S.client().call('POST', '/api/auth/reset', { username: 'rc_a', recovery_code: codeA, new_password: 'short' });
    assert.equal(short.status, 400);
  });

  test('로그인한 사람은 지금 비밀번호를 확인받고 복구 코드를 새로 받는다 (예전 코드는 못 쓴다)', async () => {
    const a = S.client();
    const old = (await a.signup('rc_renew')).json.recovery_code;
    assert.equal((await a.call('POST', '/api/account/recovery-code', { password: testPassword() })).status, 403);
    assert.equal((await S.client().call('POST', '/api/account/recovery-code', { password: a.password })).status, 401, '로그인 없이');
    const r = await a.call('POST', '/api/account/recovery-code', { password: a.password });
    assert.equal(r.status, 200, r.text);
    assert.notEqual(r.json.recovery_code, old);
    assert.equal((await S.client().call('POST', '/api/auth/reset', { username: 'rc_renew', recovery_code: old, new_password: testPassword() })).status, 401);
    assert.equal((await S.client().call('POST', '/api/auth/reset', { username: 'rc_renew', recovery_code: r.json.recovery_code, new_password: testPassword() })).status, 200);
  });

  test('복구 코드가 없는 예전 계정은 찾기로 바뀌지 않고, 화면에 받아 두라고 알린다', async () => {
    const a = S.client();
    const code = (await a.signup('rc_legacy')).json.recovery_code;
    await S.pool.query(`update users set recovery_hash = null where username = 'rc_legacy'`);
    assert.equal((await a.call('GET', '/api/auth/me')).json.has_recovery_code, false);
    assert.equal((await S.client().call('POST', '/api/auth/reset', { username: 'rc_legacy', recovery_code: code, new_password: testPassword() })).status, 401);
  });
});

describe('T07-C100 T06 자료 옮기기', () => {
  test('T06_OWNER_USERNAME 계정이 처음 로그인할 때 public(T06) 자료가 그 계정으로 한 번만 옮겨진다', async () => {
    // 같은 DB의 public 스키마에 T06 스키마와 자료를 만든다 (T06 서버가 쓰던 모양 그대로)
    const pg = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await pg.connect();
    await pg.query('set search_path to public');
    await pg.query(fs.readFileSync(path.join(__dirname, '..', '..', 'T06', 'db', 'schema.sql'), 'utf8'));
    const p = (await pg.query(`insert into plans (title, start_date, end_date, priority, success_criteria, estimated_minutes)
      values ('T06 운동 계획', '2026-10-12', '2026-10-18', 1, '주 3회', 180) returning id`)).rows[0].id;
    await pg.query(`insert into plan_revisions (plan_id, revision_no, title, start_date, end_date, priority, success_criteria, estimated_minutes, change_reason)
      values ($1, 1, 'T06 운동 계획', '2026-10-12', '2026-10-18', 1, '주 3회', 180, '처음 세운 계획')`, [p]);
    const t = (await pg.query(`insert into tasks (plan_id, title, status, completed_at) values ($1, '하체', 'done', now()) returning id`, [p])).rows[0].id;
    await pg.query(`insert into task_completions (task_id, idempotency_key) values ($1, 'k-t06-complete-1')`, [t]);
    await pg.query(`insert into work_logs (task_id, started_at, ended_at, actual_minutes, idempotency_key)
      values ($1, '2026-10-12T20:00:00+09:00', '2026-10-12T20:50:00+09:00', 50, 'k-t06-log-1')`, [t]);
    await pg.query(`insert into retrospectives (plan_id, snapshot, improvement) values ($1, '{}', '아침에 하기')`, [p]);
    await pg.end();

    process.env.T06_OWNER_USERNAME = 'jaeri';
    try {
      const stranger = S.client();
      await stranger.signup('not_owner');
      assert.deepEqual((await stranger.call('GET', '/api/plans')).json, [], '주인이 아닌 계정에는 옮기지 않는다');

      const owner = S.client();
      const r = await owner.signup('jaeri');
      assert.deepEqual(r.json.t06_import, { plans: 1, plan_revisions: 1, tasks: 1, task_completions: 1, work_logs: 1, retrospectives: 1 });
      const plans = (await owner.call('GET', '/api/plans')).json;
      assert.deepEqual(plans.map((x) => x.title), ['T06 운동 계획']);
      const tasks = (await owner.call('GET', `/api/plans/${plans[0].id}/tasks`)).json.tasks;
      assert.equal(tasks[0].title, '하체');
      assert.equal(tasks[0].status, 'done');
      assert.equal(tasks[0].logs[0].actual_minutes, 50);
      const me = (await owner.call('GET', '/api/auth/me')).json;
      assert.equal(me.t06_import.counts.plans, 1);

      // 다시 로그인해도 두 번 옮기지 않는다. T06 표는 그대로 남는다.
      await owner.call('POST', '/api/auth/logout');
      await owner.call('POST', '/api/auth/login', { username: 'jaeri', password: owner.password });
      assert.equal((await owner.call('GET', '/api/plans')).json.length, 1);
      assert.equal((await S.pool.query('select count(*)::int n from public.plans')).rows[0].n, 1);
      assert.deepEqual((await stranger.call('GET', '/api/plans')).json, []);
    } finally {
      delete process.env.T06_OWNER_USERNAME;
    }
  });
});
