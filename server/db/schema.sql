create extension if not exists vector;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  nickname text not null,
  created_at timestamptz not null default now()
);

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
  explanation text,
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
  question_id uuid references questions(id) on delete cascade,
  user_answer text not null,
  result jsonb,
  created_at timestamptz not null default now()
);

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
