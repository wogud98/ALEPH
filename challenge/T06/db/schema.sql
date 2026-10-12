-- T06 플랜두씨 다이어리 스키마 (pds-schema-v2)
-- 서버가 시작할 때마다 실행된다. 모든 문장은 여러 번 실행해도 안전하다.
--
-- 날짜 규칙
--   * 날짜(기간·마감일)는 서울 달력 날짜를 date 형식(YYYY-MM-DD)으로 저장한다.
--   * 시각(시작·끝·완료·작성)은 timestamptz로 저장하고, API는 UTC ISO 8601 문자열로 돌려준다.
--     화면은 Asia/Seoul로 바꿔 보여 주고, 입력한 서울 시각은 +09:00을 붙여 서버로 보낸다.
--   * "오늘"은 서버가 (now() at time zone 'Asia/Seoul')::date 로 정한다.
-- 단위 규칙
--   * 예상 시간·실제 시간은 모두 정수 "분"으로 저장한다. 화면은 분과 시간으로 함께 보여 준다.
-- 우선순위 규칙
--   * 1 = 높음, 2 = 보통, 3 = 낮음 (숫자가 작을수록 먼저)

create table if not exists plans (
  id                     bigint generated always as identity primary key,
  -- 지금 값 (가장 최근 판). 처음 값과 고치기 전 값은 plan_revisions에 그대로 남는다.
  current_revision       integer not null default 1,
  title                  text not null check (length(title) between 1 and 200),
  start_date             date not null,
  end_date               date not null,
  priority               smallint not null check (priority in (1, 2, 3)),
  success_criteria       text not null check (length(success_criteria) between 1 and 2000),
  estimated_minutes      integer not null check (estimated_minutes >= 0),
  -- 돌아보기에서 넘어온 고칠 점 (다음 계획일 때만)
  carried_from_retro_id  bigint unique,
  carried_improvement    text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (end_date >= start_date)
);

-- 계획의 모든 판(1판 = 처음 세운 계획). 고칠 때마다 한 줄씩 쌓이고, 이미 쌓인 줄은 바꾸지 않는다.
create table if not exists plan_revisions (
  id                 bigint generated always as identity primary key,
  plan_id            bigint not null references plans(id) on delete cascade,
  revision_no        integer not null check (revision_no >= 1),
  title              text not null,
  start_date         date not null,
  end_date           date not null,
  priority           smallint not null check (priority in (1, 2, 3)),
  success_criteria   text not null,
  estimated_minutes  integer not null check (estimated_minutes >= 0),
  change_reason      text,
  created_at         timestamptz not null default now(),
  unique (plan_id, revision_no)
);

create or replace function plan_revisions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'plan_revisions는 고칠 수 없습니다 (새 판을 추가하세요)';
end $$;

drop trigger if exists plan_revisions_no_update on plan_revisions;
create trigger plan_revisions_no_update before update on plan_revisions
  for each row execute function plan_revisions_immutable();

create table if not exists tasks (
  id                 bigint generated always as identity primary key,
  plan_id            bigint not null references plans(id) on delete cascade,
  title              text not null check (length(title) between 1 and 200),
  description        text not null default '',
  due_date           date,
  priority           smallint not null default 2 check (priority in (1, 2, 3)),
  tags               text[] not null default '{}',
  estimated_minutes  integer not null default 0 check (estimated_minutes >= 0),
  status             text not null default 'todo' check (status in ('todo', 'done')),
  completed_at       timestamptz,
  deleted_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check ((status = 'done') = (completed_at is not null))
);
create index if not exists tasks_plan_idx on tasks (plan_id) where deleted_at is null;

-- 완료 기록. 같은 할 일에 "살아 있는" 완료(undone_at이 비어 있는 줄)는 하나만 있을 수 있다.
create table if not exists task_completions (
  id               bigint generated always as identity primary key,
  task_id          bigint not null references tasks(id) on delete cascade,
  idempotency_key  text not null unique,
  completed_at     timestamptz not null default now(),
  undone_at        timestamptz
);
create unique index if not exists task_completions_one_active
  on task_completions (task_id) where undone_at is null;

-- 실행 기록 (실제로 한 일). 계획·할 일의 값을 건드리지 않고 따로 쌓는다.
create table if not exists work_logs (
  id               bigint generated always as identity primary key,
  task_id          bigint not null references tasks(id) on delete cascade,
  started_at       timestamptz not null,
  ended_at         timestamptz not null,
  actual_minutes   integer not null check (actual_minutes >= 0),
  blocked_reason   text not null default '',
  note             text not null default '',
  idempotency_key  text not null unique,
  created_at       timestamptz not null default now(),
  check (ended_at >= started_at),
  check (actual_minutes <= ceil(extract(epoch from (ended_at - started_at)) / 60.0))
);
create index if not exists work_logs_task_idx on work_logs (task_id);

-- 돌아보기. 저장 시점의 집계를 snapshot으로 함께 남긴다.
create table if not exists retrospectives (
  id              bigint generated always as identity primary key,
  plan_id         bigint not null references plans(id) on delete cascade,
  period_from     date,
  period_to       date,
  snapshot        jsonb not null,
  went_well       text not null default '',
  went_wrong      text not null default '',
  improvement     text not null check (length(improvement) between 1 and 500),
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table plans add constraint plans_carried_from_retro_fk
    foreign key (carried_from_retro_id) references retrospectives(id) on delete set null;
exception when duplicate_object then null;
end $$;
