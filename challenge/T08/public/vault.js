'use strict';
// 나만 보는 자리 화면. 비공개 내용은 이 파일에 없고, 패스키로 들어온 뒤 /api/private/items 로 받아 그린다.
(function () {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('vault-status');
  function say(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'vault-status' + (kind ? ' ' + kind : '');
  }

  // ---------- base64url <-> ArrayBuffer ----------
  function b64uToBuf(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function bufToB64u(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // 서버가 보낸 JSON 옵션을 브라우저 API가 받는 모양으로 바꾼다.
  function toCreateOptions(o) {
    if (window.PublicKeyCredential && PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
    return Object.assign({}, o, {
      challenge: b64uToBuf(o.challenge),
      user: Object.assign({}, o.user, { id: b64uToBuf(o.user.id) }),
      excludeCredentials: (o.excludeCredentials || []).map((c) => Object.assign({}, c, { id: b64uToBuf(c.id) })),
    });
  }
  function toGetOptions(o) {
    if (window.PublicKeyCredential && PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
    return Object.assign({}, o, {
      challenge: b64uToBuf(o.challenge),
      allowCredentials: (o.allowCredentials || []).map((c) => Object.assign({}, c, { id: b64uToBuf(c.id) })),
    });
  }
  // 기기가 돌려준 값을 서버로 보낼 JSON으로 바꾼다. 여기에는 공개키·서명·질문이 든 clientDataJSON만 있고 개인키는 없다.
  function credToJSON(c) {
    const r = c.response;
    const out = {
      id: c.id, rawId: bufToB64u(c.rawId), type: c.type,
      clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {},
      authenticatorAttachment: c.authenticatorAttachment || undefined,
      response: { clientDataJSON: bufToB64u(r.clientDataJSON) },
    };
    if (r.attestationObject) {
      out.response.attestationObject = bufToB64u(r.attestationObject);
      out.response.transports = r.getTransports ? r.getTransports() : [];
    } else {
      out.response.authenticatorData = bufToB64u(r.authenticatorData);
      out.response.signature = bufToB64u(r.signature);
      out.response.userHandle = r.userHandle ? bufToB64u(r.userHandle) : undefined;
    }
    return out;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error(data.error || ('요청 실패 ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function supported() {
    if (!window.isSecureContext) { say('이 주소에서는 패스키를 쓸 수 없어요. https 주소로 열어 주세요 (개발 중에는 localhost만 예외).', 'err'); return false; }
    if (!window.PublicKeyCredential || !navigator.credentials) { say('이 브라우저는 패스키를 지원하지 않아요. 최신 Chrome·Safari·Edge에서 열어 주세요.', 'err'); return false; }
    return true;
  }

  // 기기 창에서 취소하거나 시간이 지나면 NotAllowedError가 난다. 서버에는 확인 요청을 보내지 않으므로 아무것도 저장되지 않는다.
  function deviceError(e, what) {
    if (e && e.name === 'NotAllowedError') return what + '을(를) 취소했거나 시간이 지났어요. 서버에는 아무것도 저장되지 않았습니다.';
    if (e && e.name === 'InvalidStateError') return '이 기기(또는 이 비밀번호 관리자)에는 이미 이 계정의 패스키가 있어요. 다른 기기·다른 브라우저·보안 키에서 등록해 보세요.';
    if (e && e.name === 'SecurityError') return '이 주소에서는 패스키를 만들 수 없어요 (https와 사이트 주소를 확인하세요).';
    return (e && e.message) || '알 수 없는 문제가 생겼어요';
  }

  // ---------- 흐름 ----------
  async function signup(ev) {
    ev.preventDefault();
    if (!supported()) return;
    const f = ev.target;
    say('기기에서 패스키를 만들어 주세요…');
    try {
      const { options } = await api('POST', '/api/passkey/signup/options', { username: f.username.value, name: f.name.value });
      let cred;
      try { cred = await navigator.credentials.create({ publicKey: toCreateOptions(options) }); } catch (e) { return say(deviceError(e, '패스키 만들기'), 'err'); }
      const out = await api('POST', '/api/passkey/signup/verify', { response: credToJSON(cred) });
      f.reset();
      say('계정과 패스키 "' + out.passkey.name + '"를 만들었어요. 공개키만 서버에 저장됐습니다.', 'ok');
      await load();
    } catch (e) { say(e.message, 'err'); }
  }

  async function login() {
    if (!supported()) return;
    say('기기에서 패스키를 골라 주세요…');
    try {
      const { options } = await api('POST', '/api/passkey/login/options');
      let cred;
      try { cred = await navigator.credentials.get({ publicKey: toGetOptions(options) }); } catch (e) { return say(deviceError(e, '패스키로 들어가기'), 'err'); }
      const out = await api('POST', '/api/passkey/login/verify', { response: credToJSON(cred) });
      say('"' + out.passkey_name + '" 패스키로 들어왔어요.', 'ok');
      await load();
    } catch (e) { say(e.message, 'err'); }
  }

  async function addPasskey(ev) {
    ev.preventDefault();
    if (!supported()) return;
    const f = ev.target;
    say('기기에서 새 패스키를 만들어 주세요…');
    try {
      const { options } = await api('POST', '/api/passkey/add/options', { name: f.name.value });
      let cred;
      try { cred = await navigator.credentials.create({ publicKey: toCreateOptions(options) }); } catch (e) { return say(deviceError(e, '패스키 등록'), 'err'); }
      const out = await api('POST', '/api/passkey/add/verify', { response: credToJSON(cred) });
      f.reset();
      say('패스키 "' + out.passkey.name + '"를 더 등록했어요.', 'ok');
      await load();
    } catch (e) { say(e.message, 'err'); }
  }

  async function logout() {
    try { await api('POST', '/api/passkey/logout'); } catch (e) {}
    say('로그아웃했어요. 비공개 내용을 화면에서 지웠습니다.', 'ok');
    showLocked();
  }

  // ---------- 그리기 ----------
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' }) : '아직 없음');
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function showLocked() {
    $('vault-open').hidden = true;
    $('vault-locked').hidden = false;
    $('vault-lock').textContent = '🔒';
    // 로그아웃하면 그렸던 비공개 내용을 DOM에서도 지운다.
    $('items').replaceChildren();
    $('keys').replaceChildren();
    $('who').textContent = '';
  }

  function drawItems(data) {
    const ul = $('items');
    ul.replaceChildren();
    $('items-count').textContent = data.count + '개';
    $('items-empty').hidden = data.count > 0;
    for (const it of data.items) {
      const li = el('li');
      const row = el('div', 'row');
      const left = el('div');
      left.append(el('span', 'kind', it.kind_label), el('span', 'title', it.title));
      if (it.body) left.append(el('p', 'body', it.body));
      const del = el('button', 'vault-btn small danger', '지우기');
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!confirm('"' + it.title + '" 항목을 지울까요?')) return;
        try { await api('DELETE', '/api/private/items/' + it.id); await load(); } catch (e) { say(e.message, 'err'); }
      });
      row.append(left, del);
      li.append(row);
      ul.append(li);
    }
  }

  function drawKeys(keys, currentId) {
    const ul = $('keys');
    ul.replaceChildren();
    $('keys-count').textContent = keys.length + '개';
    $('keys-warn').textContent = keys.length <= 1
      ? '패스키가 하나뿐이에요. 이 기기를 잃어버리면 들어올 방법이 없으니 다른 기기에서 하나 더 등록해 두세요. 마지막 하나는 지울 수 없습니다.'
      : '하나를 잃어버려도 남은 패스키로 들어올 수 있어요.';
    for (const k of keys) {
      const li = el('li');
      const row = el('div', 'row');
      const left = el('div');
      const name = el('strong', '', k.name);
      left.append(name);
      if (k.id === currentId) left.append(el('span', 'here', '지금 이 패스키로 들어옴'));
      left.append(
        el('span', 'meta', '저장된 곳: ' + k.stored_in.place + ' (' + k.stored_in.kind + ')'),
        el('span', 'meta', '등록: ' + fmt(k.created_at) + ' · 마지막 사용: ' + fmt(k.last_used_at)),
      );
      const del = el('button', 'vault-btn small danger', '지우기');
      del.type = 'button';
      del.disabled = keys.length <= 1;
      del.title = keys.length <= 1 ? '마지막 패스키는 지울 수 없어요' : '';
      del.addEventListener('click', async () => {
        if (!confirm('패스키 "' + k.name + '"를 지울까요? 지운 패스키로는 더 이상 들어올 수 없어요.')) return;
        try {
          const out = await api('DELETE', '/api/passkeys/' + k.id);
          if (out.logged_out) { say('지금 쓰던 패스키를 지워서 로그아웃됐어요. 남은 패스키로 다시 들어오세요.', 'ok'); return showLocked(); }
          say('패스키 "' + k.name + '"를 지웠어요. 남은 패스키 ' + out.remaining + '개.', 'ok');
          await load();
        } catch (e) { say(e.message, 'err'); }
      });
      row.append(left, del);
      li.append(row);
      ul.append(li);
    }
  }

  async function load() {
    let me;
    try { me = await api('GET', '/api/me'); } catch (e) {
      if (e.status === 401) return showLocked();
      return say(e.message, 'err');
    }
    const items = await api('GET', '/api/private/items');
    $('who').textContent = me.user.username;
    drawKeys(me.passkeys, me.current_passkey_id);
    drawItems(items);
    $('vault-locked').hidden = true;
    $('vault-open').hidden = false;
    $('vault-lock').textContent = '🔓';
  }

  $('form-signup').addEventListener('submit', signup);
  $('btn-login').addEventListener('click', login);
  $('btn-logout').addEventListener('click', logout);
  $('form-add').addEventListener('submit', addPasskey);
  $('form-item').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('POST', '/api/private/items', { kind: f.kind.value, title: f.title.value, body: f.body.value });
      f.reset();
      await load();
    } catch (e) { say(e.message, 'err'); }
  });
  $('btn-examples').addEventListener('click', async () => {
    try { await api('POST', '/api/private/examples'); await load(); } catch (e) { say(e.message, 'err'); }
  });
  load();
})();
