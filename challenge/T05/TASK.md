# T05 고정 조건 (작업 전 고정, 수정 금지)

## 고칠 기능 (과제 4: 달러 환율 장부의 실제 버그)

**문제:** 22:17 KST 예약 수집이 GitHub cron 지연으로 다음 날 04:18 KST에 돌았을 때, 원천은 아직 전날 값을 주고 있었다(원천 갱신 시각 `2026-10-08T00:02:31Z` 그대로). 수집기는 기록일을 수집 시각으로만 정하므로 이 값이 `2026-10-09` 행으로 저장되었고, 공개 화면에 10-09가 "전날 대비 변동 없음"으로 잘못 표시된다.

**고칠 것:** `challenge/T04/collector/`의 수집 흐름에서, 이번 응답의 원천 갱신 시각(`source_time`)이 **직전 기록일 행의 `source_time`과 같고** 이번 KST 기록일의 행이 아직 없으면:

1. `data/daily.json`과 `data/raw/`를 건드리지 않는다.
2. `data/runs.jsonl`에 `outcome: "success"`, `action: "skip_same_source"`, `source_time`을 남긴다.
3. `data/status.json`은 `fresh/none`, `last_success_record_id`는 직전 행 그대로, `last_run.message`는 `같은 원천 시각이라 새 기록을 만들지 않음`.
4. 같은 KST 날짜 재수집(갱신)과 원천 시각이 바뀐 다음 날 수집(추가)은 지금처럼 동작한다.
5. `challenge/T04/README.md`의 규칙 설명에 이 동작을 한 줄 추가한다.

이미 잘못 들어간 `2026-10-09` 행은 이번 작업에서 지우지 않는다(`data/`는 손으로 수정 금지).

## 고정 검사 10개

`challenge/T05/same-source.test.js` (S01~S10). 저장소 루트에서 실행:

```
node challenge/T05/same-source.test.js
```

통과 모습: 마지막 줄이 `10/10 통과`, 종료 코드 0. 고정 시점 결과: `5/10 통과`(S01~S05 실패, S06~S10은 기존 동작 보호용이라 이미 통과).
검사 파일의 삭제·완화·기대값 변경은 금지(T05-C18~C20).

## 공통 사용 상한 (AI A, AI B 동일)

| 항목 | 상한 |
|---|---|
| 시간 | 각 AI 60분 (첫 요청을 보낸 시각부터 마지막 응답이 끝난 시각까지) |
| 요청 수 | 각 AI 사람이 보낸 메시지 20회 (최초 요청 포함) |

## 최초 요청 (AI A, AI B에 같은 문장으로 보냄)

> 이 저장소의 `challenge/T05/TASK.md`를 읽고 그 버그를 고쳐 줘. 검사 파일은 고치지 말고, `node challenge/T05/same-source.test.js`가 10/10 통과하게 해 줘.

AI B에는 위 문장 뒤에 한 줄만 붙인다: `먼저 challenge/T05/HANDOFF.md를 읽고 이어서 작업해 줘.`

## 진행 규칙

- AI A: Claude Code, AI B: Codex (서로 다른 서비스, T05-C39)
- AI A는 1~2번까지 하고 멈춘 뒤 `challenge/T05/HANDOFF.md`(목표·현재 상태·실행 명령·통과 검사·남은 문제·다음 행동·건드리지 말 것)를 쓰고 커밋한다.
- AI B는 새 에이전트로 시작하고, 저장소와 HANDOFF.md 외에는 아무것도 주지 않는다.
- 두 AI 모두 push하지 않는다(push는 사람이 한다). 기록은 `challenge/T05/LOG.md`에 남긴다.
