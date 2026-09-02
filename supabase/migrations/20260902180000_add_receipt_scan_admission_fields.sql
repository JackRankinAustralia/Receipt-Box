-- Stage 3A: durable single-receipt admission foundation.
-- An uploading/queued receipt genuinely has no known supplier yet;
-- this is real data absence, not a UI placeholder, so supplier must
-- become nullable. Existing completed receipts already have supplier
-- values and are unaffected.
alter table public.receipts
  alter column supplier drop not null;

-- scan_session_id: stable, persisted admission/OCR identity generated
-- once at durable admission time. Survives refresh/restart/retry and
-- will become the idempotency key for the future service-role worker.
-- scan_started_at: set at admission time; supports future deliberate
-- stale-upload reclaim (not implemented in this migration/stage).
-- scan_error_summary: short diagnostic recorded when a durable row's
-- image upload fails, so the row remains visible/recoverable in
-- Needs Review instead of silently disappearing.
alter table public.receipts
  add column if not exists scan_session_id uuid,
  add column if not exists scan_started_at timestamptz,
  add column if not exists scan_error_summary text;
