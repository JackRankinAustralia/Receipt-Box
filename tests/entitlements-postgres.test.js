const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821150000_add_free_pro_entitlements.sql'), 'utf8')
const quotaMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260822100000_reduce_free_ocr_limit_to_10.sql'), 'utf8')
const owner = '11111111-1111-4111-8111-111111111111'
const newcomer = '33333333-3333-4333-8333-333333333333'

async function entitlementSchema(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table entities(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,is_default boolean not null default false,is_archived boolean not null default false,updated_at timestamptz not null default now(),unique(user_id,name));
    create table categories(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,is_default boolean not null default false,is_archived boolean not null default false,updated_at timestamptz not null default now(),unique(user_id,name));
    create table projects(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,is_default boolean not null default false,is_archived boolean not null default false,updated_at timestamptz not null default now(),unique(user_id,name));
    create table receipts(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id));
    alter table entities enable row level security; alter table categories enable row level security; alter table projects enable row level security;
    create policy entity_owner on entities to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
    create policy category_owner on categories to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
    create policy project_owner on projects to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
    grant select,insert,update,delete on entities,categories,projects to authenticated;
    insert into auth.users values ('${owner}');
    insert into entities(user_id,name) values ('${owner}','Legacy One'),('${owner}','Legacy Two');
    insert into projects(user_id,name) values ('${owner}','Legacy A'),('${owner}','Legacy B');
    insert into categories(user_id,name) values ('${owner}','Historical Custom');
  `)
  await db.exec(migration)
  await db.exec(quotaMigration)
}

async function asUser(db, userId) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${userId}',false)`)
}

test('Free entitlements enforce atomic OCR admission and successful-session accounting', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await entitlementSchema(db)
    await db.query('insert into auth.users(id) values($1)', [newcomer])
    await asUser(db, newcomer)

    const seeded = (await db.query('select public.get_my_entitlement() value')).rows[0].value
    assert.equal(seeded.plan, 'free')
    assert.deepEqual((await db.query('select (select count(*)::int from entities where user_id=$1) entities,(select count(*)::int from categories where user_id=$1) categories,(select count(*)::int from projects where user_id=$1) projects',[newcomer])).rows[0], { entities: 1, categories: 10, projects: 0 })

    const failedId = '00000000-0000-4000-8000-000000000001'
    assert.equal((await db.query('select public.begin_ocr_scan($1) value',[failedId])).rows[0].value.allowed, true)
    let completion = (await db.query('select public.complete_ocr_scan($1,false) value',[failedId])).rows[0].value
    assert.equal(completion.used, 0)
    const lateFailedCompletion = (await db.query('select public.complete_ocr_scan($1,true) value',[failedId])).rows[0].value
    assert.equal(lateFailedCompletion.counted, false)
    assert.equal(lateFailedCompletion.requires_readmission, true)
    assert.equal(lateFailedCompletion.reason, 'failed_session')
    assert.equal((await db.query('select public.begin_ocr_scan($1) value',[failedId])).rows[0].value.allowed, true)
    completion = (await db.query('select public.complete_ocr_scan($1,true) value',[failedId])).rows[0].value
    assert.equal(completion.used, 1)
    const idempotentCompletion = (await db.query('select public.complete_ocr_scan($1,false) value',[failedId])).rows[0].value
    assert.equal(idempotentCompletion.already_counted, true)
    assert.equal(idempotentCompletion.used, 1)
    const rerun = (await db.query('select public.begin_ocr_scan($1) value',[failedId])).rows[0].value
    assert.equal(rerun.already_counted, true)

    for (let i=2;i<=9;i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12,'0')}`
      assert.equal((await db.query('select public.begin_ocr_scan($1) value',[id])).rows[0].value.allowed, true)
      await db.query('select public.complete_ocr_scan($1,true)',[id])
    }
    const boundaryIds = ['00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000011']
    const boundary = await Promise.all(boundaryIds.map(id=>db.query('select public.begin_ocr_scan($1) value',[id])))
    assert.equal(boundary.filter(result=>result.rows[0].value.allowed).length, 1)
    assert.equal(boundary.filter(result=>!result.rows[0].value.allowed).length, 1)
    const admitted = boundary.find(result=>result.rows[0].value.allowed)
    const admittedId = boundaryIds[boundary.indexOf(admitted)]
    await db.query('select public.complete_ocr_scan($1,true)',[admittedId])
    assert.equal((await db.query('select public.get_my_entitlement() value')).rows[0].value.ocr.used, 10)

    await assert.rejects(db.query("update user_entitlements set plan='pro' where user_id=$1",[newcomer]))
    await assert.rejects(db.query("update ocr_scan_sessions set status='failed' where user_id=$1",[newcomer]))

    await db.exec('reset role')
    await db.query("update user_entitlements set plan='pro',source='test' where user_id=$1",[newcomer])
    await asUser(db,newcomer)
    const proAdmission = (await db.query("select public.begin_ocr_scan('00000000-0000-4000-8000-000000000027') value")).rows[0].value
    assert.equal(proAdmission.allowed,true)
    assert.equal(proAdmission.limit,null)

    await db.exec("reset role; update ocr_scan_sessions set month_start=(date_trunc('month',now() at time zone 'UTC')::date-interval '1 month')::date where user_id='"+newcomer+"'; update user_entitlements set plan='free',source='system' where user_id='"+newcomer+"'")
    await asUser(db,newcomer)
    assert.equal((await db.query('select public.get_my_entitlement() value')).rows[0].value.ocr.used,0)
  } finally { await db.close() }
})

test('expired reservations cannot be completed late to exceed the Free quota', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await entitlementSchema(db)
    await db.query('insert into auth.users(id) values($1)',[newcomer])
    await asUser(db,newcomer)
    for(let i=1;i<=9;i++){
      const id=`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`
      assert.equal((await db.query('select public.begin_ocr_scan($1) value',[id])).rows[0].value.allowed,true)
      await db.query('select public.complete_ocr_scan($1,true)',[id])
    }
    const expiredId='10000000-0000-4000-8000-000000000010'
    const replacementId='10000000-0000-4000-8000-000000000011'
    assert.equal((await db.query('select public.begin_ocr_scan($1) value',[expiredId])).rows[0].value.allowed,true)
    assert.equal((await db.query('select public.begin_ocr_scan($1) value',[replacementId])).rows[0].value.allowed,false)

    await db.exec('reset role')
    await db.query("update ocr_scan_sessions set updated_at=now()-interval '16 minutes' where id=$1",[expiredId])
    await asUser(db,newcomer)
    assert.equal((await db.query('select public.begin_ocr_scan($1) value',[replacementId])).rows[0].value.allowed,true)
    const late=(await db.query('select public.complete_ocr_scan($1,true) value',[expiredId])).rows[0].value
    assert.equal(late.counted,false)
    assert.equal(late.requires_readmission,true)
    assert.equal(late.reason,'failed_session')
    await db.query('select public.complete_ocr_scan($1,true)',[replacementId])
    assert.equal((await db.query("select count(*)::int count from ocr_scan_sessions where user_id=$1 and month_start=date_trunc('month',now() at time zone 'UTC')::date and status='succeeded'",[newcomer])).rows[0].count,10)
  } finally { await db.close() }
})

test('expired started sessions require readmission and completion retains admission month', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await entitlementSchema(db)
    await db.query('insert into auth.users(id) values($1)',[newcomer])
    await asUser(db,newcomer)
    const expiredId='20000000-0000-4000-8000-000000000001'
    await db.query('select public.begin_ocr_scan($1)',[expiredId])
    await db.exec('reset role')
    await db.query("update ocr_scan_sessions set updated_at=now()-interval '16 minutes' where id=$1",[expiredId])
    await asUser(db,newcomer)
    const expired=(await db.query('select public.complete_ocr_scan($1,true) value',[expiredId])).rows[0].value
    assert.equal(expired.counted,false)
    assert.equal(expired.requires_readmission,true)
    assert.equal(expired.reason,'expired_lease')
    assert.equal((await db.query('select public.begin_ocr_scan($1) value',[expiredId])).rows[0].value.allowed,true)
    assert.equal((await db.query('select public.complete_ocr_scan($1,true) value',[expiredId])).rows[0].value.counted,true)

    const rolloverId='20000000-0000-4000-8000-000000000002'
    await db.exec('reset role')
    await asUser(db,owner)
    await db.query('select public.begin_ocr_scan($1)',[rolloverId])
    await db.exec('reset role')
    await db.query("update ocr_scan_sessions set month_start=date '2026-08-01',started_at=timestamptz '2026-08-31 23:59:00+00',updated_at=now() where id=$1",[rolloverId])
    await asUser(db,owner)
    const rollover=(await db.query('select public.complete_ocr_scan($1,true) value',[rolloverId])).rows[0].value
    assert.equal(rollover.usage_month,'2026-08-01')
    assert.equal((await db.query("select month_start::text admission_month,status from ocr_scan_sessions where id=$1",[rolloverId])).rows[0].admission_month,'2026-08-01')
    assert.equal((await db.query("select count(*)::int count from ocr_scan_sessions where user_id=$1 and month_start=date '2026-08-01' and status='succeeded'",[owner])).rows[0].count,1)
  } finally { await db.close() }
})

test('Free dimension limits preserve grandfathered data and reject new escalation', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await entitlementSchema(db)
    assert.deepEqual((await db.query('select (select count(*)::int from entities where user_id=$1) entities,(select count(*)::int from projects where user_id=$1) projects,(select count(*)::int from categories where user_id=$1) categories',[owner])).rows[0],{entities:2,projects:2,categories:1})
    assert.equal((await db.query('select bool_and(is_grandfathered) preserved from entities where user_id=$1',[owner])).rows[0].preserved,true)

    await db.query('insert into auth.users(id) values($1)',[newcomer])
    await asUser(db,newcomer)
    await assert.rejects(db.query("insert into entities(user_id,name) values($1,'Second Entity')",[newcomer]),/multiple_entities/)
    await db.query("insert into projects(user_id,name) values($1,'First Project')",[newcomer])
    await assert.rejects(db.query("insert into projects(user_id,name) values($1,'Second Project')",[newcomer]),/multiple_projects/)
    await assert.rejects(db.query("insert into categories(user_id,name) values($1,'My Custom Category')",[newcomer]),/custom_categories/)
    await assert.rejects(db.query("update categories set name='Renamed Custom' where user_id=$1 and name='Fuel'",[newcomer]),/custom_categories/)
  } finally { await db.close() }
})

test('entitlement and OCR-session RLS isolate users', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await entitlementSchema(db)
    await db.query('insert into auth.users(id) values($1)',[newcomer])
    await assert.rejects(db.query('select public.get_my_entitlement()'),/Authentication required/)
    const tableGrants=(await db.query("select grantee,table_name,privilege_type from information_schema.role_table_grants where table_name in ('user_entitlements','ocr_scan_sessions') and grantee in ('anon','authenticated') order by grantee,table_name,privilege_type")).rows
    assert.deepEqual(tableGrants.map(row=>`${row.grantee}:${row.table_name}:${row.privilege_type}`),['authenticated:ocr_scan_sessions:SELECT','authenticated:user_entitlements:SELECT'])
    const policies=(await db.query("select tablename,roles,cmd from pg_policies where tablename in ('user_entitlements','ocr_scan_sessions') order by tablename")).rows
    assert.equal(policies.length,2)
    assert.ok(policies.every(policy=>policy.roles.includes('authenticated')&&policy.cmd==='SELECT'))
    await asUser(db,newcomer)
    await db.query("select public.begin_ocr_scan('00000000-0000-4000-8000-000000000099')")
    assert.equal((await db.query('select count(*)::int count from user_entitlements')).rows[0].count,1)
    assert.equal((await db.query('select count(*)::int count from ocr_scan_sessions')).rows[0].count,1)
    await db.exec(`select set_config('request.jwt.claim.sub','${owner}',false)`)
    assert.equal((await db.query('select count(*)::int count from user_entitlements')).rows[0].count,1)
    assert.equal((await db.query('select count(*)::int count from ocr_scan_sessions')).rows[0].count,0)
    await assert.rejects(db.query("select public.begin_ocr_scan('00000000-0000-4000-8000-000000000099')"),/another user/)
  } finally { await db.close() }
})
