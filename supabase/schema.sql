-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- All access goes through the Node API using the secret key. RLS is ON with NO policies,
-- so the publishable key (and anyone holding it) can read and write nothing.

create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  uid text unique not null,                         -- Firebase UID (never sent to other users)
  email text,
  display_name text not null check (char_length(display_name) between 1 and 30),
  dob date not null,                                -- private; others never see it
  galaxy text not null default 'night' check (char_length(galaxy) between 1 and 24),
  role text not null default 'user' check (role in ('user','admin')),
  status text not null default 'active' check (status in ('active','suspended','banned')),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists profiles_status_idx on profiles (status);
create index if not exists profiles_created_idx on profiles (created_at desc);

create table if not exists blocks (
  blocker uuid not null references profiles(id) on delete cascade,
  blocked uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
create index if not exists blocks_blocked_idx on blocks (blocked);

-- "Keep in touch": one row per person who wants to stay connected. Two rows (A->B and B->A) = a bond.
create table if not exists keeps (
  from_id uuid not null references profiles(id) on delete cascade,
  to_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id),
  check (from_id <> to_id)
);
create index if not exists keeps_to_idx on keeps (to_id);

create table if not exists lanterns (
  id bigserial primary key,
  author uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  galaxy text,
  holder uuid references profiles(id) on delete set null,
  caught_at timestamptz,
  hops int not null default 0,
  status text not null default 'floating' check (status in ('floating','landed','removed')),
  created_at timestamptz not null default now()
);
create index if not exists lanterns_float_idx on lanterns (status, holder, created_at desc);
create index if not exists lanterns_author_idx on lanterns (author, created_at desc);
create index if not exists lanterns_holder_idx on lanterns (holder) where holder is not null;

create table if not exists lantern_seen (
  lantern_id bigint not null references lanterns(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (lantern_id, user_id)
);
create index if not exists lantern_seen_user_idx on lantern_seen (user_id, seen_at desc);

create table if not exists lantern_replies (
  id bigserial primary key,
  lantern_id bigint not null references lanterns(id) on delete cascade,
  from_id uuid not null references profiles(id) on delete cascade,
  to_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 400),
  created_at timestamptz not null default now()
);
create index if not exists lantern_replies_to_idx on lantern_replies (to_id, created_at desc);

create table if not exists reports (
  id bigserial primary key,
  reporter uuid references profiles(id) on delete set null,
  reported uuid not null references profiles(id) on delete cascade,
  kind text not null default 'light' check (kind in ('light','planet','lantern','thought')),
  lantern_id bigint references lanterns(id) on delete set null,
  reason text not null,
  details text not null default '',
  evidence jsonb,                                   -- captured by the server at report time, never by the client
  status text not null default 'open' check (status in ('open','reviewing','actioned','dismissed')),
  created_at timestamptz not null default now(),
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz
);
create index if not exists reports_status_idx on reports (status, created_at desc);
create index if not exists reports_reported_idx on reports (reported, status);

create table if not exists planet_sessions (
  id bigserial primary key,
  duration_s int not null,
  msgs int not null default 0,
  kept boolean not null default false,
  ended_at timestamptz not null default now()
);
create index if not exists planet_sessions_ended_idx on planet_sessions (ended_at desc);

-- one row per person per day they were in the sky (powers retention numbers in the admin app)
create table if not exists daily_activity (
  profile_id uuid not null references profiles(id) on delete cascade,
  day date not null,
  primary key (profile_id, day)
);
create index if not exists daily_activity_day_idx on daily_activity (day);

create table if not exists app_settings (
  key text primary key,
  value text not null default '',
  is_secret boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);

create table if not exists audit_logs (
  id bigserial primary key,
  admin_id uuid references profiles(id) on delete set null,
  action text not null,
  target text,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on audit_logs (created_at desc);

alter table profiles enable row level security;
alter table blocks enable row level security;
alter table keeps enable row level security;
alter table lanterns enable row level security;
alter table lantern_seen enable row level security;
alter table lantern_replies enable row level security;
alter table reports enable row level security;
alter table planet_sessions enable row level security;
alter table daily_activity enable row level security;
alter table app_settings enable row level security;
alter table audit_logs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
