const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821090000_add_user_managed_dimensions.sql'), 'utf8')
const indexMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821133000_add_composite_fk_indexes.sql'), 'utf8')
const entitlementMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821150000_add_free_pro_entitlements.sql'), 'utf8')

async function driftedProductionShape(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    insert into auth.users values ('${owner}'),('${other}');
    create table entities(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,created_at timestamptz not null default now());
    create unique index entities_user_name_idx on entities(user_id,name);
    create table categories(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,created_at timestamptz not null default now());
    create unique index categories_user_name_idx on categories(user_id,name);
    create table projects(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),entity_id uuid references entities(id),name text not null,created_at timestamptz not null default now());
    create unique index projects_user_name_idx on projects(user_id,name);
    create table receipts(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),supplier text not null,entity_id uuid references entities(id),category_id uuid references categories(id),project_id uuid references projects(id),entity_name text,category_name text,project_name text);
    grant all on entities,categories,projects to anon,authenticated;
  `)
  for (const table of ['entities','categories','projects']) {
    await db.exec(`alter table ${table} enable row level security; create policy "Users can view own ${table}" on ${table} for select using(auth.uid()=user_id); create policy "Users can insert own ${table}" on ${table} for insert with check(auth.uid()=user_id); create policy "Users can update own ${table}" on ${table} for update using(auth.uid()=user_id); create policy "Users can delete own ${table}" on ${table} for delete using(auth.uid()=user_id);`)
  }
  const rows = [
    ['A','Personal','Advertising','Gate'],['B','Personal','Office Supplies','Home'],
    ['C','Personal','Other','Pool fence cert'],['D','Personal','Repairs & Maintenance','Production verification'],
    ['E','AWTCO','Repairs & Maintenance','Pub'],['F','National Events','Travel',null]
  ]
  for (const row of rows) await db.query('insert into receipts(user_id,supplier,entity_name,category_name,project_name) values($1,$2,$3,$4,$5)',[owner,...row])
}

test('migration dry-run reconciles production drift, enforces ownership, and rolls cleanup back atomically', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), db = new PGlite()
  try {
    await driftedProductionShape(db)
    const before = (await db.query('select supplier,entity_name,category_name,project_name from receipts order by supplier')).rows
    await db.exec(migration)
    await db.exec(migration)
    await db.exec(indexMigration)
    await db.exec(indexMigration)
    await db.exec(entitlementMigration)
    await db.exec(entitlementMigration)

    assert.deepEqual((await db.query('select count(*)::int receipts,count(entity_id)::int entity_links,count(category_id)::int category_links,count(project_id)::int project_links,count(*) filter(where user_id is null)::int ownerless from receipts')).rows[0],{receipts:6,entity_links:6,category_links:6,project_links:5,ownerless:0})
    assert.deepEqual((await db.query('select supplier,entity_name,category_name,project_name from receipts order by supplier')).rows,before)
    assert.deepEqual((await db.query('select (select count(*)::int from entities where user_id=$1) entities,(select count(*)::int from categories where user_id=$1) categories,(select count(*)::int from projects where user_id=$1) projects',[owner])).rows[0],{entities:3,categories:10,projects:5})
    assert.deepEqual((await db.query('select count(*)::int total,count(*) filter(where is_grandfathered)::int grandfathered from entities where user_id=$1',[owner])).rows[0],{total:3,grandfathered:3})

    const foreignEntity = (await db.query('select id from entities where user_id=$1 limit 1',[other])).rows[0].id
    await assert.rejects(db.query('update receipts set entity_id=$1 where supplier=$2',[foreignEntity,'A']))
    await assert.rejects(db.query('update projects set entity_id=$1 where user_id=$2',[foreignEntity,owner]))
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${owner}',false)`)
    assert.equal((await db.query('select count(*)::int visible from entities')).rows[0].visible,3)
    await assert.rejects(db.query('select public.delete_account_data($1)',[owner]))
    await db.exec('reset role')

    const grants = (await db.query("select grantee,privilege_type from information_schema.role_table_grants where table_name='entities' and grantee in ('anon','authenticated') order by grantee,privilege_type")).rows
    assert.deepEqual(grants.map(row=>`${row.grantee}:${row.privilege_type}`),['authenticated:DELETE','authenticated:INSERT','authenticated:SELECT','authenticated:UPDATE'])
    const policies = (await db.query("select roles,cmd,with_check from pg_policies where tablename='entities'")).rows
    assert.ok(policies.every(row=>row.roles.includes('authenticated')))
    assert.ok(policies.find(row=>row.cmd==='UPDATE').with_check)
    const foreignKeyIndexes = (await db.query("select indexname from pg_indexes where schemaname='public' and indexname in ('receipts_user_entity_idx','receipts_user_category_idx','receipts_user_project_idx','projects_user_entity_idx') order by indexname")).rows.map(row=>row.indexname)
    assert.deepEqual(foreignKeyIndexes,['projects_user_entity_idx','receipts_user_category_idx','receipts_user_entity_idx','receipts_user_project_idx'])
    assert.equal((await db.query("select count(*)::int redundant from pg_indexes where schemaname='public' and indexdef ~ '\\(user_id\\)$' and tablename='receipts'")).rows[0].redundant,0)

    await db.exec("create function fail_cleanup() returns trigger language plpgsql as $$begin raise exception 'simulated';end$$; create trigger fail_cleanup before delete on categories for each statement execute function fail_cleanup();")
    await assert.rejects(db.query('select public.delete_account_data($1)',[owner]),/simulated/)
    assert.deepEqual((await db.query('select (select count(*)::int from receipts where user_id=$1) receipts,(select count(*)::int from projects where user_id=$1) projects,(select count(*)::int from categories where user_id=$1) categories,(select count(*)::int from entities where user_id=$1) entities',[owner])).rows[0],{receipts:6,projects:5,categories:10,entities:3})
    await db.exec('drop trigger fail_cleanup on categories; drop function fail_cleanup()')
    await db.query('select public.delete_account_data($1)',[owner])
    assert.equal((await db.query('select count(*)::int remaining from receipts where user_id=$1',[owner])).rows[0].remaining,0)
  } finally { await db.close() }
})
