-- Callback details are private operational records, never a public gallery or AI context.
create table public.arios_leads (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  name text not null default '' check (char_length(name) <= 120),
  message text not null default '' check (char_length(message) <= 1200),
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  source text not null default 'public_chat' check (source = 'public_chat'),
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index arios_leads_created_at_idx on public.arios_leads (created_at desc);
alter table public.arios_leads enable row level security;
revoke all on table public.arios_leads from public, anon, authenticated;
grant select, insert, update, delete on table public.arios_leads to service_role;
