-- Index the referencing side of owner-matching foreign keys. The receipt
-- indexes also cover receipts.user_id via their leading column, so a separate
-- user_id-only index would be redundant.

create index if not exists receipts_user_entity_idx
  on public.receipts (user_id, entity_id);
create index if not exists receipts_user_category_idx
  on public.receipts (user_id, category_id);
create index if not exists receipts_user_project_idx
  on public.receipts (user_id, project_id);
create index if not exists projects_user_entity_idx
  on public.projects (user_id, entity_id);
