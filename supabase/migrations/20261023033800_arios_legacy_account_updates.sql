-- Keep contact/role/archive edits available for legacy records without a login.
-- The state revision serializes profile activation and edits without guessing an identity.
create or replace function public.arios_account_update(
  p_expected_revision bigint, p_state jsonb, p_auth_user_id uuid,
  p_domain_user_id text, p_role text
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare current_role text; changed integer;
begin
  if p_role is null or p_role not in ('manager','worker','customer','warehouse','accountant')
    or p_domain_user_id is null or p_domain_user_id = ''
    or p_state is null or jsonb_typeof(p_state) <> 'object'
    or not coalesce(p_state->'users' @> jsonb_build_array(jsonb_build_object('id',p_domain_user_id,'role',p_role)),false)
    then raise exception 'Invalid account update' using errcode = '22023'; end if;
  if p_auth_user_id is null then
    if p_role = 'manager' then raise exception 'Manager profile is required' using errcode = '22023'; end if;
    if exists (select 1 from public.arios_profiles where domain_user_id = p_domain_user_id) then return false; end if;
  else
    select role into current_role from public.arios_profiles
      where auth_user_id = p_auth_user_id and domain_user_id = p_domain_user_id for update;
    if not found then return false; end if;
    if (current_role = 'manager') is distinct from (p_role = 'manager')
      then raise exception 'Manager role cannot be reassigned here' using errcode = '22023'; end if;
  end if;
  update public.arios_state set data = p_state, revision = revision + 1
    where id = 1 and revision = p_expected_revision;
  get diagnostics changed = row_count;
  if changed = 0 then return false; end if;
  if p_auth_user_id is not null then
    update public.arios_profiles set role = p_role
      where auth_user_id = p_auth_user_id and domain_user_id = p_domain_user_id;
  end if;
  return true;
end;
$$;
revoke all on function public.arios_account_update(bigint,jsonb,uuid,text,text) from public, anon, authenticated;
grant execute on function public.arios_account_update(bigint,jsonb,uuid,text,text) to service_role;
