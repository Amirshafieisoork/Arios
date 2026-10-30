-- Consistent application snapshot. Auth credentials/sessions/Passkeys and provider
-- secrets deliberately remain outside an export delivered through Telegram.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('arios-backups','arios-backups',false,20000000,array['application/octet-stream','application/json'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.arios_backup_snapshot()
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'format','arios-application-snapshot/v1','capturedAt',statement_timestamp(),
    'state',(select jsonb_build_object('data',data,'revision',revision) from public.arios_state where id=1),
    'profiles',(select coalesce(jsonb_agg(to_jsonb(t) order by domain_user_id),'[]'::jsonb) from public.arios_profiles t),
    'drafts',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.arios_drafts t),
    'leads',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.arios_leads t),
    'reminders',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]'::jsonb) from public.arios_reminders t),
    'telegramLinks',(select coalesce(jsonb_agg(to_jsonb(t) order by user_id),'[]'::jsonb) from public.arios_telegram_links t),
    'telegramUpdates',(select coalesce(jsonb_agg(to_jsonb(t) order by update_id),'[]'::jsonb) from public.arios_telegram_updates t),
    'settings',(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from public.arios_settings where key in ('telegram_offset','telegram_reminders')),
    'integrationConfiguration',(select jsonb_build_object('aiBaseUrl',value->'aiBaseUrl','aiModel',value->'aiModel','transcriptionModel',value->'transcriptionModel','botUsername',value->'botUsername','botId',value->'botId') from public.arios_settings where key='integrations'),
    'objects',(select coalesce(jsonb_agg(jsonb_build_object('bucket',bucket_id,'name',name,'id',id,'updatedAt',updated_at,'size',coalesce((metadata->>'size')::bigint,0)) order by bucket_id,name),'[]'::jsonb)
      from storage.objects where bucket_id in ('arios-audio','arios-project-files'))
  );
$$;
revoke all on function public.arios_backup_snapshot() from public,anon,authenticated;
grant execute on function public.arios_backup_snapshot() to service_role;

create or replace function public.arios_backup_object_info(p_bucket text,p_name text)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('id',id,'updatedAt',updated_at,'size',coalesce((metadata->>'size')::bigint,0))
  from storage.objects where bucket_id=p_bucket and name=p_name
    and p_bucket in ('arios-audio','arios-project-files');
$$;
revoke all on function public.arios_backup_object_info(text,text) from public,anon,authenticated;
grant execute on function public.arios_backup_object_info(text,text) to service_role;
-- The bucket is private and has no anon/authenticated Storage policies. Only the
-- authenticated manager's Edge handler can issue a short-lived download URL.
