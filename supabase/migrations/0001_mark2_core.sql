create extension if not exists pgcrypto;

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  role text not null check (role in ('system','user','assistant','tool')),
  content text not null,
  model text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversation_messages_created_idx on conversation_messages(conversation_id, created_at desc);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  memory_type text not null default 'fact',
  content text not null,
  normalized_content text not null,
  content_hash text,
  importance real not null default 0.5 check (importance between 0 and 1),
  confidence real not null default 0.8 check (confidence between 0 and 1),
  source text not null default 'conversation',
  active boolean not null default true,
  superseded_by uuid references memories(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists memories_active_idx on memories(active);
create index if not exists memories_hash_idx on memories(content_hash);
create index if not exists memories_normalized_idx on memories(normalized_content);

create table if not exists model_performance (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model text not null,
  task_type text,
  success boolean not null,
  quality_score real,
  latency_ms integer,
  error_type text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists model_performance_lookup_idx on model_performance(model, task_type, created_at desc);

create table if not exists system_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  severity text not null default 'info',
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists system_events_created_idx on system_events(created_at desc);
