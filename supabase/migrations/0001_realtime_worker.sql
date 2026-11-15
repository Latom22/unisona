-- Columns the realtime worker reads and writes. Written to be additive and
-- idempotent: if your tables already exist, only missing columns are added.
-- Review against your existing schema before applying.

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text,
  created_at timestamptz not null default now()
);
alter table organizations add column if not exists faith_type text;          -- e.g. 'christian', 'islam', 'jewish'
alter table organizations add column if not exists tradition text;           -- e.g. 'Catholic', 'Sunni', 'Reform'
alter table organizations add column if not exists stripe_customer_id text;
alter table organizations add column if not exists do_not_translate text[] default '{}';

create table if not exists org_members (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member',
  primary key (org_id, user_id)
);

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text,
  created_at timestamptz not null default now()
);
alter table rooms add column if not exists listen_code text;
alter table rooms add column if not exists source_lang text not null default 'en';
alter table rooms add column if not exists target_langs text[] default '{}';   -- empty = any language
alter table rooms add column if not exists recitation_matching boolean;        -- null = auto (faith_type)
create unique index if not exists rooms_listen_code_key on rooms (upper(listen_code));

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  started_by uuid references auth.users(id),
  source_lang text not null,
  status text not null default 'live',               -- live | ended
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
alter table sessions add column if not exists machine_id text;
alter table sessions add column if not exists heartbeat_at timestamptz;
alter table sessions add column if not exists end_reason text;
alter table sessions add column if not exists total_speaking_seconds integer;
alter table sessions add column if not exists usage_reported_at timestamptz;
create index if not exists sessions_room_live_idx on sessions (room_id) where status = 'live';
create index if not exists sessions_usage_unreported_idx on sessions (ended_at) where status = 'ended' and usage_reported_at is null;

create table if not exists segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  seq integer not null,
  source_lang text not null,
  text text not null,
  start_ms integer,
  end_ms integer,
  kind text not null default 'speech',               -- speech | recitation
  scripture_ref text,
  translations jsonb not null default '{}'::jsonb,   -- { "es": "...", "fr": "..." }
  created_at timestamptz not null default now(),
  unique (session_id, seq)
);

create table if not exists glossary_terms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  term text not null,
  translations jsonb not null default '{}'::jsonb,   -- { "es": "Eucaristía" }
  do_not_translate boolean not null default false,
  boost real,                                        -- STT keyword boost (nova-2); nova-3 uses keyterms
  created_at timestamptz not null default now()
);
create index if not exists glossary_terms_org_idx on glossary_terms (org_id);

create table if not exists scripture_texts (
  id bigserial primary key,
  tradition text not null,           -- 'bible' | 'quran' | 'tanakh' ...
  ref text not null,                 -- canonical display ref, e.g. 'John 3:16', 'Quran 2:255'
  book text not null,                -- canonical English book name ('Quran' for the Quran)
  chapter integer not null,
  verse integer not null,
  lang text not null,
  text text not null,
  translation_name text,             -- e.g. 'ESV', 'Saheeh International'
  is_approved boolean not null default false  -- Quran: only approved translations replace MT
);
create index if not exists scripture_lookup_idx on scripture_texts (lower(book), chapter, verse, lang);
create index if not exists scripture_tradition_lang_idx on scripture_texts (tradition, lang);

create table if not exists usage_events (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  lang text not null,
  kind text not null,                -- transcription | translation | tts
  seconds numeric(10,2) not null,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_session_idx on usage_events (session_id);
create index if not exists usage_events_org_time_idx on usage_events (org_id, created_at);
