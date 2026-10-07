# T04 오늘의 진짜 정보판 — 달러 환율 장부 (프로토타입)

USD→KRW 환율을 GitHub Actions가 매일 자동으로 조회해 이 폴더의 `data/`에 쌓는다. 비밀키는 쓰지 않는다.

## 구성

| 경로 | 역할 |
|---|---|
| `../../.github/workflows/t04-collect.yml` | 매일 10:17, 22:17(KST) 자동 실행 + 수동 실행. 수집 후 `data/` 변경분을 커밋 |
| `collector/lib.js` | 정규화·검증·일별 upsert·전날 대비 계산 (I/O 없는 순수 함수, 추후 fixture replay와 공유) |
| `collector/collect.js` | 실제 API 호출, 실패 5종 분류, 파일 저장 |
| `index.html` | 공개 뷰어 (GitHub Pages) |
| `data/` | 자동 수집 결과 (손으로 수정하지 않음) |

## 데이터 파일

- `data/daily.json` — 일별 기록 배열. `signal_id + record_date(KST)`당 1행. 같은 날 다시 성공하면 그 행을 갱신하고 `record_id`, `first_fetched_at`은 유지한다. 각 행의 `reading`은 `normalized-reading.schema.json` 형식 그대로다.
- `data/raw/<기록일>.json` — 그날 행에 쓰인 원 응답 본문을 가공 없이 보관.
- `data/status.json` — `status.freshness`(fresh/stale)와 `status.error_code`(none/timeout/auth/rate_limit/offline/schema_error), 마지막 시도 정보.
- `data/runs.jsonl` — 성공·실패를 포함한 모든 수집 시도 로그 (한 줄에 JSON 하나).

## 실패 분류 규칙

시간 초과(10초) → `timeout`, HTTP 401/403 → `auth`, HTTP 429 → `rate_limit`, 연결 실패 → `offline`, JSON 아님·필드 누락·타입 변경·그 밖의 HTTP 오류 → `schema_error` (공개 참조 adapter와 같은 규칙). 실패 시 `daily.json`과 `raw/`는 건드리지 않는다.

## 주의

- 봇이 매일 커밋하므로 로컬에서 작업하기 전에 항상 `git pull` 먼저.
- 환율 출처 표기 의무: "Rates By Exchange Rate API" 링크를 화면에 유지할 것.
