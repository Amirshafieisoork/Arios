-- Proposal only: root must inspect the live constraint/privileges before application.
-- Preserve all profile ids and application history while extending specialist roles.
alter table public.arios_profiles drop constraint if exists arios_profiles_role_check;
alter table public.arios_profiles add constraint arios_profiles_role_check
  check (role in ('manager','worker','customer','warehouse','accountant'));

create or replace function public.arios_account_commit(p_expected_revision bigint, p_state jsonb,
  p_auth_user_id uuid, p_domain_user_id text, p_role text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  if p_role not in ('worker','customer','warehouse','accountant') or not (p_state->'users' @>
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

-- Contact/role/archive edits commit with the protected profile in one transaction.
create or replace function public.arios_account_update(
  p_expected_revision bigint, p_state jsonb, p_auth_user_id uuid,
  p_domain_user_id text, p_role text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare current_role text; changed integer;
begin
  if p_role not in ('manager','worker','customer','warehouse','accountant')
    or jsonb_typeof(p_state) <> 'object'
    or not (p_state->'users' @> jsonb_build_array(jsonb_build_object('id',p_domain_user_id,'role',p_role)))
    then raise exception 'Invalid account update' using errcode = '22023'; end if;
  select role into current_role from public.arios_profiles
    where auth_user_id = p_auth_user_id and domain_user_id = p_domain_user_id for update;
  if not found then raise exception 'Account profile not found' using errcode = '22023'; end if;
  if (current_role = 'manager') is distinct from (p_role = 'manager')
    then raise exception 'Manager role cannot be reassigned here' using errcode = '22023'; end if;
  update public.arios_state set data = p_state, revision = revision + 1
    where id = 1 and revision = p_expected_revision;
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;
  update public.arios_profiles set role = p_role
    where auth_user_id = p_auth_user_id and domain_user_id = p_domain_user_id;
  return true;
end;
$$;

-- Read-only Auth session check. An older refresh session keeps its original id and
-- created_at, so it cannot regain application access after reset/restore.
-- Verify current privileges first; grant only the three columns this RPC reads.
grant usage on schema auth to service_role;
grant select (id,user_id,created_at) on auth.sessions to service_role;
create or replace function public.arios_auth_session_valid(
  p_auth_user_id uuid, p_session_id uuid, p_valid_after timestamptz
)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1 from auth.sessions
    where id = p_session_id and user_id = p_auth_user_id and created_at > p_valid_after
  );
$$;

revoke all on function public.arios_account_commit(bigint,jsonb,uuid,text,text),
  public.arios_account_update(bigint,jsonb,uuid,text,text),
  public.arios_auth_session_valid(uuid,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.arios_account_commit(bigint,jsonb,uuid,text,text),
  public.arios_account_update(bigint,jsonb,uuid,text,text),
  public.arios_auth_session_valid(uuid,uuid,timestamptz) to service_role;
