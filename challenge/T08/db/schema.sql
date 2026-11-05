-- T08 소개 페이지 비공개 자리 스키마 (t08-schema-v1)
-- 서버가 시작할 때마다 실행된다. 모든 문장은 여러 번 실행해도 안전하다.
-- 표는 모두 t08 스키마에 만든다 (src/db.js가 search_path를 t08로 고정). T06(public)·T07(t07) 표와 섞이지 않는다.
--
-- 이 서비스에는 비밀번호가 없다. 사람을 알아보는 것은 패스키(WebAuthn)뿐이고, 서버는 공개키만 저장한다.

-- 계정. 아이디는 화면에 보일 이름일 뿐 비밀이 아니다. 비밀번호 칸은 없다.
-- webauthn_user_id: 패스키 안에 함께 저장되는 무작위 사용자 핸들(32바이트). 실명·아이디를 패스키에 넣지 않으려고 따로 둔다.
create table if not exists users (
  id                bigint generated always as identity primary key,
  username          text not null check (username ~ '^[a-z0-9_]{3,30}$'),
  webauthn_user_id  bytea not null check (octet_length(webauthn_user_id) = 32),
  created_at        timestamptz not null default now()
);
create unique index if not exists users_username_key on users (username);
create unique index if not exists users_webauthn_user_id_key on users (webauthn_user_id);

-- 패스키. 서버에 저장되는 것은 공개키(COSE 형식)와 그 키를 알아보는 ID뿐이다. 개인키는 기기 밖으로 나오지 않는다.
--   credential_id: 인증기가 만든 키 ID (base64url)
--   public_key:    COSE_Key 바이트. EC2(P-256)라면 kty·alg·crv·x·y만 있고 개인키 d는 없다.
--   sign_count:    인증기가 서명할 때마다 올리는 숫자 (0으로 고정해 보내는 인증기도 있다)
--   device_type:   singleDevice(그 기기·보안 키에만) / multiDevice(동기화 패스키, 예: Google 비밀번호 관리자·iCloud 키체인)
create table if not exists credentials (
  id             bigint generated always as identity primary key,
  user_id        bigint not null references users(id) on delete cascade,
  credential_id  text not null check (credential_id ~ '^[A-Za-z0-9_-]+$' and char_length(credential_id) between 16 and 1366),
  public_key     bytea not null,
  sign_count     bigint not null default 0 check (sign_count >= 0),
  transports     text[] not null default '{}',
  device_type    text not null check (device_type in ('singleDevice', 'multiDevice')),
  backed_up      boolean not null,
  aaguid         text not null,
  name           text not null check (char_length(name) between 1 and 40),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);
create unique index if not exists credentials_credential_id_key on credentials (credential_id);
create index if not exists credentials_user_idx on credentials (user_id);

-- 일회용 질문(challenge). 서버가 만들어 보내고, 답이 올 때까지 여기 보관한다.
--   * 브라우저에는 질문 값과 함께 이 줄을 가리키는 무작위 표(쿠키 t08_ch)를 준다. DB에는 그 표의 SHA-256만 둔다.
--   * 답이 오면 used_at을 적으면서 꺼낸다 (한 문장으로 꺼내므로 같은 질문은 두 번 통과할 수 없다).
--   * 서명 검사에 실패해도 이미 꺼낸 질문은 되살리지 않는다.
--   * 5분이 지나면 쓸 수 없다.
create table if not exists challenges (
  id               bigint generated always as identity primary key,
  ticket_hash      bytea not null,
  purpose          text not null check (purpose in ('signup', 'add', 'login')),
  challenge        text not null,
  user_id          bigint references users(id) on delete cascade,
  pending_username text,
  pending_user_id  bytea,
  pending_name     text,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  created_at       timestamptz not null default now()
);
create unique index if not exists challenges_ticket_key on challenges (ticket_hash);

-- 로그인 세션. 쿠키(t08_sid)에는 무작위 토큰, DB에는 그 SHA-256만 둔다 (T07과 같은 방식).
create table if not exists sessions (
  id           bigint generated always as identity primary key,
  user_id      bigint not null references users(id) on delete cascade,
  token_hash   bytea not null,
  credential_id bigint references credentials(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create unique index if not exists sessions_token_key on sessions (token_hash);

-- 나만 보는 자리의 항목. 모든 조회·수정은 user_id = 세션의 사람 조건으로만 한다.
create table if not exists private_items (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references users(id) on delete cascade,
  kind        text not null check (kind in ('project', 'apply', 'retro')),
  title       text not null check (char_length(title) between 1 and 80),
  body        text not null default '' check (char_length(body) <= 1000),
  created_at  timestamptz not null default now()
);
create index if not exists private_items_user_idx on private_items (user_id, id);
