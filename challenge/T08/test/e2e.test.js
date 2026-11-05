'use strict';
// 실제 브라우저(Chromium)와 크롬 개발자 도구의 가상 인증기로 화면 흐름 전체를 확인한다.
// 실행: TEST_DATABASE_URL=… npm run test:e2e   (SCREENSHOT_DIR을 주면 화면을 저장)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestServer } = require('./helpers');

let chromium;
try { ({ chromium } = require('playwright')); } catch { chromium = null; }

test('브라우저: 잠긴 자리 → 패스키 가입 → 예시 3개 → 두 번째 패스키 → 로그아웃 → 들어가기 → 하나 지우기', { skip: !chromium && 'playwright 없음' }, async () => {
  const t = await startTestServer();
  const browser = await chromium.launch();
  const shots = process.env.SCREENSHOT_DIR;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const addAuth = async () => (await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })).authenticatorId;
    const snap = async (name, opts = {}) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), ...opts }); };
    const vault = page.locator('#vault');
    const snapVault = async (name) => {
      if (!shots) return;
      await page.locator('.vault-border').scrollIntoViewIfNeeded();
      const box = await page.locator('.vault-border').boundingBox();
      const vb = await vault.boundingBox();
      await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true, clip: { x: 0, y: Math.max(0, box.y - 260 + (await page.evaluate(() => scrollY))), width: 1280, height: vb.y + vb.height - box.y + 300 } });
    };

    const laptop = await addAuth();
    await page.goto(`${t.origin}/`);
    await assert.doesNotReject(page.locator('#btn-login').waitFor());
    assert.equal(await page.locator('#vault-open').isHidden(), true);
    await snap('01-public-locked', { fullPage: true });

    // 등록 취소: 기기 창에서 취소한 것처럼 만든다
    await page.locator('.vault-signup summary').click();
    await page.evaluate(() => {
      window.__realCreate = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = () => Promise.reject(new DOMException('취소', 'NotAllowedError'));
    });
    await page.fill('#form-signup [name=username]', 'jae_owner');
    await page.fill('#form-signup [name=name]', '노트북 Chrome');
    await page.click('#form-signup button[type=submit]');
    await page.waitForFunction(() => /취소/.test(document.getElementById('vault-status').textContent));
    await snapVault('02-signup-cancelled');
    assert.equal((await t.pool.query('select count(*)::int n from users')).rows[0].n, 0);
    await page.evaluate(() => { navigator.credentials.create = window.__realCreate; });

    // 등록
    await page.click('#form-signup button[type=submit]');
    await page.locator('#vault-open').waitFor();
    await page.click('#btn-examples');
    await page.waitForFunction(() => document.querySelectorAll('#items li').length === 3);
    // 다른 기기: 가상 인증기를 바꿔 끼운다
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: laptop });
    const phone = await addAuth();
    await page.fill('#form-add [name=name]', '휴대폰');
    await page.click('#form-add button[type=submit]');
    await page.waitForFunction(() => document.querySelectorAll('#keys li').length === 2);
    await snapVault('03-open-two-passkeys');
    assert.match(await page.locator('#keys').innerText(), /노트북 Chrome[\s\S]*휴대폰/);
    assert.match(await page.locator('#keys').innerText(), /등록: /);

    // 로그아웃하면 화면에서 비공개 내용이 사라진다
    await page.click('#btn-logout');
    await page.locator('#vault-locked').waitFor();
    assert.equal(await page.locator('#items li').count(), 0);
    const html = await (await page.request.get(`${t.origin}/`)).text();
    assert.doesNotMatch(html, /가상의 회사 A/);

    // 휴대폰 패스키로 들어가기
    await page.click('#btn-login');
    await page.locator('#vault-open').waitFor();
    assert.match(await page.locator('#keys').innerText(), /휴대폰\s*지금 이 패스키로 들어옴/);

    // 노트북 패스키 지우기 (잃어버린 기기)
    page.once('dialog', (d) => d.accept());
    await page.locator('#keys li', { hasText: '노트북 Chrome' }).getByRole('button', { name: '지우기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#keys li').length === 1);
    assert.equal(await page.locator('#keys button').isDisabled(), true);
    await snapVault('04-one-left-last-locked');

    assert.deepEqual(errors.filter((e) => !/401/.test(e)), []);
  } finally {
    await browser.close();
    await t.close();
  }
});
