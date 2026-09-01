-- Incomplete receipts are deliberately excluded from financial outputs until
-- a person has reviewed and completed them.
alter table public.receipts
  add column if not exists workflow_status text not null default 'completed',
  add column if not exists reviewed_at timestamptz;

update public.receipts
set workflow_status = 'completed'
where workflow_status is null;

alter table public.receipts
  alter column workflow_status set default 'completed',
  alter column workflow_status set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.receipts'::regclass
      and conname = 'receipts_workflow_status_check'
  ) then
    alter table public.receipts add constraint receipts_workflow_status_check
      check (workflow_status in ('uploading', 'queued', 'reading', 'needs_review', 'needs_attention', 'completed'));
  end if;
end $$;
