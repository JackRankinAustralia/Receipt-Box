-- Reconcile the partially-created production schema without changing the
-- historical entity_name, category_name, or project_name receipt values.

create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_id uuid references public.entities(id) on delete set null,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.entities
  add column if not exists is_default boolean not null default false,
  add column if not exists is_archived boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();
alter table public.categories
  add column if not exists is_default boolean not null default false,
  add column if not exists is_archived boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();
alter table public.projects
  add column if not exists is_default boolean not null default false,
  add column if not exists is_archived boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table public.receipts
  add column if not exists entity_id uuid,
  add column if not exists category_id uuid,
  add column if not exists project_id uuid;

-- Fail atomically rather than silently merging existing names that differ
-- only by case or surrounding whitespace.
do $$
declare table_name text;
declare duplicate_name text;
begin
  foreach table_name in array array['entities', 'categories', 'projects'] loop
    execute format('select min(name) from public.%I group by user_id, lower(btrim(name)) having count(*) > 1 limit 1', table_name)
      into duplicate_name;
    if duplicate_name is not null then
      raise exception 'Cannot reconcile public.%: duplicate name variants include %', table_name, duplicate_name;
    end if;
  end loop;
end $$;

create unique index if not exists entities_user_name_idx on public.entities (user_id, name);
create unique index if not exists categories_user_name_idx on public.categories (user_id, name);
create unique index if not exists projects_user_name_idx on public.projects (user_id, name);
create unique index if not exists entities_user_name_ci_idx on public.entities (user_id, lower(btrim(name)));
create unique index if not exists categories_user_name_ci_idx on public.categories (user_id, lower(btrim(name)));
create unique index if not exists projects_user_name_ci_idx on public.projects (user_id, lower(btrim(name)));

do $$
declare table_name text;
declare constraint_name text;
begin
  foreach table_name in array array['entities', 'categories', 'projects'] loop
    constraint_name := table_name || '_name_length_check';
    if not exists (select 1 from pg_constraint where conname = constraint_name and conrelid = ('public.' || table_name)::regclass) then
      execute format('alter table public.%I add constraint %I check (length(btrim(name)) between 1 and 80) not valid', table_name, constraint_name);
    end if;
    execute format('alter table public.%I validate constraint %I', table_name, constraint_name);
  end loop;
end $$;

insert into public.entities (user_id, name)
select u.id, value.name from auth.users u
cross join (values ('Personal'), ('National Events'), ('AWTCO')) as value(name)
on conflict do nothing;

insert into public.entities (user_id, name)
select distinct user_id, btrim(entity_name) from public.receipts
where nullif(btrim(entity_name), '') is not null
on conflict do nothing;

insert into public.categories (user_id, name)
select u.id, value.name from auth.users u
cross join (values ('Advertising'), ('Fuel'), ('Office Supplies'), ('Equipment'), ('Travel'), ('Printing'), ('Software'), ('Repairs & Maintenance'), ('Meals'), ('Other')) as value(name)
on conflict do nothing;

insert into public.categories (user_id, name)
select distinct user_id, btrim(category_name) from public.receipts
where nullif(btrim(category_name), '') is not null
on conflict do nothing;

insert into public.projects (user_id, name)
select distinct user_id, btrim(project_name) from public.receipts
where nullif(btrim(project_name), '') is not null
on conflict do nothing;

-- Backfill only relational IDs. Historical display text remains unchanged.
update public.receipts r set entity_id = d.id from public.entities d
where d.user_id = r.user_id and lower(btrim(d.name)) = lower(btrim(r.entity_name))
  and r.entity_id is distinct from d.id;
update public.receipts r set category_id = d.id from public.categories d
where d.user_id = r.user_id and lower(btrim(d.name)) = lower(btrim(r.category_name))
  and r.category_id is distinct from d.id;
update public.receipts r set project_id = d.id from public.projects d
where d.user_id = r.user_id and lower(btrim(d.name)) = lower(btrim(r.project_name))
  and r.project_id is distinct from d.id;

update public.entities d set is_default = true
where d.name = 'National Events'
  and not exists (select 1 from public.entities x where x.user_id = d.user_id and x.is_default and not x.is_archived);
update public.categories d set is_default = true
where d.name = 'Other'
  and not exists (select 1 from public.categories x where x.user_id = d.user_id and x.is_default and not x.is_archived);

create unique index if not exists entities_one_default_per_user on public.entities (user_id) where is_default and not is_archived;
create unique index if not exists categories_one_default_per_user on public.categories (user_id) where is_default and not is_archived;
create unique index if not exists projects_one_default_per_user on public.projects (user_id) where is_default and not is_archived;
create unique index if not exists entities_user_id_id_idx on public.entities (user_id, id);
create unique index if not exists categories_user_id_id_idx on public.categories (user_id, id);
create unique index if not exists projects_user_id_id_idx on public.projects (user_id, id);

-- Replace weaker single-column foreign keys with owner-matching composite keys.
alter table public.receipts drop constraint if exists receipts_entity_id_fkey;
alter table public.receipts drop constraint if exists receipts_category_id_fkey;
alter table public.receipts drop constraint if exists receipts_project_id_fkey;
alter table public.projects drop constraint if exists projects_entity_id_fkey;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.receipts'::regclass and conname = 'receipts_user_entity_fkey') then
    alter table public.receipts add constraint receipts_user_entity_fkey foreign key (user_id, entity_id)
      references public.entities(user_id, id) on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.receipts'::regclass and conname = 'receipts_user_category_fkey') then
    alter table public.receipts add constraint receipts_user_category_fkey foreign key (user_id, category_id)
      references public.categories(user_id, id) on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.receipts'::regclass and conname = 'receipts_user_project_fkey') then
    alter table public.receipts add constraint receipts_user_project_fkey foreign key (user_id, project_id)
      references public.projects(user_id, id) on delete restrict not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.projects'::regclass and conname = 'projects_user_entity_fkey') then
    alter table public.projects add constraint projects_user_entity_fkey foreign key (user_id, entity_id)
      references public.entities(user_id, id) on delete restrict not valid;
  end if;
end $$;

alter table public.receipts validate constraint receipts_user_entity_fkey;
alter table public.receipts validate constraint receipts_user_category_fkey;
alter table public.receipts validate constraint receipts_user_project_fkey;
alter table public.projects validate constraint projects_user_entity_fkey;

do $$
declare table_name text;
begin
  foreach table_name in array array['entities', 'categories', 'projects'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all privileges on table public.%I from anon', table_name);
    execute format('revoke all privileges on table public.%I from authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', table_name);
    execute format('drop policy if exists %I on public.%I', 'Users can view own ' || table_name, table_name);
    execute format('drop policy if exists %I on public.%I', 'Users can insert own ' || table_name, table_name);
    execute format('drop policy if exists %I on public.%I', 'Users can update own ' || table_name, table_name);
    execute format('drop policy if exists %I on public.%I', 'Users can delete own ' || table_name, table_name);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', 'Users can view own ' || table_name, table_name);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', 'Users can insert own ' || table_name, table_name);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', 'Users can update own ' || table_name, table_name);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', 'Users can delete own ' || table_name, table_name);
  end loop;
end $$;

-- A PostgreSQL function call is one transaction. SECURITY INVOKER means this
-- receives only the service_role caller's existing privileges.
create or replace function public.delete_account_data(target_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.receipts where user_id = target_user_id;
  delete from public.projects where user_id = target_user_id;
  delete from public.categories where user_id = target_user_id;
  delete from public.entities where user_id = target_user_id;
end;
$$;

revoke all on function public.delete_account_data(uuid) from public;
revoke all on function public.delete_account_data(uuid) from anon;
revoke all on function public.delete_account_data(uuid) from authenticated;
grant execute on function public.delete_account_data(uuid) to service_role;
