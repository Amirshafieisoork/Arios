-- Server-only outbox: one acknowledged Telegram message per worker and work date.
create table public.arios_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  target_date date not null,
  chat_id text not null check (chat_id ~ '^[0-9]{1,20}$'),
  body text not null check (char_length(body) between 1 and 3900),
  task_count integer not null check (task_count between 1 and 30000),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','unknown','cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  claim text,
  lease_until bigint not null default 0,
  error_code text check (error_code is null or error_code ~ '^[A-Z_]{1,80}$'),
  message_id text,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, target_date)
);
create index arios_reminders_pending_idx on public.arios_reminders (target_date,next_attempt_at) where status='pending';
alter table public.arios_reminders enable row level security;
revoke all on public.arios_reminders from public, anon, authenticated;
grant select, insert, update, delete on public.arios_reminders to service_role;

create function public.arios_reminders_enqueue(p_target_date date, p_entries jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare item jsonb; changed integer := 0;
begin
  if p_target_date <> (clock_timestamp() at time zone 'Asia/Tehran')::date + 1
     or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 1000
    then raise exception 'Invalid reminder batch' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(p_entries) loop
    if not exists (select 1 from public.arios_state s, jsonb_array_elements(s.data->'users') u
       join public.arios_telegram_links l on l.user_id=u->>'id'
       where s.id=1 and u->>'id'=item->>'userId' and u->>'role'='worker'
         and coalesce(u->>'deletedAt','')='' and l.chat_id=item->>'chatId'
         and l.telegram_user_id=l.chat_id)
      then continue; end if;
    insert into public.arios_reminders(user_id,target_date,chat_id,body,task_count)
      values(item->>'userId',p_target_date,item->>'chatId',item->>'body',(item->>'taskCount')::integer)
      on conflict(user_id,target_date) do update set chat_id=excluded.chat_id,body=excluded.body,
        task_count=excluded.task_count,status='pending',updated_at=now()
        where arios_reminders.status in ('pending','cancelled');
    changed := changed + 1;
  end loop;
  update public.arios_reminders r set status='cancelled',error_code='ASSIGNMENT_OR_LINK_CHANGED',updated_at=now()
    where r.target_date=p_target_date and r.status='pending'
      and not exists(select 1 from jsonb_array_elements(p_entries) e where e->>'userId'=r.user_id);
  return changed;
end;
$$;

create function public.arios_reminder_claim(p_target_date date,p_claim text,p_lease_ms integer default 120000)
returns setof public.arios_reminders language plpgsql security invoker set search_path = '' as $$
declare selected_id uuid; current_ms bigint;
begin
  if p_claim !~ '^[0-9a-f-]{36}$' or p_lease_ms not between 30000 and 180000
    then raise exception 'Invalid reminder claim' using errcode='22023'; end if;
  current_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  -- The prior process may have sent before losing its acknowledgement. Never reclaim that send.
  update public.arios_reminders set status='unknown',error_code='TELEGRAM_DELIVERY_UNCERTAIN',
    claim=null,lease_until=0,updated_at=now() where status='sending' and lease_until<current_ms;
  update public.arios_reminders set status='failed',error_code='TELEGRAM_RETRY_LIMIT',updated_at=now()
    where target_date=p_target_date and status='pending' and attempts>=3;
  select id into selected_id from public.arios_reminders
    where target_date=p_target_date and status='pending' and next_attempt_at<=now() and attempts<3
    order by created_at,id for update skip locked limit 1;
  if selected_id is null then return; end if;
  return query update public.arios_reminders set status='sending',claim=p_claim,
    lease_until=current_ms+p_lease_ms,attempts=attempts+1,updated_at=now()
    where id=selected_id returning *;
end;
$$;

create function public.arios_reminder_finish(p_id uuid,p_claim text,p_status text,p_error_code text default null,p_message_id text default null,p_retry_after_ms integer default 0)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if p_status not in ('pending','sent','failed','unknown','cancelled')
     or (p_status='pending' and (p_error_code is distinct from 'TELEGRAM_RATE_LIMITED' or p_retry_after_ms not between 60000 and 3600000))
     or (p_status='sent' and (p_message_id is null or p_message_id !~ '^[0-9]{1,30}$'))
    then raise exception 'Invalid reminder outcome' using errcode='22023'; end if;
  update public.arios_reminders set
    status=case when p_status='pending' and attempts>=3 then 'failed' else p_status end,
    error_code=case when p_status='pending' and attempts>=3 then 'TELEGRAM_RETRY_LIMIT' else p_error_code end,
    message_id=p_message_id,sent_at=case when p_status='sent' then now() else null end,
    next_attempt_at=case when p_status='pending' then now()+p_retry_after_ms*interval '1 millisecond' else next_attempt_at end,
    claim=null,lease_until=0,updated_at=now()
    where id=p_id and status='sending' and claim=p_claim;
  get diagnostics affected=row_count;
  return affected=1;
end;
$$;
revoke all on function public.arios_reminders_enqueue(date,jsonb), public.arios_reminder_claim(date,text,integer), public.arios_reminder_finish(uuid,text,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.arios_reminders_enqueue(date,jsonb), public.arios_reminder_claim(date,text,integer), public.arios_reminder_finish(uuid,text,text,text,text,integer) to service_role;

-- Vault is already supported by hosted Supabase. Raw scheduler credentials never leave the database.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create schema if not exists arios_private;
revoke all on schema arios_private from public,anon,authenticated;

do $$
declare token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name='arios_telegram_scheduler_token' limit 1;
  if token is null then
    token := encode(extensions.gen_random_bytes(32),'hex');
    perform vault.create_secret(token,'arios_telegram_scheduler_token','Arios scheduler request authentication');
  end if;
  insert into public.arios_settings(key,value)
    values('telegram_scheduler_auth_hash',to_jsonb(encode(extensions.digest(token,'sha256'),'hex')))
    on conflict(key) do update set value=excluded.value;
  insert into public.arios_settings(key,value)
    values('telegram_reminders','{"enabled":true,"time":"21:00","timezone":"Asia/Tehran"}'::jsonb)
    on conflict(key) do nothing;
end;
$$;

create function arios_private.invoke_telegram_tick()
returns void language plpgsql security invoker set search_path = '' as $$
declare token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name='arios_telegram_scheduler_token' limit 1;
  if token is null then raise exception 'Scheduler credential unavailable'; end if;
  perform net.http_post(
    url:='https://qategfabulrkvdckzmqp.supabase.co/functions/v1/arios-api/internal/telegram-tick',
    body:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','x-arios-scheduler-token',token),
    timeout_milliseconds:=90000
  );
end;
$$;
revoke all on function arios_private.invoke_telegram_tick() from public,anon,authenticated,service_role;
-- A single lightweight tick receives /start even with browsers closed; sends occur only 21:00–21:59 Tehran.
select cron.schedule('arios-telegram-tick','*/2 * * * *','select arios_private.invoke_telegram_tick();');
