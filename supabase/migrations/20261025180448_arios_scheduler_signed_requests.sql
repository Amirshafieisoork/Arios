-- Transport queues are managed by Supabase and can have platform-owned grants.
-- Never put a persistent scheduler credential in an outbound request header.
do $$
declare signing_key text;
begin
  select decrypted_secret into signing_key from vault.decrypted_secrets
    where name='arios_telegram_scheduler_signing_key' limit 1;
  if signing_key is null then
    signing_key := encode(extensions.gen_random_bytes(32),'hex');
    perform vault.create_secret(signing_key,'arios_telegram_scheduler_signing_key','Arios one-use scheduler request signatures');
  end if;
  if signing_key !~ '^[a-f0-9]{64}$' then raise exception 'Invalid scheduler signing key'; end if;
  insert into public.arios_settings(key,value)
    values('telegram_scheduler_signing_key',to_jsonb(signing_key))
    on conflict(key) do update set value=excluded.value;
  delete from public.arios_settings where key='telegram_scheduler_auth_hash';
end;
$$;

create or replace function arios_private.invoke_telegram_tick()
returns void language plpgsql security invoker set search_path = '' as $$
declare signing_key text; issued_at text; nonce text; signature text;
begin
  select decrypted_secret into signing_key from vault.decrypted_secrets
    where name='arios_telegram_scheduler_signing_key' limit 1;
  if signing_key is null then raise exception 'Scheduler credential unavailable'; end if;
  -- Expired one-use markers stay only until the next scheduled tick.
  delete from public.arios_locks where name like 'telegram-scheduler-nonce:%'
    and expires_at < floor(extract(epoch from clock_timestamp())*1000)::bigint;
  issued_at := floor(extract(epoch from clock_timestamp()))::bigint::text;
  nonce := encode(extensions.gen_random_bytes(16),'hex');
  signature := encode(extensions.hmac(
    E'POST\n/api/internal/telegram-tick\n' || issued_at || E'\n' || nonce,
    signing_key,'sha256'),'hex');
  perform net.http_post(
    url:='https://qategfabulrkvdckzmqp.supabase.co/functions/v1/arios-api/internal/telegram-tick',
    body:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json',
      'x-arios-scheduler-timestamp',issued_at,
      'x-arios-scheduler-nonce',nonce,
      'x-arios-scheduler-signature',signature),
    timeout_milliseconds:=90000
  );
end;
$$;
revoke all on function arios_private.invoke_telegram_tick() from public,anon,authenticated,service_role;
