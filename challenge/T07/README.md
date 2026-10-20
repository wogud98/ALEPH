# T07 플랜두씨 다이어리 2 — 로그인을 붙여 내 기록을 나만 보게

T06 다이어리(`challenge/T06`, 배포 https://aleph-t06-pds.onrender.com, 이어 붙인 T06 커밋 `4b1fa1a`)에 가입·로그인·로그아웃과 "주인 확인"을 붙인 판입니다. 첫 화면은 로그인 화면이고, 계획·할 일·실행 기록·돌아보기·5일 기록은 로그인한 본인에게만 나옵니다.

- 결과물: https://aleph-07-pds.onrender.com
- 소스: https://github.com/wogud98/ALEPH/tree/2e23c972c399c8b187c54433ddc5bf7c3049aa13/challenge/T07

## 무엇으로 붙였나

| 부분 | 고른 것 | 버전 |
|---|---|---|
| 비밀번호 해시 | 라이브러리 [`argon2`](https://github.com/ranisalt/node-argon2) (argon2id, 메모리 64MiB·반복 3·병렬 4, 소금값 자동) | 0.45.1 |
| 로그인 유지 | 직접 구현: 서버 세션 표(`sessions`) + HttpOnly 쿠키 `pds_sid` (토큰 = `crypto.randomBytes(32)`, DB에는 SHA-256만) | Node 22 `node:crypto` |
| 저장소 | T06과 같은 Render PostgreSQL, 표는 `t07` 스키마에 따로 | PostgreSQL 16, `pg` 8 |

검토했지만 고르지 않은 것: 인증 서비스(Supabase Auth·Auth0), JWT, Passport/express-session. 이유는 설명서 ②에 적습니다.

## 바뀐 곳

| 경로 | 바뀐 것 |
|---|---|
| `src/auth.js` (새 파일) | 가입·로그인·로그아웃·비밀번호 변경·계정 삭제, 세션 만들기/찾기/끊기, 로그인 실패 제한, 복구 코드로 비밀번호 찾기 |
| `src/app.js` | `/`·`/app` 앞에서 세션 확인(없으면 로그인 화면), `/api/auth/*`, 그 밖의 `/api/*`는 세션 없으면 401, 모든 API에 세션의 `user.id`를 넘김, 다른 사이트 Origin 거절 |
| `src/service.js` | 모든 조회·수정·삭제 SQL에 `owner_id = 로그인한 사람` 조건 (남의 것은 404) |
| `src/experiment.js` (새 파일) | 5일 기록: 질문·지표·단위·규칙, 날짜별 값, 2일차 뒤·3일차 앞 규칙 변경 한 번, 합계·평균 |
| `src/import-t06.js` (새 파일) | T06(`public` 스키마) 자료를 `T06_OWNER_USERNAME` 계정으로 한 번만 옮김 |
| `src/db.js` | 접속마다 `search_path=t07`, 시작할 때 `create schema t07` |
| `db/schema.sql` | `users`, `sessions`, `plans.owner_id`, `t06_imports`, `experiments`, `experiment_days`, `experiment_rule_changes` |
| `public/login.html`, `public/login.js` (새 파일) | 로그인·가입 화면 |
| `public/index.html`, `public/app.js` | 아이디·로그아웃·계정(비밀번호 바꾸기, 계정 지우기), "Ⅳ 5일 기록" 탭, 401이면 로그인 화면으로 |
| `scripts/reset-password.js` (새 파일) | 복구 코드도 없을 때 운영자가 DB에 붙어 임시 비밀번호를 정함 (모든 로그인 끊김) |
| `scripts/evidence.js` (새 파일) | 실제 서버에 요청을 보내 "막히는 장면" 기록(Markdown)을 만듦. 비밀번호·세션 값은 가림 |
| `src/calendar.js` (새 파일), `GET /api/calendar?from=&to=` | 달력: 내 모든 계획의 기간·할 일 마감·실행 기록(시작한 서울 날짜)·5일 기록을 한 기간(최대 62일)에 모아 돌려줌 |
| `public/index.html`, `public/app.js`, `public/style.css` (달력) | 첫 화면을 "달력"으로. 네이버 캘린더처럼 한 달 칸에 계획 기간은 색 띠, 할 일은 칸 안 줄로 보이고(일요일 시작, 일=빨강·토=파랑), 날짜를 누르면 아래에 그날 할 일(완료·실행 기록)과 기록이 나옴. "+ 할 일"(휴대폰은 오른쪽 아래 + 버튼)은 고른 날짜를 마감일로, 그날이 기간에 드는 계획에 넣음. 휴대폰에서 옆으로 밀면 달이 넘어감. 달력 탭은 스크롤 없이 한 화면(넓은 화면은 왼쪽 달력·오른쪽 목록, 휴대폰은 위 달력·아래 목록). 여러 날을 끌면(휴대폰은 꾹 누른 뒤 끌면) 그 기간으로 새 일정(계획), 할 일 줄을 끌어 다른 날에 놓으면 마감일이 옮겨짐 |
| `seed/`, `src/seed.js` | 뺐음 (T06 자료는 `import-t06.js`로 옮김) |

## 실행

```
npm ci
DATABASE_URL=postgres://... npm start                           # http://localhost:3000
TEST_DATABASE_URL=postgres://.../빈_검사용_DB npm test            # 검사용 DB의 t07·public 스키마를 지우니 운영 DB 금지
TEST_DATABASE_URL=... PLAYWRIGHT_MODULE=playwright npm run test:e2e
npm run check:secrets
npm run check:live -- https://<배포 주소>
node scripts/evidence.js https://<배포 주소> > evidence.md       # DATABASE_URL을 주면 DB의 해시도 적음
```

환경 변수: `DATABASE_URL`(필수), `DB_SCHEMA`(기본 `t07`), `COOKIE_SECURE=1`(https에서 쿠키에 Secure), `T06_OWNER_USERNAME`(T06 자료를 받을 아이디). 서명용 비밀키는 쓰지 않습니다.

## 배포 (Render)

1. Render에서 **New → Web Service**로 이 저장소를 고르고 Root Directory `challenge/T07`, Build `npm ci --omit=dev`, Start `npm start`로 만듭니다. 환경 변수는 `DATABASE_URL`(aleph-t06-db의 **Internal Database URL**, `postgresql://`로 시작), `DB_SCHEMA=t07`, `COOKIE_SECURE=1`, `NODE_VERSION=22`, `T06_OWNER_USERNAME`(내가 쓸 아이디)입니다. 지금 떠 있는 T06 서비스가 Blueprint에 묶여 있지 않아서, `render.yaml`로 동기화하면 이름 뒤에 `-xxxx`가 붙은 중복 서비스와 DB가 새로 생기므로 쓰지 않았습니다.
2. T07은 T06과 같은 무료 PostgreSQL(`aleph-t06-db`)을 쓰고 표는 `t07` 스키마에 둡니다. T06 서버는 `public` 스키마만 보므로 T07 자료를 읽을 수 없습니다.
3. 결과물 주소에서 `T06_OWNER_USERNAME`과 같은 아이디로 가입하면, 그 순간 T06 자료가 이 계정으로 한 번 옮겨집니다 (화면 위에 "T06 다이어리 자료를 이 계정으로 옮겨 왔습니다"가 보임).

무료 요금제 주의: 웹 서비스는 15분 동안 접속이 없으면 잠들어 첫 접속이 1분쯤 걸립니다. 무료 PostgreSQL은 만든 날부터 30일 뒤 만료되므로 그 전에 "내보내기"로 파일을 받아 둡니다.

## 비밀번호를 잊었을 때

이메일을 받지 않으므로 **복구 코드**로 찾습니다.

- 가입하면 `XXXXX-XXXXX-XXXXX-XXXXX` 모양의 복구 코드를 한 번만 보여 줍니다. 서버에는 argon2id 해시만 남습니다.
- 로그인 화면의 "비밀번호를 잊었어요"(`/reset`)에서 아이디 + 복구 코드 + 새 비밀번호를 넣으면, 비밀번호가 바뀌고 다른 기기의 로그인은 모두 끊기며 복구 코드도 새것으로 바뀝니다 (한 번 쓴 코드는 다시 못 씀). 틀리면 아이디가 있든 없든 "아이디 또는 복구 코드가 맞지 않습니다", 15분 안에 10번 틀리면 429.
- 로그인한 상태에서는 "계정 → 복구 코드 새로 받기"로 언제든 새 코드를 받습니다 (지금 비밀번호 확인). 이 기능 전에 만든 계정은 여기서 처음 받습니다.
- 복구 코드도 없으면 운영자가 DB에 붙어 임시 비밀번호를 정합니다. 임시 비밀번호는 터미널에 한 번만 찍힙니다.

```
DATABASE_URL='<Render의 External Database URL>' npm run reset-password -- <아이디>
```

## 짧은 확인 방법

1. **어디로 가나요**: 새 시크릿 창에서 결과물 주소를 엽니다 (첫 접속은 서버가 깨어나느라 1분쯤 걸릴 수 있음).
2. **세 단계 안에 무엇을 하나요**: ① 첫 화면이 로그인 화면인지 보고 → ② 주소 끝에 `/app`을 붙여 자료 화면을 직접 열어 보고 → ③ "가입하기"로 아무 아이디나 만들어 들어갑니다.
3. **무엇이 보이면 통과인가요**: ②에서 자료 대신 로그인 화면으로 돌아오고, ③에서 들어간 새 계정에는 계획이 하나도 없습니다(남의 기록이 섞이지 않음). 로그아웃을 누르면 다시 로그인 화면입니다.
4. **안 될 때는 무엇이 보이나요**: 로그인 칸 아래 빨간 글씨로 "아이디 또는 비밀번호가 맞지 않습니다"·"이미 쓰이는 아이디입니다"·"서버에 연결하지 못했습니다…"가 뜨거나, Render의 "Service Unavailable"/로딩 화면이 나옵니다.

## 점검 결과 (로컬 PostgreSQL 16 + Chromium)

- `npm test`: 65개 통과 (T06 기준 33개를 로그인한 계정으로 다시 + 가입·로그인·세션·격리·내보내기·계정 삭제·T06 옮기기 22개 + 비밀번호 찾기 5개 + 5일 기록 2개 + 달력 3개)
- `npm run test:e2e`: 18개 통과 (첫 화면 달력·날짜 눌러 할 일 넣고 완료, 스크롤 없는 한 화면, 끌어서 일정 만들기·할 일 옮기기, 새 브라우저의 첫 화면·/app 되돌림·같은 실패 문구, 가입 → 복구 코드 → 비밀번호 찾기, 5일 기록 화면, 로그아웃, 콘솔 오류 0 등)
- `npm run check:secrets`: 비밀값 원문 없음
