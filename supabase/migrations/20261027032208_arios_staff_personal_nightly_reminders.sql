-- Assignment-only personal nightly reminders for active staff. Storage and scheduler credentials remain private.
-- Acknowledged/uncertain sends are immutable, preserving one-message-per-person/night delivery.
alter table public.arios_reminders drop constraint if exists arios_reminders_task_count_check;
alter table public.arios_reminders add constraint arios_reminders_task_count_check check (task_count between 1 and 30000);

create or replace function public.arios_reminders_enqueue(p_target_date date, p_entries jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare item jsonb; changed integer := 0;
begin
  if p_target_date is null or p_target_date <> (clock_timestamp() at time zone 'Asia/Tehran')::date + 1
     or p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 1000
    then raise exception 'Invalid reminder batch' using errcode='22023'; end if;
  for item in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(item) <> 'object' or jsonb_typeof(item->'userId') is distinct from 'string'
       or length(item->>'userId') not between 1 and 120
       or jsonb_typeof(item->'chatId') is distinct from 'string' or (item->>'chatId') !~ '^[0-9]{1,20}$'
       or jsonb_typeof(item->'body') is distinct from 'string' or length(item->>'body') not between 1 and 3900
       or jsonb_typeof(item->'taskCount') is distinct from 'number' or (item->>'taskCount') !~ '^[0-9]{1,5}$'
       or (item->>'taskCount')::integer not between 1 and 30000
      then raise exception 'Invalid reminder entry' using errcode='22023'; end if;
    if not exists (select 1 from public.arios_state s, jsonb_array_elements(s.data->'users') u
       join public.arios_telegram_links l on l.user_id=u->>'id'
       where s.id=1 and u->>'id'=item->>'userId' and u->>'role' in ('manager','worker','warehouse','accountant')
         and coalesce(u->>'deletedAt','')='' and l.chat_id=item->>'chatId'
         and l.telegram_user_id=l.chat_id and exists(select 1 from jsonb_array_elements(s.data->'projects') p
           cross join lateral jsonb_array_elements(case when jsonb_typeof(p->'tasks')='array' then p->'tasks' else '[]'::jsonb end) t
           where coalesce(p->>'archivedAt','')='' and coalesce(p->>'status','')<>'completed'
             and (u->>'role'='manager' or coalesce(p->'memberIds','[]'::jsonb) @> jsonb_build_array(u->>'id'))
             and coalesce(t->>'archivedAt','')='' and t->>'assigneeId'=u->>'id'
             and t->>'dueDate'=p_target_date::text and t->>'status' in ('open','in_progress')))
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
      and (not exists(select 1 from jsonb_array_elements(p_entries) e where e->>'userId'=r.user_id)
        or not exists(select 1 from public.arios_state s, jsonb_array_elements(s.data->'users') u
          join public.arios_telegram_links l on l.user_id=u->>'id'
          where s.id=1 and u->>'id'=r.user_id and u->>'role' in ('manager','worker','warehouse','accountant')
            and coalesce(u->>'deletedAt','')='' and l.chat_id=r.chat_id and l.telegram_user_id=l.chat_id and exists(select 1 from jsonb_array_elements(s.data->'projects') p
           cross join lateral jsonb_array_elements(case when jsonb_typeof(p->'tasks')='array' then p->'tasks' else '[]'::jsonb end) t
           where coalesce(p->>'archivedAt','')='' and coalesce(p->>'status','')<>'completed'
             and (u->>'role'='manager' or coalesce(p->'memberIds','[]'::jsonb) @> jsonb_build_array(u->>'id'))
             and coalesce(t->>'archivedAt','')='' and t->>'assigneeId'=u->>'id'
             and t->>'dueDate'=p_target_date::text and t->>'status' in ('open','in_progress'))));
  return changed;
end;
$$;
revoke all on function public.arios_reminders_enqueue(date,jsonb) from public,anon,authenticated;
grant execute on function public.arios_reminders_enqueue(date,jsonb) to service_role;

-- Code creation/consumption supports staff notifications without granting voice/AI access.
create or replace function public.arios_link_code_create(p_code_hash text, p_user_id text, p_expires_at bigint)
returns void language plpgsql security invoker set search_path = '' as $$
declare current_ms bigint; snapshot jsonb;
begin
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  if p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$'
    or p_user_id is null or length(p_user_id) not between 1 and 120
    or p_expires_at is null or p_expires_at <= current_ms or p_expires_at > current_ms + 900000
    then raise exception 'Invalid link code' using errcode = '22023'; end if;
  select data into snapshot from public.arios_state where id = 1 for share;
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  if p_expires_at <= current_ms then raise exception 'Expired link code' using errcode = '22023'; end if;
  if not exists (select 1 from jsonb_array_elements(snapshot->'users') u
    where u->>'id' = p_user_id and u->>'role' in ('manager','worker','warehouse','accountant') and u->>'deletedAt' is null)
    then raise exception 'Active Telegram member required' using errcode = '22023'; end if;
  insert into public.arios_link_codes (code_hash,user_id,expires_at) values (p_code_hash,p_user_id,p_expires_at)
    on conflict (user_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
end;
$$;

create or replace function public.arios_link_code_consume(p_code_hash text, p_telegram_user_id text, p_chat_id text)
returns setof public.arios_telegram_links language plpgsql security invoker set search_path = '' as $$
declare link_code public.arios_link_codes; current_ms bigint; snapshot jsonb;
begin
  if p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$'
    or p_telegram_user_id is null or p_telegram_user_id !~ '^[1-9][0-9]{0,18}$'
    or p_chat_id is distinct from p_telegram_user_id
    then return; end if;
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  -- Always lock state before code rows, matching code creation and archival.
  select data into snapshot from public.arios_state where id = 1 for share;
  select * into link_code from public.arios_link_codes where code_hash = p_code_hash for update;
  current_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  if not found or link_code.expires_at <= current_ms then return; end if;
  -- This read lock makes the active-account check and consumption atomic with
  -- archival/role edits, which update the same singleton state row.
  if not exists (select 1 from jsonb_array_elements(snapshot->'users') u
    where u->>'id' = link_code.user_id and u->>'role' in ('manager','worker','warehouse','accountant') and u->>'deletedAt' is null)
    then return; end if;
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

revoke all on function public.arios_link_code_create(text,text,bigint), public.arios_link_code_consume(text,text,text) from public, anon, authenticated;
grant execute on function public.arios_link_code_create(text,text,bigint), public.arios_link_code_consume(text,text,text) to service_role;
