-- Stage 3D-A: durable server-side OCR worker foundation.
-- Adds only the database plumbing a future Supabase Edge Function worker
-- needs to claim, process and complete queued receipts safely. No worker,
-- Edge Function or Cron job is implemented by this migration.
--
-- The existing browser-facing auth.uid() entitlement RPCs
-- (get_my_entitlement / begin_ocr_scan / complete_ocr_scan) are completely
-- untouched. The functions below are a parallel, service-role-only path
-- that reuses the same ocr_scan_sessions ledger so Free/Pro quota stays
-- unified across both the browser and the future background worker.

-- scan_attempts: counts claim attempts for a receipt. Used to stop a
-- corrupt/unreadable image from being reclaimed forever.
alter table public.receipts
  add column if not exists scan_attempts integer not null default 0;

-- Atomic claim: moves one queued (or stale, reclaimable) receipt to
-- 'reading' and returns only the fields a worker needs to process it.
-- FOR UPDATE SKIP LOCKED is the correctness boundary that lets overlapping
-- Edge Function invocations run concurrently without double-claiming.
create or replace function public.claim_next_queued_receipt_service(
  worker_scan_session_id uuid,
  stale_after_minutes integer default 10,
  max_attempts integer default 3
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  claimed public.receipts%rowtype;
begin
  if worker_scan_session_id is null then
    raise exception 'A scan session ID is required';
  end if;

  update public.receipts
  set workflow_status = 'reading',
      scan_session_id = coalesce(scan_session_id, worker_scan_session_id),
      scan_started_at = now(),
      scan_attempts = scan_attempts + 1
  where id = (
    select id from public.receipts
    where (
      workflow_status = 'queued'
    ) or (
      workflow_status = 'reading'
      and scan_started_at < now() - make_interval(mins => stale_after_minutes)
      and scan_attempts < max_attempts
    )
    order by scan_started_at nulls first
    limit 1
    for update skip locked
  )
  returning * into claimed;

  if not found then
    return jsonb_build_object('claimed', false);
  end if;

  return jsonb_build_object(
    'claimed', true,
    'receipt_id', claimed.id,
    'user_id', claimed.user_id,
    'file_path', claimed.file_path,
    'mime_type', claimed.mime_type,
    'scan_session_id', claimed.scan_session_id,
    'scan_attempts', claimed.scan_attempts
  );
end;
$$;
revoke all on function public.claim_next_queued_receipt_service(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_next_queued_receipt_service(uuid, integer, integer) to service_role;

-- Service-only entitlement admission. Ownership is always derived from the
-- receipt row, never from a caller-supplied user_id. Reuses the same
-- per-user advisory lock and ocr_scan_sessions ledger as begin_ocr_scan so
-- browser and background admissions can never race each other's quota, and
-- reuses the scan_session_id already persisted on the receipt as the
-- idempotency key so retries/duplicate worker invocations cannot double-charge.
create or replace function public.begin_receipt_ocr_service(receipt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  session_id uuid;
  month_utc date := date_trunc('month', now() at time zone 'UTC')::date;
  existing public.ocr_scan_sessions%rowtype;
  existing_found boolean;
  reserved_count integer;
  used_count integer;
  is_pro boolean;
begin
  select user_id, scan_session_id into owner, session_id from public.receipts where id = receipt_id;
  if owner is null then raise exception 'Unknown receipt' using errcode='22023'; end if;
  if session_id is null then raise exception 'Receipt has no persisted scan session' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended(owner::text, 824621));
  insert into public.user_entitlements (user_id) values (owner) on conflict (user_id) do nothing;
  is_pro := private.receipt_box_is_pro(owner);

  update public.ocr_scan_sessions set status='failed', updated_at=now()
    where user_id=owner and status='started' and updated_at < now()-interval '15 minutes';
  select * into existing from public.ocr_scan_sessions where id=session_id;
  existing_found := found;
  if existing_found and existing.user_id<>owner then raise exception 'Scan session is owned by another user' using errcode='42501'; end if;
  select count(*) into used_count from public.ocr_scan_sessions
    where user_id=owner and month_start=month_utc and status='succeeded';
  if existing_found and existing.status='succeeded' then
    return jsonb_build_object('allowed',true,'already_counted',true,'used',used_count,'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  select count(*) into reserved_count from public.ocr_scan_sessions
    where user_id=owner and month_start=month_utc and status in ('started','succeeded');
  if not is_pro and reserved_count>=10 and not (existing_found and existing.status='started') then
    return jsonb_build_object('allowed',false,'already_counted',false,'used',used_count,'reserved',reserved_count,'limit',10,'plan','free','reason','monthly_limit');
  end if;

  insert into public.ocr_scan_sessions (id,user_id,month_start,status)
  values (session_id,owner,month_utc,'started')
  on conflict (id) do update set month_start=excluded.month_start,status='started',
    attempt_count=public.ocr_scan_sessions.attempt_count+1,updated_at=now()
    where public.ocr_scan_sessions.user_id=excluded.user_id and public.ocr_scan_sessions.status in ('failed','started');
  return jsonb_build_object('allowed',true,'already_counted',false,'used',used_count,'reserved',reserved_count+1,'limit',case when is_pro then null else 10 end,'plan',case when is_pro then 'pro' else 'free' end);
end;
$$;
revoke all on function public.begin_receipt_ocr_service(uuid) from public, anon, authenticated;
grant execute on function public.begin_receipt_ocr_service(uuid) to service_role;

-- Service-only completion. Re-checks the receipt's *current* persisted
-- scan_session_id before mutating anything: if a later claim already reset
-- it, this call is a stale duplicate and becomes a safe no-op.
--
-- retryable distinguishes two different kinds of failure:
--   retryable=true  - a transient technical failure (Gemini 429/500/502/503/
--                      504, a network blip, a temporary Storage download
--                      failure). Worth trying again while scan_attempts is
--                      under the cap.
--   retryable=false - a terminal/non-retryable read failure (no meaningful
--                      fields extracted, unsupported/corrupt image, a
--                      permanent 400-type input problem, or quota exhausted
--                      before Gemini was even called). Retrying the same
--                      image would not help, so this goes straight to
--                      needs_attention without spending further attempts.
create or replace function public.complete_receipt_ocr_service(
  receipt_id uuid,
  scan_session_id uuid,
  success boolean,
  supplier text default null,
  receipt_date date default null,
  total numeric default null,
  gst numeric default null,
  error_summary text default null,
  retryable boolean default true,
  max_attempts integer default 3
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  current_session uuid;
  attempts integer;
  next_status text;
begin
  select user_id, receipts.scan_session_id, scan_attempts into owner, current_session, attempts
    from public.receipts where id = receipt_id;
  if owner is null then raise exception 'Unknown receipt' using errcode='22023'; end if;

  if current_session is distinct from scan_session_id then
    return jsonb_build_object('applied', false, 'reason', 'stale_session');
  end if;

  next_status := case
    when success then 'needs_review'
    when retryable and attempts < max_attempts then 'queued'
    else 'needs_attention'
  end;

  if success then
    update public.receipts
    set workflow_status = next_status,
        supplier = coalesce(complete_receipt_ocr_service.supplier, public.receipts.supplier),
        receipt_date = coalesce(complete_receipt_ocr_service.receipt_date, public.receipts.receipt_date),
        total = coalesce(complete_receipt_ocr_service.total, public.receipts.total),
        gst = coalesce(complete_receipt_ocr_service.gst, public.receipts.gst),
        scan_error_summary = null
    where public.receipts.id = receipt_id and public.receipts.scan_session_id = complete_receipt_ocr_service.scan_session_id;
  else
    update public.receipts
    set workflow_status = next_status,
        scan_error_summary = complete_receipt_ocr_service.error_summary
    where public.receipts.id = receipt_id and public.receipts.scan_session_id = complete_receipt_ocr_service.scan_session_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(owner::text, 824621));
  update public.ocr_scan_sessions set
    status = case when success then 'succeeded' else 'failed' end,
    succeeded_at = case when success then now() else null end,
    updated_at = now()
  where id = scan_session_id and user_id = owner and status = 'started';

  return jsonb_build_object('applied', true, 'workflow_status', next_status);
end;
$$;
revoke all on function public.complete_receipt_ocr_service(uuid, uuid, boolean, text, date, numeric, numeric, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.complete_receipt_ocr_service(uuid, uuid, boolean, text, date, numeric, numeric, text, boolean, integer) to service_role;
