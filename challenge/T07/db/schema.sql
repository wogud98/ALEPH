-- T07 플랜두씨 다이어리 스키마 (pds-schema-v3 = T06의 v2 + 계정·세션·주인·5일 기록)
-- 서버가 시작할 때마다 실행된다. 모든 문장은 여러 번 실행해도 안전하다.
-- 표는 모두 t07 스키마에 만든다 (src/db.js가 search_path를 t07로 고정). T06의 public 표와 섞이지 않는다.
--
-- 주인 규칙
--   * 계획(plans)마다 주인(owner_id)이 있다. 할 일·완료·실행 기록·돌아보기는 계획을 거쳐 주인이 정해진다.
--   * 계정을 지우면 on delete cascade로 그 계정의 계획과 딸린 자료, 세션, 5일 기록이 모두 지워진다.
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

-- 계정. 비밀번호는 argon2id 해시(소금값 포함 문자열)만 저장한다. 원문은 어디에도 저장하지 않는다.
create table if not exists users (
  id                   bigint generated always as identity primary key,
  username             text not null check (username ~ '^[a-z0-9_]{3,30}$'),
  password_hash        text not null check (password_hash like '$argon2id$%'),
  password_changed_at  timestamptz not null default now(),
  created_at           timestamptz not null default now()
);
create unique index if not exists users_username_key on users (username);

-- 로그인 세션. 브라우저 쿠키에는 무작위 토큰 원문, DB에는 그 SHA-256 값만 둔다.
-- 로그아웃·비밀번호 변경 때 revoked_at을 적어 서버에서 끊는다. expires_at이 지나도 끊긴다.
create table if not exists sessions (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references users(id) on delete cascade,
  token_hash   bytea not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index if not exists sessions_user_idx on sessions (user_id);

create table if not exists plans (
  id                     bigint generated always as identity primary key,
  owner_id               bigint not null references users(id) on delete cascade,
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
create index if not exists plans_owner_idx on plans (owner_id);

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

-- T06 자료를 한 번만 옮겨 왔다는 표시 (한 줄만 존재). 계정을 지워도 다시 옮기지 않도록 줄은 남긴다.
create table if not exists t06_imports (
  id           boolean primary key default true check (id),
  owner_id     bigint references users(id) on delete set null,
  imported_at  timestamptz not null default now(),
  counts       jsonb not null
);

-- 5일 기록. 계정마다 하나. 1일차 기록이 생기면 질문·지표·단위는 더 고칠 수 없다(트리거).
create table if not exists experiments (
  id          bigint generated always as identity primary key,
  owner_id    bigint not null unique references users(id) on delete cascade,
  question    text not null check (length(question) between 1 and 300),
  metric      text not null check (length(metric) between 1 and 100),
  unit        text not null check (length(unit) between 1 and 20),
  calc_rule   text not null check (length(calc_rule) between 1 and 500),
  plan_rule   text not null check (length(plan_rule) between 1 and 500),
  created_at  timestamptz not null default now()
);

create table if not exists experiment_days (
  id             bigint generated always as identity primary key,
  experiment_id  bigint not null references experiments(id) on delete cascade,
  day_no         smallint not null check (day_no between 1 and 5),
  day_date       date not null,
  value          integer check (value >= 0),
  plan_rule      text not null,
  note           text not null default '',
  created_at     timestamptz not null default now(),
  unique (experiment_id, day_no),
  unique (experiment_id, day_date)
);

-- 계획 규칙 변경. 실험마다 한 번. 1일차·2일차 기록을 가리키고, 3일차 기록보다 먼저 생긴다.
create table if not exists experiment_rule_changes (
  id             bigint generated always as identity primary key,
  experiment_id  bigint not null unique references experiments(id) on delete cascade,
  day1_id        bigint not null references experiment_days(id),
  day2_id        bigint not null references experiment_days(id),
  old_rule       text not null,
  new_rule       text not null check (length(new_rule) between 1 and 500),
  reason         text not null check (length(reason) between 1 and 500),
  changed_at     timestamptz not null default now()
);

create or replace function experiments_lock_definition() returns trigger language plpgsql as $$
begin
  if (new.question, new.metric, new.unit, new.calc_rule) is distinct from (old.question, old.metric, old.unit, old.calc_rule)
     and exists (select 1 from experiment_days d where d.experiment_id = old.id) then
    raise exception '1일차 기록이 있으면 질문·지표·단위·계산 규칙을 고칠 수 없습니다';
  end if;
  return new;
end $$;

drop trigger if exists experiments_definition_locked on experiments;
create trigger experiments_definition_locked before update on experiments
  for each row execute function experiments_lock_definition();
