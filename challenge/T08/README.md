# 내 소개 페이지에 패스키 달기 (T08)

1번 과제에서 만든 소개 페이지(`challenge/T01/index.html`)를 **그 파일 그대로** 첫 화면으로 내보내고, 맨 아래에 나만 보는 자리를 하나 붙여 패스키(WebAuthn)로 잠갔습니다. 비밀번호는 어디에도 없습니다.

- 결과물: `https://aleph-t08-intro.onrender.com` (Render 무료, 첫 요청은 깨어나는 데 30초쯤 걸릴 수 있음)
- 소스: https://github.com/wogud98/ALEPH/tree/main/challenge/T08

## 공개와 비공개

| 공개 (누구나) | 비공개 (패스키로 들어온 본인만) |
|---|---|
| 1번 소개 페이지 전체: 지나온 경로, 강점과 취향, 좋아하는 것, 이 페이지에 대해 | 준비 중인 프로젝트 메모, 지원하려는 곳, 스스로 쓰는 회고 |
| 「여기까지 공개 · 여기부터 비공개」 경계선과 잠긴 상자, 단추 | 내 패스키 목록(이름, 등록한 날짜, 저장된 곳, 마지막 사용) |

- 페이지 HTML은 로그인 여부와 상관없이 **모두에게 같은 것**을 줍니다. 비공개 내용은 HTML에 없고 `GET /api/private/items`로만 나가며, 그 API는 세션이 없으면 401입니다.
- 비공개 자리에 넣은 내용은 모두 만들어 넣은 것입니다. 실제 연락처·신분증 번호 같은 개인정보는 없습니다.

## 어떻게 붙였나

- 서명 확인: 라이브러리 [`@simplewebauthn/server`](https://simplewebauthn.dev) **13.3.3**
- 질문 보관·한 번만 쓰기·세션·주인 확인: 직접 구현 (`node:crypto`, PostgreSQL `t08` 스키마)
- 화면의 패스키 호출: 브라우저 기본 `navigator.credentials.create/get` (라이브러리 없이 `public/vault.js`)

| 흐름 | 지나는 곳 |
|---|---|
| 등록 (새 계정) | `public/vault.js` `signup()` → `POST /api/passkey/signup/options` → `src/passkey.js` `signupOptions()` (질문 만들어 `challenges`에 보관, 표는 쿠키 `t08_ch`) → 기기 → `POST /api/passkey/signup/verify` → `signupVerify()` (`takeChallenge()`로 꺼내며 다 썼다고 적음 → `verifyRegistrationResponse` → `users`·`credentials`에 공개키 저장 → 세션) |
| 패스키 추가 | `addPasskey()` → `/api/passkey/add/options` (`excludeCredentials`에 이미 등록한 것) → `/api/passkey/add/verify` |
| 로그인 | `login()` → `/api/passkey/login/options` → 기기 서명 → `/api/passkey/login/verify` → `loginVerify()` (질문 꺼냄 → credential_id로 공개키 찾기 → 사용자 핸들 대조 → `verifyAuthenticationResponse` → 세션 쿠키 `t08_sid`) |
| 로그아웃 | `logout()` → `POST /api/passkey/logout` → `sessions.revoked_at = now()` |
| 비공개 자료 조회 | `load()` → `GET /api/private/items` → `src/app.js` `currentUser()` 없으면 401 → `src/private.js` `list()` (`where user_id = 세션의 사람`) |
| 패스키 지우기 | `DELETE /api/passkeys/:id` → `deletePasskey()` (내 것만, 마지막 하나는 409, 그 패스키로 연 세션도 끊음) |

## 확인 방법

```bash
cd challenge/T08
npm ci
TEST_DATABASE_URL=postgres://…/빈_검사용_DB npm test        # API 검사 (가상 인증기)
TEST_DATABASE_URL=… npm run test:e2e                        # 브라우저 검사 (Chromium 가상 인증기, playwright 필요)
node scripts/evidence.js https://<배포 주소> > evidence.md   # 실제 서버로 확인 기록 만들기 (세션 값은 가림)
```

## 배포 (Render)

T07과 같은 무료 PostgreSQL(`aleph-t06-db`)을 쓰고 표는 `t08` 스키마에 둡니다. New Web Service로 만들고:

- Root Directory `challenge/T08`, Build `npm ci --omit=dev`, Start `npm start`, Health Check `/healthz`
- 환경 변수: `DATABASE_URL`(DB의 Internal URL), `DB_SCHEMA=t08`, `COOKIE_SECURE=1`, `NODE_VERSION=22`
- RP ID와 출처는 Render가 넣어 주는 `RENDER_EXTERNAL_HOSTNAME`·`RENDER_EXTERNAL_URL`로 자동으로 정해집니다 (다른 주소를 쓰면 `RP_ID`, `ORIGIN`).
- 내 계정 두 개를 만든 뒤 `SIGNUP_OPEN=0`을 넣으면 새 계정 만들기를 닫을 수 있습니다 (기본은 열림, 최대 `MAX_ACCOUNTS`=20).
