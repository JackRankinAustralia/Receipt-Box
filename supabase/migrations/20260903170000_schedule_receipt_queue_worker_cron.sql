-- Stage 3D-C: schedule the already-deployed process-receipt-queue Edge
-- Function to run automatically once per minute.
--
-- This migration only adds a pg_cron job. It does not change any Edge
-- Function code, database worker RPC, entitlement logic, Gemini handling,
-- queue semantics, retry logic or browser OCR. It does not touch Vault
-- contents or existing receipts.
--
-- WHY VAULT: the worker's invocation secret (RECEIPT_QUEUE_WORKER_SECRET)
-- must never be hardcoded into a migration file, since migrations are
-- version-controlled and readable by anyone with repo access. Instead the
-- secret is stored in Supabase Vault (name: receipt_box_queue_worker_secret)
-- and is read at cron-execution time via vault.decrypted_secrets, which is
-- only queryable by roles with sufficient database privileges (not by
-- browser/anon/authenticated roles).
--
-- WHY verify_jwt=false IS SAFE HERE: process-receipt-queue is deployed with
-- verify_jwt=false because it implements its own custom bearer-token check
-- against RECEIPT_QUEUE_WORKER_SECRET (see supabase/functions/
-- process-receipt-queue/index.ts and workerAuth.mjs). A Supabase auth JWT
-- was never required for this service-only worker endpoint; the dedicated
-- worker secret is the actual authorization boundary, and it is what this
-- cron job supplies as the Authorization bearer token.
--
-- BOUNDED PROCESSING: each invocation processes at most 3 queued receipts
-- (the Edge Function's existing default/cap - see MAX_RECEIPTS_PER_INVOCATION
-- in index.ts). This job intentionally sends an empty JSON body ('{}') so
-- that default/cap is preserved unchanged; it does not request a lower
-- maxReceipts override.
--
-- Idempotent scheduling: unschedule any pre-existing job with the same name
-- before scheduling, so re-running this migration (or a future migration
-- that also calls cron.schedule with this name) cannot create duplicate
-- jobs. cron.schedule() with an existing job name would otherwise be an
-- upsert already, but explicitly unscheduling first keeps the intent clear
-- and safe even if the job was manually edited outside of migrations.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'receipt-box-process-receipt-queue') then
    perform cron.unschedule('receipt-box-process-receipt-queue');
  end if;
end;
$$;

select cron.schedule(
  'receipt-box-process-receipt-queue',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://fvrtmoolruetqjxhrfvq.supabase.co/functions/v1/process-receipt-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'receipt_box_queue_worker_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id;
  $$
);
