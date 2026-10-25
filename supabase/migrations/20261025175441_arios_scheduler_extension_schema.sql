-- Keep the scheduler's transport extension outside exposed application schemas.
-- This extension was introduced by the immediately preceding scheduler migration.
set local lock_timeout = '3s';
do $$
begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_net' and n.nspname='public') then
    lock table net.http_request_queue in access exclusive mode;
    if exists (select 1 from net.http_request_queue) then
      raise exception 'Wait for the scheduler transport queue to drain';
    end if;
    -- No CASCADE: external dependencies must block rather than be removed.
    drop extension pg_net;
    create extension pg_net with schema extensions version '0.20.4';
  end if;
end;
$$;
-- Requests contain the scheduler's private authentication header while queued.
-- Only the database-owned dispatcher and worker may access transport tables.
revoke all on net.http_request_queue, net._http_response from public, anon, authenticated;
