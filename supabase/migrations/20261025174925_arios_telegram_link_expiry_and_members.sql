-- Expiry remains epoch milliseconds. Link credentials are one-use, member-scoped
-- and revoked by an archived account without exposing any browser table policy.
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
    where u->>'id' = p_user_id and u->>'role' in ('manager','worker') and u->>'deletedAt' is null)
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
    where u->>'id' = link_code.user_id and u->>'role' in ('manager','worker') and u->>'deletedAt' is null)
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
