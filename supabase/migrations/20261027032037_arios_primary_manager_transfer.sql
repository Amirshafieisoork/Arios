-- Primary ownership and the promoted login profile commit together; no customer/client role may call this RPC.
-- Auth identity columns are server-only and rechecked at commit time, in addition to the Auth Admin check.
grant usage on schema auth to service_role;
grant select (id, deleted_at, banned_until) on auth.users to service_role;

create or replace function public.arios_primary_manager_transfer(
  p_expected_revision bigint,
  p_state jsonb,
  p_actor_domain_user_id text,
  p_target_domain_user_id text,
  p_target_auth_user_id uuid,
  p_expected_primary_id text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  current_state jsonb; current_revision bigint; current_primary text; current_version bigint;
  actor_before jsonb; target_before jsonb; next_users jsonb; expected_state jsonb;
  actor_auth uuid; actor_profile_role text; target_profile_role text; target_auth uuid;
  next_transfer jsonb; transfer_request text; next_audit jsonb; old_audit jsonb; event jsonb; audit_count integer;
  active_identity boolean; changed integer;
begin
  if p_expected_revision is null or p_expected_revision < 0 or p_state is null or jsonb_typeof(p_state) <> 'object'
    or p_actor_domain_user_id is null or p_target_domain_user_id is null or p_target_auth_user_id is null
    or p_actor_domain_user_id = '' or p_target_domain_user_id = ''
    or length(p_actor_domain_user_id) > 120 or length(p_target_domain_user_id) > 120
    or p_actor_domain_user_id = p_target_domain_user_id
    or p_expected_primary_id is distinct from p_actor_domain_user_id
    then raise exception 'Invalid primary manager transfer' using errcode = '22023'; end if;

  -- Match the profile-before-state lock order of arios_account_update to avoid lock inversion.
  perform 1 from public.arios_profiles
    where domain_user_id in (p_actor_domain_user_id,p_target_domain_user_id)
    order by domain_user_id for update;
  select data,revision into current_state,current_revision from public.arios_state where id=1 for update;
  if not found or current_revision <> p_expected_revision then return false; end if;
  if jsonb_typeof(current_state->'users') is distinct from 'array'
    or jsonb_typeof(current_state->'audit') is distinct from 'array'
    or (select count(*) from jsonb_array_elements(current_state->'users') u where u->>'id'=p_actor_domain_user_id) <> 1
    or (select count(*) from jsonb_array_elements(current_state->'users') u where u->>'id'=p_target_domain_user_id) <> 1
    then raise exception 'Invalid manager state' using errcode='22023'; end if;
  select u into actor_before from jsonb_array_elements(current_state->'users') u where u->>'id'=p_actor_domain_user_id;
  select u into target_before from jsonb_array_elements(current_state->'users') u where u->>'id'=p_target_domain_user_id;
  if actor_before->>'role' is distinct from 'manager' or coalesce(actor_before->>'deletedAt','') <> ''
    or coalesce(target_before->>'role','') not in ('manager','worker','warehouse','accountant')
    or coalesce(target_before->>'deletedAt','') <> ''
    then raise exception 'Active staff accounts are required' using errcode='22023'; end if;
  if current_state ? 'primaryManagerId' then
    current_primary=current_state->>'primaryManagerId';
  else
    select u->>'id' into current_primary from jsonb_array_elements(current_state->'users') with ordinality as x(u,position)
      where u->>'role'='manager' and coalesce(u->>'deletedAt','')=''
      order by (u->>'id'='manager') desc,position asc limit 1;
  end if;
  if current_primary is distinct from p_expected_primary_id then return false; end if;
  if current_state ? 'primaryManagerVersion' then
    if jsonb_typeof(current_state->'primaryManagerVersion') <> 'number'
      or (current_state->>'primaryManagerVersion')::numeric < 0
      or (current_state->>'primaryManagerVersion')::numeric <> floor((current_state->>'primaryManagerVersion')::numeric)
      or (current_state->>'primaryManagerVersion')::numeric >= 9007199254740991
      then raise exception 'Invalid manager version' using errcode='22023'; end if;
    current_version=(current_state->>'primaryManagerVersion')::bigint;
  else current_version=0;
  end if;

  select auth_user_id,role into actor_auth,actor_profile_role from public.arios_profiles where domain_user_id=p_actor_domain_user_id;
  select auth_user_id,role into target_auth,target_profile_role from public.arios_profiles where domain_user_id=p_target_domain_user_id;
  if actor_auth is null or actor_profile_role is distinct from 'manager'
    or target_auth is distinct from p_target_auth_user_id
    or target_profile_role is distinct from target_before->>'role'
    then return false; end if;
  select exists(select 1 from auth.users where id=target_auth and deleted_at is null
    and (banned_until is null or banned_until<=clock_timestamp())) into active_identity;
  if not active_identity then return false; end if;
  select exists(select 1 from auth.users where id=actor_auth and deleted_at is null
    and (banned_until is null or banned_until<=clock_timestamp())) into active_identity;
  if not active_identity then return false; end if;
  if exists(select 1 from public.arios_settings where key in ('auth-security:'||p_target_domain_user_id,'auth-security:'||p_actor_domain_user_id)
    and value->>'blocked'='true' and (not (value ? 'blockUntil')
      or case when jsonb_typeof(value->'blockUntil')='number' then ((value->>'blockUntil')::numeric=0 or (value->>'blockUntil')::numeric > extract(epoch from clock_timestamp())*1000) else true end))
    then return false; end if;

  next_transfer=p_state->'primaryManagerLastTransfer'; transfer_request=next_transfer->>'requestId';
  if transfer_request is null or transfer_request !~ '^[-a-zA-Z0-9_]{16,100}$'
    or next_transfer is distinct from jsonb_build_object('requestId',transfer_request,'actorId',p_actor_domain_user_id,'targetId',p_target_domain_user_id,'version',current_version+1)
    or p_state->>'primaryManagerId' is distinct from p_target_domain_user_id
    or p_state->'primaryManagerVersion' is distinct from to_jsonb(current_version+1)
    then raise exception 'Invalid manager transfer metadata' using errcode='22023'; end if;
  old_audit=current_state->'audit'; next_audit=p_state->'audit'; audit_count=jsonb_array_length(old_audit);
  if jsonb_typeof(next_audit) is distinct from 'array' or jsonb_array_length(next_audit) <> audit_count+1
    or (next_audit - audit_count) is distinct from old_audit
    then raise exception 'Manager transfer must append its audit event' using errcode='22023'; end if;
  event=next_audit->audit_count;
  if event->>'actorId' is distinct from p_actor_domain_user_id
    or event->>'action' is distinct from 'account.primary-manager.transfer'
    or event->>'entityId' is distinct from p_target_domain_user_id
    or event->>'requestId' is distinct from transfer_request
    or coalesce(event->>'id','') !~ '^[a-fA-F0-9-]{36}$'
    or jsonb_typeof(event->'createdAt') is distinct from 'string'
    or jsonb_typeof(event->'description') is distinct from 'string'
    or length(event->>'description') > 1000
    or (event - array['id','actorId','action','entityId','createdAt','description','requestId']) <> '{}'::jsonb
    then raise exception 'Invalid manager transfer audit event' using errcode='22023'; end if;
  select jsonb_agg(case when u->>'id'=p_actor_domain_user_id then u||jsonb_build_object('managementRole','technical')
    when u->>'id'=p_target_domain_user_id then u||jsonb_build_object('role','manager','managementRole','primary') else u end order by position)
    into next_users from jsonb_array_elements(current_state->'users') with ordinality as x(u,position);
  expected_state=current_state||jsonb_build_object('users',next_users,'primaryManagerId',p_target_domain_user_id,
    'primaryManagerVersion',current_version+1,'primaryManagerLastTransfer',next_transfer,'audit',next_audit);
  if p_state is distinct from expected_state then raise exception 'Unrelated state change in manager transfer' using errcode='22023'; end if;

  update public.arios_state set data=p_state,revision=revision+1 where id=1 and revision=p_expected_revision;
  get diagnostics changed=row_count;
  if changed<>1 then return false; end if;
  update public.arios_profiles set role='manager' where domain_user_id=p_target_domain_user_id and auth_user_id=p_target_auth_user_id;
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Manager profile changed' using errcode='22023'; end if;
  return true;
end;
$$;
revoke all on function public.arios_primary_manager_transfer(bigint,jsonb,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.arios_primary_manager_transfer(bigint,jsonb,text,text,uuid,text) to service_role;
