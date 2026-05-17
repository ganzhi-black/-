create extension if not exists vector;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  password_hash text,
  nickname text not null,
  created_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  user_agent text,
  ip_address text,
  created_at timestamptz not null default now()
);

create index if not exists auth_sessions_user_idx
  on auth_sessions(user_id);

create index if not exists auth_sessions_expires_idx
  on auth_sessions(expires_at);

create table if not exists subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  file_name text not null,
  mime_type text,
  file_size integer,
  text_length integer,
  content_hash text,
  created_at timestamptz not null default now()
);

create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  chunk_index integer not null,
  chunk_text text not null,
  token_estimate integer,
  embedding vector(1536),
  created_at timestamptz not null default now()
);

create index if not exists document_chunks_subject_idx
  on document_chunks(subject_id);

create index if not exists document_chunks_embedding_idx
  on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  type text not null,
  title text not null,
  options jsonb,
  correct_answer text,
  key_points text[] not null default '{}',
  explanation text,
  evidence_quote text,
  source_chunk_ids uuid[] not null default '{}',
  document_hash text,
  created_at timestamptz not null default now()
);

create index if not exists documents_content_hash_idx
  on documents(content_hash);

create index if not exists questions_document_hash_idx
  on questions(document_hash);

create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  session_id text,
  subject_id uuid references subjects(id) on delete cascade,
  question_id uuid references questions(id) on delete cascade,
  user_answer text not null,
  is_correct boolean,
  accuracy numeric,
  result jsonb,
  created_at timestamptz not null default now()
);

create table if not exists practice_sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  subject_id uuid not null references subjects(id) on delete cascade,
  mode text not null default 'relaxed',
  question_types text[] not null default '{}',
  question_ids uuid[] not null default '{}',
  question_count integer not null default 0,
  answered_count integer not null default 0,
  skipped_count integer not null default 0,
  correct_count integer not null default 0,
  wrong_count integer not null default 0,
  accuracy_rate integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists practice_sessions_user_idx
  on practice_sessions(user_id, started_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'answers_session_fk'
  ) then
    alter table answers
      add constraint answers_session_fk
      foreign key (session_id) references practice_sessions(id) on delete cascade;
  end if;
end $$;

create table if not exists mistakes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade,
  subject_id uuid references subjects(id) on delete cascade,
  question_id uuid references questions(id) on delete cascade,
  last_answer_id uuid references answers(id) on delete set null,
  attempts integer not null default 1,
  updated_at timestamptz not null default now(),
  unique(user_id, question_id)
);

create table if not exists analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  session_id text,
  event_name text not null,
  page_path text,
  properties jsonb not null default '{}',
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_created_idx
  on analytics_events(created_at desc);

create index if not exists analytics_events_name_idx
  on analytics_events(event_name, created_at desc);

create table if not exists daily_metrics (
  metric_date date not null,
  metric_name text not null,
  metric_value numeric not null default 0,
  properties jsonb not null default '{}',
  primary key (metric_date, metric_name, properties)
);
