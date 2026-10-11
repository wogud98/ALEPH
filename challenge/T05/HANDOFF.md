# T05 인수인계 (AI A → AI B)

## 목표

`challenge/T05/TASK.md`의 "고칠 것" 1~5를 모두 끝내고 `node challenge/T05/same-source.test.js`가 `10/10 통과`(종료 코드 0)가 되게 한다.
버그: cron 지연으로 다음 KST 날짜에 수집이 돌았는데 원천 갱신 시각(`source_time`)이 직전 기록일 행과 같으면, 전날 값이 새 날짜 행으로 저장됨.

## 현재 상태 (AI A가 한 것: 고칠 것 1~2)

저장소 버전: 작업 전 `0be119d` → AI A 종료 커밋 `dad1cc7`(이 문서가 처음 들어간 커밋). `git log -1 --format=%h -- challenge/T05/HANDOFF.md`로 대조할 수 있다. *(AI B 완료 뒤 진행자가 추가함. LOG.md의 인수인계 누락 항목 참고)*

`challenge/T04/collector/collect.js`의 `run()` 안 `try` 블록에 건너뛰기 분기를 넣었다.

- 조건: 이번 KST 기록일 행(`sameDay`)이 없고, 그보다 앞선 가장 최근 행(`previous`)의 `reading.source_time`이 이번 `reading.source_time`과 같음.
- 이때 `upsertDaily`·raw 저장·daily 저장을 하지 않는다 (고칠 것 1).
- `runLog`를 `{ outcome: 'success', action: 'skip_same_source', record_date, source_time, http_status }`로 만들고, 함수 끝의 공통 코드가 `runs.jsonl`에 추가한다 (고칠 것 2). 종료 코드 0.
- 그 외 경우(`else`)는 원래 저장 흐름 그대로(코드 이동만, 내용 변경 없음).
- 분기 안에 `// TODO(T05 고칠 것 3)` 주석이 있다. 지금은 `status.json`을 전혀 쓰지 않아서 이전 실행의 status가 그대로 남는다.

## 실행 명령 (저장소 루트)

```
node challenge/T05/same-source.test.js
node challenge/T04/collector/test.js
```

## 통과 검사

`9/10 통과` — S01~S04, S06~S10 통과. **S05만 실패**(`last_run.message`가 이전 실행의 `일별 기록 추가`로 남아 있음).

## 남은 문제

1. **고칠 것 3**: 건너뛰기 분기에서 `status.json`을 쓴다.
   - `status: { freshness: 'fresh', error_code: 'none' }`
   - `last_success_record_id`: `previous.record_id` (직전 행 그대로)
   - `last_run`: `{ at: fetchedAt, outcome: 'success', error_code: 'none', http_status: httpStatus, retry_after_seconds: null, message: '같은 원천 시각이라 새 기록을 만들지 않음' }`
   - `last_success_at`을 `fetchedAt`으로 할지 이전 값 유지로 할지는 검사가 보지 않음. 판단해서 정하고 이유를 남길 것.
2. **고칠 것 4**: 같은 날 재수집(update)·원천 시각이 바뀐 다음 날(insert) 유지 — S06~S09로 이미 보호되고 현재 통과 중. 3번 작업 후 다시 확인만.
3. **고칠 것 5**: `challenge/T04/README.md`의 규칙 설명(예: "데이터 파일"의 `daily.json` 항목 근처)에 이 동작을 한 줄 추가.

## 다음 행동

1. `collect.js`의 TODO 자리에 status 쓰기 추가 → TODO 주석 삭제.
2. README 한 줄 추가.
3. 위 두 명령 실행해 `10/10 통과`, T04 검사 통과 확인.
4. `challenge/T05/LOG.md`의 3·4행 기록 후 커밋 (push 금지).

## 건드리지 말 것

- `challenge/T05/same-source.test.js` (삭제·완화·기대값 변경 금지)
- `challenge/T05/TASK.md`
- `challenge/T04/data/` 전체 (손 수정 금지, 이미 잘못 들어간 `2026-10-09` 행도 지우지 않음)
- `git push` 하지 않음
