-- Free/Pro entitlement foundation. Billing providers will update entitlements
-- later through trusted server-side code; browsers receive read-only access.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.user_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan ~ '^[a-z][a-z0-9_]{1,31}$'),
  status text not null default 'active' check (status in ('active','trialing','expired','cancelled')),
  source text not null default 'system' check (source ~ '^[a-z][a-z0-9_]{1,31}$'),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at >= starts_at)
);

create table if not exists public.ocr_scan_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  month_start date not null,
  status text not null default 'started' check (status in ('started','succeeded','failed')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  started_at timestamptz not null default now(),
  succeeded_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

create index if not exists ocr_scan_sessions_user_month_status_idx
  on public.ocr_scan_sessions (user_id, month_start, status);

-- Mark only rows that pre-date the first application. Re-running this migration
-- must not grandfather records created after entitlement enforcement began.
do $$
declare dimension text;
begin
  foreach dimension in array array['entities','categories','projects'] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name=dimension and column_name='is_grandfathered'
    ) then
      execute format('alter table public.%I add column is_grandfathered boolean not null default false',dimension);
      execute format('update public.%I set is_grandfathered=true',dimension);
    end if;
  end loop;
end;
$$;

insert into public.user_entitlements (user_id, plan, status, source)
select id, 'free', 'active', 'system' from auth.users
on conflict (user_id) do nothing;

create or replace function private.receipt_box_is_pro(target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select plan = 'pro'
      and status in ('active','trialing')
      and (expires_at is null or expires_at > now())
    from public.user_entitlements where user_id = target_user_id
  ), false)
$$;
revoke all on function private.receipt_box_is_pro(uuid) from public, anon, authenticated;

create or replace function private.seed_receipt_box_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_entitlements (user_id, plan, status, source)
  values (new.id, 'free', 'active', 'system') on conflict (user_id) do nothing;
  insert into public.entities (user_id, name, is_default)
  values (new.id, 'Personal', true) on conflict do nothing;
  insert into public.categories (user_id, name, is_default)
  select new.id, name, name = 'Other' from unnest(array[
    'Advertising','Fuel','Office Supplies','Equipment','Travel','Printing',
    'Software','Repairs & Maintenance','Meals','Other'
  ]) name on conflict do nothing;
  return new;
end;
$$;
revoke all on function private.seed_receipt_box_user() from public, anon, authenticated;
drop trigger if exists seed_receipt_box_user on auth.users;
create trigger seed_receipt_box_user after insert on auth.users
for each row execute function private.seed_receipt_box_user();

create or replace function private.enforce_receipt_box_dimension_entitlement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target_user uuid;
  active_count integer;
  standard_categories constant text[] := array[
    'Advertising','Fuel','Office Supplies','Equipment','Travel','Printing',
    'Software','Repairs & Maintenance','Meals','Other'
  ];
begin
  target_user := new.user_id;
  if private.receipt_box_is_pro(target_user) then return new; end if;

  if tg_table_name = 'categories' then
    if tg_op = 'INSERT' and not (new.name = any(standard_categories)) then
      raise exception using errcode='P0001', message='receipt_box_pro_required:custom_categories';
    end if;
    if tg_op = 'UPDATE' and new.name is distinct from old.name
       and not (new.name = any(standard_categories)) then
      raise exception using errcode='P0001', message='receipt_box_pro_required:custom_categories';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.is_archived and not new.is_archived and not old.is_grandfathered) then
    execute format('select count(*) from public.%I where user_id=$1 and not is_archived', tg_table_name)
      into active_count using target_user;
    if active_count >= 1 then
      raise exception using errcode='P0001', message=case when tg_table_name='entities'
        then 'receipt_box_pro_required:multiple_entities'
        else 'receipt_box_pro_required:multiple_projects' end;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_receipt_box_dimension_entitlement() from public, anon, authenticated;

drop trigger if exists enforce_entity_entitlement on public.entities;
create trigger enforce_entity_entitlement before insert or update on public.entities
for each row execute function private.enforce_receipt_box_dimension_entitlement();
drop trigger if exists enforce_category_entitlement on public.categories;
create trigger enforce_category_entitlement before insert or update on public.categories
for each row execute function private.enforce_receipt_box_dimension_entitlement();
drop trigger if exists enforce_project_entitlement on public.projects;
create trigger enforce_project_entitlement before insert or update on public.projects
for each row execute function private.enforce_receipt_box_dimension_entitlement();

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
    'ocr',jsonb_build_object('used',used_count,'limit',case when is_pro then null else 25 end,'allowed',is_pro or used_count<25),
    'capabilities',jsonb_build_object(
      'run_ocr',is_pro or used_count<25,
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
    return jsonb_build_object('allowed',true,'already_counted',true,'used',used_count,'limit',case when is_pro then null else 25 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  select count(*) into reserved_count from public.ocr_scan_sessions
    where user_id=uid and month_start=month_utc and status in ('started','succeeded');
  if not is_pro and reserved_count>=25 then
    return jsonb_build_object('allowed',false,'already_counted',false,'used',used_count,'reserved',reserved_count,'limit',25,'plan','free','reason','monthly_limit');
  end if;

  insert into public.ocr_scan_sessions (id,user_id,month_start,status)
  values (scan_session_id,uid,month_utc,'started')
  on conflict (id) do update set month_start=excluded.month_start,status='started',
    attempt_count=public.ocr_scan_sessions.attempt_count+1,updated_at=now()
    where public.ocr_scan_sessions.user_id=excluded.user_id and public.ocr_scan_sessions.status='failed';
  return jsonb_build_object('allowed',true,'already_counted',false,'used',used_count,'reserved',reserved_count+1,'limit',case when is_pro then null else 25 end,'plan',case when is_pro then 'pro' else 'free' end);
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
      'limit',case when is_pro then null else 25 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  if scan.status='failed' then
    is_pro := private.receipt_box_is_pro(uid);
    select count(*) into used_count from public.ocr_scan_sessions
      where user_id=uid and month_start=scan.month_start and status='succeeded';
    return jsonb_build_object('counted',false,'already_counted',false,'requires_readmission',true,
      'reason','failed_session','used',used_count,'usage_month',scan.month_start,
      'limit',case when is_pro then null else 25 end,'plan',case when is_pro then 'pro' else 'free' end);
  end if;

  if scan.updated_at < now()-interval '15 minutes' then
    update public.ocr_scan_sessions set status='failed',updated_at=now()
      where id=scan_session_id and user_id=uid and status='started';
    is_pro := private.receipt_box_is_pro(uid);
    select count(*) into used_count from public.ocr_scan_sessions
      where user_id=uid and month_start=scan.month_start and status='succeeded';
    return jsonb_build_object('counted',false,'already_counted',false,'requires_readmission',true,
      'reason','expired_lease','used',used_count,'usage_month',scan.month_start,
      'limit',case when is_pro then null else 25 end,'plan',case when is_pro then 'pro' else 'free' end);
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
    'limit',case when is_pro then null else 25 end,'plan',case when is_pro then 'pro' else 'free' end);
end;
$$;

alter table public.user_entitlements enable row level security;
alter table public.ocr_scan_sessions enable row level security;
revoke all privileges on public.user_entitlements from anon, authenticated;
revoke all privileges on public.ocr_scan_sessions from anon, authenticated;
grant select on public.user_entitlements, public.ocr_scan_sessions to authenticated;
drop policy if exists "Users can view own entitlement" on public.user_entitlements;
create policy "Users can view own entitlement" on public.user_entitlements for select to authenticated
using ((select auth.uid())=user_id);
drop policy if exists "Users can view own OCR sessions" on public.ocr_scan_sessions;
create policy "Users can view own OCR sessions" on public.ocr_scan_sessions for select to authenticated
using ((select auth.uid())=user_id);

revoke all on function public.get_my_entitlement() from public, anon;
revoke all on function public.begin_ocr_scan(uuid) from public, anon;
revoke all on function public.complete_ocr_scan(uuid,boolean) from public, anon;
grant execute on function public.get_my_entitlement() to authenticated;
grant execute on function public.begin_ocr_scan(uuid) to authenticated;
grant execute on function public.complete_ocr_scan(uuid,boolean) to authenticated;

create or replace function public.delete_account_data(target_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.receipts where user_id = target_user_id;
  delete from public.ocr_scan_sessions where user_id = target_user_id;
  delete from public.projects where user_id = target_user_id;
  delete from public.categories where user_id = target_user_id;
  delete from public.entities where user_id = target_user_id;
  delete from public.user_entitlements where user_id = target_user_id;
end;
$$;
revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
