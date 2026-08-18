alter table public.receipts enable row level security;
alter table public.receipts alter column user_id set not null;

revoke all privileges on table public.receipts from anon;
revoke all privileges on table public.receipts from authenticated;
grant select, insert, update, delete on table public.receipts to authenticated;

drop policy if exists "Users can view own receipts" on public.receipts;
drop policy if exists "Users can insert own receipts" on public.receipts;
drop policy if exists "Users can update own receipts" on public.receipts;
drop policy if exists "Users can delete own receipts" on public.receipts;

create policy "Users can view own receipts"
on public.receipts for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can insert own receipts"
on public.receipts for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update own receipts"
on public.receipts for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete own receipts"
on public.receipts for delete
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can view own receipt files" on storage.objects;
drop policy if exists "Users can upload own receipt files" on storage.objects;
drop policy if exists "Users can delete own receipt files" on storage.objects;

create policy "Users can view own receipt files"
on storage.objects for select
to authenticated
using (
  bucket_id = 'receipts'
  and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "Users can upload own receipt files"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'receipts'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy "Users can delete own receipt files"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'receipts'
  and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['image/*', 'application/pdf']::text[]
where id = 'receipts';
