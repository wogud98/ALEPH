'use strict';
// 로그인·가입 화면. 비밀번호는 JSON 본문으로만 보내고(주소창에 싣지 않음), 화면·콘솔·저장소 어디에도 남기지 않는다.
const $ = (s) => document.querySelector(s);

function mode(name) {
  $('#login-box').hidden = name !== 'login';
  $('#signup-box').hidden = name !== 'signup';
  document.title = `${name === 'login' ? '로그인' : '가입'} · 플랜두씨 다이어리`;
  const f = $(name === 'login' ? '#login-form' : '#signup-form');
  f.elements.username.focus();
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
  if (kind === 'signup' && password !== f.elements.password2.value) {
    err.textContent = '비밀번호 확인이 같지 않습니다';
    return;
  }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await post(`/api/auth/${kind}`, { username, password });
    f.reset();
    location.replace('/app');
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
for (const [id, name] of [['#to-signup', 'signup'], ['#to-login', 'login']]) {
  $(id).addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState(null, '', `/${name}`);
    mode(name);
  });
}
window.addEventListener('popstate', () => mode(location.pathname === '/signup' ? 'signup' : 'login'));
mode(location.pathname === '/signup' ? 'signup' : 'login');
