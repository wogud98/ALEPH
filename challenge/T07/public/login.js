'use strict';
// 로그인·가입 화면. 비밀번호는 JSON 본문으로만 보내고(주소창에 싣지 않음), 화면·콘솔·저장소 어디에도 남기지 않는다.
const $ = (s) => document.querySelector(s);

const TITLES = { login: '로그인', signup: '가입', reset: '비밀번호 찾기' };
const modeOf = (p) => (p === '/signup' ? 'signup' : p === '/reset' ? 'reset' : 'login');

function mode(name) {
  for (const k of Object.keys(TITLES)) $(`#${k}-box`).hidden = k !== name;
  $('#code-box').hidden = true;
  document.title = `${TITLES[name]} · 플랜두씨 다이어리`;
  $(`#${name}-form`).elements.username.focus();
}

// 가입·비밀번호 찾기 뒤에 새 복구 코드를 한 번 보여 주고, 확인을 누르면 앱으로 간다.
function showCode(code) {
  for (const k of Object.keys(TITLES)) $(`#${k}-box`).hidden = true;
  $('#code-value').textContent = code;
  $('#code-box').hidden = false;
  document.title = '복구 코드 · 플랜두씨 다이어리';
  $('#code-done').focus();
}

async function post(url, body) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요 (첫 접속은 서버가 깨어나느라 1분쯤 걸릴 수 있습니다).');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청이 실패했습니다 (${res.status})`);
  return data;
}

async function submit(e, kind) {
  e.preventDefault();
  const f = e.currentTarget;
  const err = $(`#${kind}-error`);
  err.textContent = '';
  const username = f.elements.username.value.trim();
  const password = f.elements.password.value;
  if (f.elements.password2 && password !== f.elements.password2.value) {
    err.textContent = '비밀번호 확인이 같지 않습니다';
    return;
  }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const body = kind === 'reset'
      ? { username, recovery_code: f.elements.recovery_code.value, new_password: password }
      : { username, password };
    const data = await post(`/api/auth/${kind}`, body);
    f.reset();
    if (data.recovery_code) showCode(data.recovery_code);
    else location.replace('/app');
  } catch (ex) {
    err.textContent = ex.message;
    f.elements.password.value = '';
    if (f.elements.password2) f.elements.password2.value = '';
  } finally {
    btn.disabled = false;
  }
}

$('#login-form').addEventListener('submit', (e) => submit(e, 'login'));
$('#signup-form').addEventListener('submit', (e) => submit(e, 'signup'));
$('#reset-form').addEventListener('submit', (e) => submit(e, 'reset'));
for (const a of document.querySelectorAll('#to-signup, #to-reset, .to-login')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const name = modeOf(new URL(a.href).pathname);
    history.pushState(null, '', `/${name}`);
    mode(name);
  });
}
$('#code-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#code-value').textContent);
    $('#code-copy').textContent = '복사했어요';
  } catch {
    $('#code-copy').textContent = '직접 적어 주세요';
  }
});
$('#code-done').addEventListener('click', () => location.replace('/app'));
window.addEventListener('popstate', () => mode(modeOf(location.pathname)));
mode(modeOf(location.pathname));
