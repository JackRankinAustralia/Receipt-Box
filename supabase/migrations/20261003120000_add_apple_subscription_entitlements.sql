-- Apple-managed subscriptions are a separate trusted entitlement source.
-- Existing user_entitlements rows remain authoritative for manual/admin grants.

create table if not exists public.apple_subscriptions (
  original_transaction_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  app_account_token uuid not null,
  product_id text not null,
  transaction_id text not null unique,
  environment text not null check (environment in ('Sandbox','Production')),
  status text not null check (status in ('active','grace_period','billing_retry','expired','revoked')),
  purchased_at timestamptz,
  expires_at timestamptz,
  grace_period_expires_at timestamptz,
  revoked_at timestamptz,
  last_notification_type text,
  last_signed_at timestamptz not null,
  last_verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (app_account_token = user_id)
);

create index if not exists apple_subscriptions_user_status_idx
  on public.apple_subscriptions (user_id, status, expires_at desc);

alter table public.apple_subscriptions enable row level security;
revoke all privileges on public.apple_subscriptions from anon, authenticated;

create or replace function public.upsert_apple_subscription(subscription jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.apple_subscriptions (
    original_transaction_id,user_id,app_account_token,product_id,transaction_id,
    environment,status,purchased_at,expires_at,grace_period_expires_at,revoked_at,
    last_notification_type,last_signed_at,last_verified_at,updated_at
  ) values (
    subscription->>'original_transaction_id',(subscription->>'user_id')::uuid,
    (subscription->>'app_account_token')::uuid,subscription->>'product_id',
    subscription->>'transaction_id',subscription->>'environment',subscription->>'status',
    (subscription->>'purchased_at')::timestamptz,(subscription->>'expires_at')::timestamptz,
    (subscription->>'grace_period_expires_at')::timestamptz,(subscription->>'revoked_at')::timestamptz,
    subscription->>'last_notification_type',(subscription->>'last_signed_at')::timestamptz,
    (subscription->>'last_verified_at')::timestamptz,(subscription->>'updated_at')::timestamptz
  )
  on conflict (original_transaction_id) do update set
    user_id=excluded.user_id,app_account_token=excluded.app_account_token,
    product_id=excluded.product_id,transaction_id=excluded.transaction_id,
    environment=excluded.environment,status=excluded.status,purchased_at=excluded.purchased_at,
    expires_at=excluded.expires_at,grace_period_expires_at=excluded.grace_period_expires_at,
    revoked_at=excluded.revoked_at,last_notification_type=excluded.last_notification_type,
    last_signed_at=excluded.last_signed_at,last_verified_at=excluded.last_verified_at,
    updated_at=excluded.updated_at
  where excluded.last_signed_at >= public.apple_subscriptions.last_signed_at;
end;
$$;
revoke all on function public.upsert_apple_subscription(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_apple_subscription(jsonb) to service_role;

create or replace function private.receipt_box_is_pro(target_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select
    coalesce((
      select plan = 'pro'
        and status in ('active','trialing')
        and (expires_at is null or expires_at > now())
      from public.user_entitlements where user_id = target_user_id
    ), false)
    or exists (
      select 1 from public.apple_subscriptions
      where user_id = target_user_id
        and status in ('active','grace_period')
        and coalesce(grace_period_expires_at, expires_at) > now()
    )
$$;
revoke all on function private.receipt_box_is_pro(uuid) from public, anon, authenticated;

create or replace function public.get_my_apple_subscription()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null else coalesce((
    select jsonb_build_object(
      'product_id', product_id,
      'status', status,
      'environment', environment,
      'expires_at', expires_at,
      'grace_period_expires_at', grace_period_expires_at,
      'is_active', status in ('active','grace_period')
        and coalesce(grace_period_expires_at, expires_at) > now()
    )
    from public.apple_subscriptions
    where user_id = auth.uid()
    order by coalesce(grace_period_expires_at, expires_at) desc nulls last, updated_at desc
    limit 1
  ), '{}'::jsonb) end
$$;
revoke all on function public.get_my_apple_subscription() from public, anon;
grant execute on function public.get_my_apple_subscription() to authenticated;

comment on table public.apple_subscriptions is
  'Server-verified StoreKit subscription state. Clients have read-only access to their own rows.';
