# T06 플랜두씨 다이어리 — 내 계획과 실제를 담는 앱

계획(Plan) → 실제로 한 일(Do) → 돌아보기(See)가 서버의 PostgreSQL로 이어지는 다이어리입니다. 로그인이 없어서 **링크를 아는 사람은 누구나 볼 수 있습니다.** 남이 봐도 괜찮은 내용만 넣습니다(잠그는 일은 T07).

- 결과물: https://aleph-t06-pds.onrender.com
- 소스: https://github.com/wogud98/ALEPH/tree/main/challenge/T06

## 구성

| 경로 | 역할 |
|---|---|
| `seed/mine.json` | 내 실제 운동 계획·할 일·실행 기록 (DB가 비어 있을 때 한 번만 들어감) |
| `server.js` | 시작점. DB 스키마 적용 → (DB가 비어 있으면) `seed/mine.json` 넣기 → HTTP 서버 |
| `src/service.js` | 계획·할 일·실행 기록·돌아보기 규칙과 SQL. 집계 숫자와 근거 목록이 같은 조건을 쓴다 |
| `src/app.js` | API 경로, 보안 헤더(CSP), 오류 응답(DB 오류 원문은 숨김) |
| `db/schema.sql` | 표·제약·트리거. 서버가 시작할 때마다 실행(여러 번 실행해도 안전) |
| `contracts/pds-schema-v2.json` | 최종 DB 표·항목·관계·날짜 규칙 계약. 검사가 실제 DB와 일치하는지 확인 |
| `public/` | 화면 (HTML·CSS·JS, 빌드 없음). 사용자 글자는 `textContent`로만 넣는다 |
| `test/api.test.js` | 통과 기준별 API·DB 검사 (실제 PostgreSQL) |
| `test/e2e.test.js` | 실제 브라우저로 누르는 검사 (Playwright가 있을 때) |
| `scripts/check-secrets.js` | Git 파일·기록 전체 비밀값 점검 |
| `scripts/check-live.js` | 배포 주소를 로그인 없이 열어 핵심 기준 점검 |
| `../../render.yaml` | Render Blueprint (웹 서비스 + PostgreSQL, DB 주소는 Render가 환경 변수로 연결) |

## 설계에서 정한 것

- **처음 계획 보존 (C08)**: `plans`에는 지금 값, `plan_revisions`에는 1판(처음 계획)부터 모든 판을 쌓습니다. 이미 쌓인 판은 트리거가 UPDATE를 막습니다. 계획 ID는 그대로입니다.
- **완료 중복 방지 (C21, C22)**: 완료 버튼은 그려질 때 요청 키를 하나 받습니다. 서버는 같은 키를 한 번만 처리하고, 키가 달라도 DB의 부분 유일 색인(`task_completions_one_active`)이 같은 할 일의 살아 있는 완료를 1건으로 막습니다. 버튼 잠금에 기대지 않습니다.
- **실행 기록은 따로 (C27)**: `work_logs`에만 쌓고 계획·할 일의 예상 값은 건드리지 않습니다.
- **정렬 (C20)**: 서버 SQL에서 정렬하고, 값이 같으면 마지막에 ID로 순서를 고정합니다. 화면에 기준 문장을 그대로 보여 줍니다.
- **돌아보기 (C28~C32, C83)**: 지표마다 SQL 조건을 한 곳에만 두고, 숫자와 근거 목록이 같은 조건을 씁니다. 지연의 "오늘"은 DB가 서울 시간으로 정합니다. 시간은 모두 정수 분입니다.
- **날짜·시간 (C35)**: 날짜는 `date`(서울 달력), 시각은 `timestamptz`. 입력은 `+09:00`을 붙여 보내고, 응답은 UTC ISO, 화면은 서울 시간으로 보여 줍니다.
- **지우기**: 할 일은 `deleted_at`만 적는 방식이라 집계에서는 빠지고 기록은 남습니다.

## 실행

```
npm ci
DATABASE_URL=postgres://... npm start          # http://localhost:3000
TEST_DATABASE_URL=postgres://.../빈_검사용_DB npm test     # 검사용 DB의 public 스키마를 지우니 운영 DB 금지
TEST_DATABASE_URL=... PLAYWRIGHT_MODULE=playwright npm run test:e2e
npm run check:secrets
npm run check:live -- https://<배포 주소>
```

## 배포 (Render)

1. https://render.com/deploy?repo=https://github.com/wogud98/ALEPH 를 엽니다.
2. GitHub로 로그인하고 저장소 접근을 허용한 뒤 **Apply**를 누르면 `aleph-t06-pds`(웹)와 `aleph-t06-db`(PostgreSQL)가 만들어집니다.
3. 배포가 끝나면 `https://aleph-t06-pds.onrender.com`(이름이 겹치면 뒤에 글자가 붙음)이 결과물 주소입니다.

무료 요금제 주의: 웹 서비스는 15분 동안 접속이 없으면 잠들어 첫 접속이 1분쯤 걸립니다. 무료 PostgreSQL은 만든 날부터 30일 뒤 만료되므로, 그 전에 화면의 "내 자료 전체 내보내기"로 파일을 받아 두거나 유료로 바꿉니다.

## 짧은 확인 방법

1. **어디로 가나요**: 새 시크릿 창에서 결과물 주소를 엽니다 (첫 접속은 서버가 깨어나느라 1분쯤 걸릴 수 있음).
2. **세 단계 안에 무엇을 하나요**: ① 첫 화면 노란 공개 안내를 확인하고 → ② "3 돌아보기"에서 **완료 수** 숫자를 누르고 → ③ 아래 근거 목록의 할 일 링크를 누릅니다.
3. **무엇이 보이면 통과인가요**: 근거 목록의 개수가 누른 숫자와 같고, 링크를 누르면 그 할 일이 노랗게 깜빡이며 실행 기록(시작·끝·실제 시간·막힌 이유)과 함께 보입니다. 새로고침해도 숫자가 그대로입니다.
4. **안 될 때는 무엇이 보이나요**: 화면 위에 빨간 글씨로 "서버에 연결하지 못했습니다…" 또는 "서버에서 처리하지 못했습니다…"가 뜨고 숫자 칸이 비어 있거나, Render의 "Service Unavailable"/로딩 화면이 나옵니다.

## 점검 결과 (로컬 PostgreSQL 16 + Chromium)

- `npm test`: 33개 통과 (C04~C36, C57, C58, C78~C83 및 계약 파일 일치)
- `npm run test:e2e`: 10개 통과 (공개 안내, 스크립트 글자, 완료 두 번 누르기, 숫자→근거 이동, 계획 수정 이력, 실행 기록, 새로고침, 고칠 점 넘기기, 내보내기, 콘솔 오류 0)
- `npm run check:secrets`: 비밀값 원문 없음
