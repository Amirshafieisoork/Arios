-- Independent ARIOS OS application schema. Apply only to the dedicated ARIOS project.
-- End users interact through the authenticated Edge API, never directly with these tables.

create table public.arios_state (
  id integer primary key check (id = 1),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  revision bigint not null default 0 check (revision >= 0)
);
create table public.arios_settings (
  key text primary key check (length(key) between 1 and 255),
  value jsonb not null
);
create table public.arios_profiles (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  domain_user_id text not null unique,
  role text not null check (role in ('manager', 'worker', 'customer')),
  created_at timestamptz not null default now()
);
create table public.arios_drafts (
  id text primary key,
  user_id text not null,
  source text not null check (source in ('telegram', 'upload', 'text')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed', 'submitted')),
  transcript text not null default '',
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  source_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(source_metadata) = 'object'),
  storage_path text,
  error text,
  report_id text,
  file_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claim text,
  claim_until bigint not null default 0
);
create index arios_drafts_user_created on public.arios_drafts (user_id, created_at desc);
create index arios_drafts_queue on public.arios_drafts (source, status, claim_until, created_at);
create table public.arios_telegram_links (
  telegram_user_id text primary key,
  user_id text not null unique,
  chat_id text not null,
  created_at timestamptz not null default now()
);
create table public.arios_link_codes (
  code_hash text primary key,
  user_id text not null unique,
  expires_at bigint not null
);
create index arios_link_codes_expiry on public.arios_link_codes (expires_at);
create table public.arios_telegram_updates (
  update_id bigint primary key check (update_id between 0 and 9007199254740991),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'ignored', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index arios_telegram_updates_pending on public.arios_telegram_updates (update_id) where status = 'pending';
create table public.arios_locks (
  name text primary key,
  token text not null,
  expires_at bigint not null
);
create table public.arios_rate_limits (
  key text primary key,
  window_start bigint not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);

alter table public.arios_state enable row level security;
alter table public.arios_settings enable row level security;
alter table public.arios_profiles enable row level security;
alter table public.arios_drafts enable row level security;
alter table public.arios_telegram_links enable row level security;
alter table public.arios_link_codes enable row level security;
alter table public.arios_telegram_updates enable row level security;
alter table public.arios_locks enable row level security;
alter table public.arios_rate_limits enable row level security;
revoke all on table public.arios_state, public.arios_settings, public.arios_profiles,
  public.arios_drafts, public.arios_telegram_links, public.arios_link_codes,
  public.arios_telegram_updates, public.arios_locks, public.arios_rate_limits
  from public, anon, authenticated;
grant select, insert, update, delete on table public.arios_state, public.arios_settings,
  public.arios_profiles, public.arios_drafts, public.arios_telegram_links,
  public.arios_link_codes, public.arios_telegram_updates, public.arios_locks,
  public.arios_rate_limits to service_role;

create function public.arios_state_cas(p_expected_revision bigint, p_data jsonb)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  if jsonb_typeof(p_data) <> 'object' then raise exception 'Invalid state' using errcode = '22023'; end if;
  update public.arios_state set data = p_data, revision = revision + 1
    where id = 1 and revision = p_expected_revision;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

create function public.arios_bootstrap(p_auth_user_id uuid, p_state jsonb, p_code_hash text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare bootstrap_value jsonb; current_ms bigint; current_state jsonb; manager_domain_id text;
begin
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  select value into bootstrap_value from public.arios_settings where key = 'bootstrap' for update;
  if bootstrap_value is null or bootstrap_value->>'codeHash' is distinct from p_code_hash
    or coalesce((bootstrap_value->>'expiresAt')::bigint, 0) <= current_ms then return false; end if;
  if exists (select 1 from public.arios_profiles where role = 'manager') then return false; end if;
  if coalesce(bootstrap_value->>'ownerEmail','') = '' then return false; end if;
  select data into current_state from public.arios_state where id = 1 for update;
  if not found then
    if jsonb_typeof(p_state) <> 'object' or jsonb_typeof(p_state->'users') <> 'array'
      then raise exception 'Invalid initial state' using errcode = '22023'; end if;
    current_state := p_state;
  end if;
  select u->>'id' into manager_domain_id from jsonb_array_elements(current_state->'users') u
    where u->>'role' = 'manager' and lower(u->>'email') = lower(bootstrap_value->>'ownerEmail') limit 1;
  if manager_domain_id is null then raise exception 'Owner manager not found' using errcode = '22023'; end if;
  insert into public.arios_state (id,data,revision) values (1,current_state,0) on conflict (id) do nothing;
  insert into public.arios_profiles (auth_user_id,domain_user_id,role) values (p_auth_user_id,manager_domain_id,'manager');
  delete from public.arios_settings where key = 'bootstrap';
  return true;
end;
$$;

create function public.arios_account_commit(p_expected_revision bigint, p_state jsonb,
  p_auth_user_id uuid, p_domain_user_id text, p_role text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  if p_role not in ('worker','customer') or not (p_state->'users' @>
    jsonb_build_array(jsonb_build_object('id',p_domain_user_id,'role',p_role)))
    then raise exception 'Invalid account' using errcode = '22023'; end if;
  update public.arios_state set data = p_state, revision = revision + 1
    where id = 1 and revision = p_expected_revision;
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;
  insert into public.arios_profiles (auth_user_id,domain_user_id,role) values (p_auth_user_id,p_domain_user_id,p_role);
  return true;
end;
$$;

create function public.arios_draft_claim(p_id text, p_claim text, p_lease_ms bigint default 300000)
returns setof public.arios_drafts language plpgsql security invoker set search_path = '' as $$
declare current_ms bigint;
begin
  if p_lease_ms < 1000 or p_lease_ms > 900000 or length(p_claim) not between 1 and 128
    then raise exception 'Invalid lease' using errcode = '22023'; end if;
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  return query update public.arios_drafts set status = 'processing', claim = p_claim,
    claim_until = current_ms + p_lease_ms, updated_at = now()
    where id = p_id and (status in ('pending','failed') or (status = 'processing' and claim_until < current_ms))
    returning *;
end;
$$;

create function public.arios_link_code_create(p_code_hash text, p_user_id text, p_expires_at bigint)
returns void language plpgsql security invoker set search_path = '' as $$
declare current_ms bigint;
begin
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  if p_expires_at <= current_ms or p_expires_at > current_ms + 900000 or length(p_code_hash) <> 64
    then raise exception 'Invalid link code' using errcode = '22023'; end if;
  insert into public.arios_link_codes (code_hash,user_id,expires_at) values (p_code_hash,p_user_id,p_expires_at)
    on conflict (user_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
end;
$$;

create function public.arios_link_code_consume(p_code_hash text, p_telegram_user_id text, p_chat_id text)
returns setof public.arios_telegram_links language plpgsql security invoker set search_path = '' as $$
declare link_code public.arios_link_codes; current_ms bigint;
begin
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  select * into link_code from public.arios_link_codes where code_hash = p_code_hash for update;
  if not found or link_code.expires_at <= current_ms then return; end if;
  if not exists (select 1 from public.arios_state s, jsonb_array_elements(s.data->'users') u
    where s.id = 1 and u->>'id' = link_code.user_id and u->>'role' in ('manager','worker')) then return; end if;
  if exists (select 1 from public.arios_telegram_links where telegram_user_id = p_telegram_user_id and user_id <> link_code.user_id)
    or exists (select 1 from public.arios_telegram_links where user_id = link_code.user_id and telegram_user_id <> p_telegram_user_id)
    then raise exception 'Telegram account already linked' using errcode = '23505'; end if;
  insert into public.arios_telegram_links (telegram_user_id,user_id,chat_id)
    values (p_telegram_user_id,link_code.user_id,p_chat_id)
    on conflict (telegram_user_id) do update set chat_id = excluded.chat_id;
  delete from public.arios_link_codes where user_id = link_code.user_id;
  return query select * from public.arios_telegram_links where telegram_user_id = p_telegram_user_id;
end;
$$;

create function public.arios_telegram_unlink(p_user_id text)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.arios_link_codes where user_id = p_user_id;
  delete from public.arios_telegram_links where user_id = p_user_id;
end;
$$;

create function public.arios_updates_ingest(p_updates jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare item jsonb; item_id bigint; max_id bigint := -1; inserted integer := 0; changed integer; next_offset bigint := 0;
begin
  if jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) > 100
    or octet_length(p_updates::text) > 1048576 then raise exception 'Invalid updates' using errcode = '22023'; end if;
  for item in select value from jsonb_array_elements(p_updates) loop
    if jsonb_typeof(item) <> 'object' or (item->>'update_id') !~ '^[0-9]{1,16}$'
      then raise exception 'Invalid update identifier' using errcode = '22023'; end if;
    item_id := (item->>'update_id')::bigint;
    if item_id > 9007199254740991 then raise exception 'Invalid update identifier' using errcode = '22023'; end if;
    insert into public.arios_telegram_updates (update_id,payload) values (item_id,item) on conflict (update_id) do nothing;
    get diagnostics changed = row_count;
    inserted := inserted + changed;
    max_id := greatest(max_id,item_id);
  end loop;
  if max_id >= 0 then
    insert into public.arios_settings (key,value) values ('telegram_offset',to_jsonb(max_id + 1))
      on conflict (key) do update set value = to_jsonb(greatest((public.arios_settings.value #>> '{}')::bigint,max_id + 1));
  end if;
  select coalesce((value #>> '{}')::bigint,0) into next_offset from public.arios_settings where key = 'telegram_offset';
  return jsonb_build_object('inserted',inserted,'offset',coalesce(next_offset,0));
end;
$$;

create function public.arios_lock_acquire(p_name text, p_token text, p_lease_ms bigint)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare current_ms bigint; changed integer;
begin
  if p_lease_ms < 1000 or p_lease_ms > 900000 or length(p_name) not between 1 and 255
    or length(p_token) not between 1 and 128 then raise exception 'Invalid lock' using errcode = '22023'; end if;
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  insert into public.arios_locks (name,token,expires_at) values (p_name,p_token,current_ms + p_lease_ms)
    on conflict (name) do update set token = excluded.token, expires_at = excluded.expires_at
    where public.arios_locks.expires_at < current_ms;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
create function public.arios_lock_release(p_name text, p_token text)
returns void language sql security invoker set search_path = '' as $$
  delete from public.arios_locks where name = p_name and token = p_token;
$$;

create function public.arios_rate_limit(p_key text, p_limit integer, p_window_ms bigint default 60000)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare current_ms bigint; bucket bigint; counter integer;
begin
  if p_limit < 1 or p_limit > 100000 or p_window_ms < 1000 or p_window_ms > 86400000
    or length(p_key) not between 1 and 255 then raise exception 'Invalid rate limit' using errcode = '22023'; end if;
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  bucket := current_ms / p_window_ms;
  insert into public.arios_rate_limits (key,window_start,request_count) values (p_key,bucket,1)
    on conflict (key) do update set window_start = excluded.window_start,
      request_count = case when public.arios_rate_limits.window_start = bucket
        then least(public.arios_rate_limits.request_count + 1,p_limit + 1) else 1 end, updated_at = now()
    returning request_count into counter;
  return jsonb_build_object('allowed',counter <= p_limit,'count',counter,
    'retryAfter',greatest(1,ceil(((bucket + 1) * p_window_ms - current_ms)::numeric / 1000))::integer);
end;
$$;

revoke all on function public.arios_state_cas(bigint,jsonb), public.arios_bootstrap(uuid,jsonb,text),
  public.arios_account_commit(bigint,jsonb,uuid,text,text), public.arios_draft_claim(text,text,bigint),
  public.arios_link_code_create(text,text,bigint), public.arios_link_code_consume(text,text,text),
  public.arios_telegram_unlink(text), public.arios_updates_ingest(jsonb),
  public.arios_lock_acquire(text,text,bigint), public.arios_lock_release(text,text),
  public.arios_rate_limit(text,integer,bigint) from public, anon, authenticated;
grant execute on function public.arios_state_cas(bigint,jsonb), public.arios_bootstrap(uuid,jsonb,text),
  public.arios_account_commit(bigint,jsonb,uuid,text,text), public.arios_draft_claim(text,text,bigint),
  public.arios_link_code_create(text,text,bigint), public.arios_link_code_consume(text,text,text),
  public.arios_telegram_unlink(text), public.arios_updates_ingest(jsonb),
  public.arios_lock_acquire(text,text,bigint), public.arios_lock_release(text,text),
  public.arios_rate_limit(text,integer,bigint) to service_role;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('arios-audio','arios-audio',false,20971520,
  array['audio/ogg','application/ogg','audio/opus','audio/mpeg','audio/mp3','audio/mp4',
    'audio/x-m4a','audio/wav','audio/x-wav','audio/webm','video/webm','audio/flac','audio/x-flac','application/octet-stream'])
on conflict (id) do update set public = false, file_size_limit = 20971520,
  allowed_mime_types = excluded.allowed_mime_types;
-- No storage.objects policies are created for anon/authenticated. Uploads require a scoped signed URL.
