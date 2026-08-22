-- Forward-only correction: reduce the Free OCR allowance from 25 to 10.
-- The entitlement schema, session lifecycle, admission locking and grants are unchanged.

create or replace function public.get_my_entitlement()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  entitlement public.user_entitlements%rowtype;
  month_utc date := date_trunc('month', now() at time zone 'UTC')::date;
  used_count integer;
  active_entities integer;
  active_projects integer;
  is_pro boolean;
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  insert into public.user_entitlements (user_id) values (uid) on conflict (user_id) do nothing;
  select * into entitlement from public.user_entitlements where user_id=uid;
  is_pro := private.receipt_box_is_pro(uid);
  select count(*) into used_count from public.ocr_scan_sessions
    where user_id=uid and month_start=month_utc and status='succeeded';
  select count(*) into active_entities from public.entities where user_id=uid and not is_archived;
  select count(*) into active_projects from public.projects where user_id=uid and not is_archived;
  return jsonb_build_object(
    'plan',case when is_pro then 'pro' else 'free' end,
    'status',entitlement.status,'source',entitlement.source,
    'starts_at',entitlement.starts_at,'expires_at',entitlement.expires_at,
    'ocr',jsonb_build_object('used',used_count,'limit',case when is_pro then null else 10 end,'allowed',is_pro or used_count<10),
    'capabilities',jsonb_build_object(
      'run_ocr',is_pro or used_count<10,
      'create_entity',is_pro or active_entities<1,
      'create_project',is_pro or active_projects<1,
      'custom_categories',is_pro,
      'advanced_reports',is_pro,
      'export_csv',is_pro,
      'export_pdf',is_pro
    )
  );
end;
$$;

create or replace function public.begin_ocr_scan(scan_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  month_utc date := date_trunc('month', now() at time zone 'UTC')::date;
  existing public.ocr_scan_sessions%rowtype;
  reserved_count integer;
  used_count integer;
  is_pro boolean;
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  if scan_session_id is null then raise exception 'A scan session ID is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 824621));
  insert into public.user_entitlements (user_id) values (uid) on conflict (user_id) do nothing;
  is_pro := private.receipt_box_is_pro(uid);

  update public.ocr_scan_sessions set status='failed',updated_at=now()
    where user_id=uid and status='started' and updated_at < now()-interval '15 minutes';
  select * into existing from public.ocr_scan_sessions where id=scan_session_id;
  if found and existing.user_id<>uid then raise exception 'Scan session is owned by another user' using errcode='42501'; end if;
  select count(*) into used_count from public.ocr_scan_sessions
    where user_id=uid and month_start=month_utc and status='succeeded';
  if found and existing.status='succeeded' then
    return jsonb_build_object('allowed',true,'already_counted',true,'used',used_count,'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  select count(*) into reserved_count from public.ocr_scan_sessions
    where user_id=uid and month_start=month_utc and status in ('started','succeeded');
  if not is_pro and reserved_count>=10 then
    return jsonb_build_object('allowed',false,'already_counted',false,'used',used_count,'reserved',reserved_count,'limit',10,'plan','free','reason','monthly_limit');
  end if;

  insert into public.ocr_scan_sessions (id,user_id,month_start,status)
  values (scan_session_id,uid,month_utc,'started')
  on conflict (id) do update set month_start=excluded.month_start,status='started',
    attempt_count=public.ocr_scan_sessions.attempt_count+1,updated_at=now()
    where public.ocr_scan_sessions.user_id=excluded.user_id and public.ocr_scan_sessions.status='failed';
  return jsonb_build_object('allowed',true,'already_counted',false,'used',used_count,'reserved',reserved_count+1,'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
end;
$$;

create or replace function public.complete_ocr_scan(scan_session_id uuid, has_meaningful_fields boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  scan public.ocr_scan_sessions%rowtype;
  used_count integer;
  is_pro boolean;
begin
  if uid is null then raise exception 'Authentication required' using errcode='28000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 824621));
  select * into scan from public.ocr_scan_sessions where id=scan_session_id and user_id=uid for update;
  if not found then raise exception 'Unknown OCR scan session' using errcode='22023'; end if;
  if scan.status='succeeded' then
    select count(*) into used_count from public.ocr_scan_sessions
      where user_id=uid and month_start=scan.month_start and status='succeeded';
    is_pro := private.receipt_box_is_pro(uid);
    return jsonb_build_object('counted',true,'already_counted',true,'requires_readmission',false,
      'used',used_count,'usage_month',scan.month_start,
      'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  if scan.status='failed' then
    is_pro := private.receipt_box_is_pro(uid);
    select count(*) into used_count from public.ocr_scan_sessions
      where user_id=uid and month_start=scan.month_start and status='succeeded';
    return jsonb_build_object('counted',false,'already_counted',false,'requires_readmission',true,
      'reason','failed_session','used',used_count,'usage_month',scan.month_start,
      'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  if scan.updated_at < now()-interval '15 minutes' then
    update public.ocr_scan_sessions set status='failed',updated_at=now()
      where id=scan_session_id and user_id=uid and status='started';
    is_pro := private.receipt_box_is_pro(uid);
    select count(*) into used_count from public.ocr_scan_sessions
      where user_id=uid and month_start=scan.month_start and status='succeeded';
    return jsonb_build_object('counted',false,'already_counted',false,'requires_readmission',true,
      'reason','expired_lease','used',used_count,'usage_month',scan.month_start,
      'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  update public.ocr_scan_sessions set
    status=case when has_meaningful_fields then 'succeeded' else 'failed' end,
    succeeded_at=case when has_meaningful_fields then now() else null end,
    updated_at=now()
  where id=scan_session_id and user_id=uid and status='started';
  is_pro := private.receipt_box_is_pro(uid);
  select count(*) into used_count from public.ocr_scan_sessions
    where user_id=uid and month_start=scan.month_start and status='succeeded';
  return jsonb_build_object('counted',has_meaningful_fields,'already_counted',false,'requires_readmission',false,
    'used',used_count,'usage_month',scan.month_start,
    'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
end;
$$;
