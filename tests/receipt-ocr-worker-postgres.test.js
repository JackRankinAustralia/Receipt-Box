const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const entitlementMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821150000_add_free_pro_entitlements.sql'), 'utf8')
const quotaMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260822100000_reduce_free_ocr_limit_to_10.sql'), 'utf8')
const lifecycleMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260901193000_add_receipt_workflow_lifecycle.sql'), 'utf8')
const admissionMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260902180000_add_receipt_scan_admission_fields.sql'), 'utf8')
const workerMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260903090000_add_receipt_ocr_worker_foundation.sql'), 'utf8')

const owner = '11111111-1111-4111-8111-111111111111'

async function workerSchema(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table entities(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,is_default boolean not null default false,is_archived boolean not null default false,updated_at timestamptz not null default now(),unique(user_id,name));
    create table categories(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,is_default boolean not null default false,is_archived boolean not null default false,updated_at timestamptz not null default now(),unique(user_id,name));
    create table projects(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),name text not null,is_default boolean not null default false,is_archived boolean not null default false,updated_at timestamptz not null default now(),unique(user_id,name));
    create table receipts(
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id),
      supplier text not null,
      receipt_date date,
      total numeric,
      gst numeric,
      file_path text,
      original_filename text,
      mime_type text,
      workflow_status text not null default 'completed'
    );
    insert into auth.users values ('${owner}');
    grant select, insert, update, delete on receipts, entities, categories, projects to service_role;
  `)
  await db.exec(entitlementMigration)
  await db.exec(quotaMigration)
  await db.exec(lifecycleMigration)
  await db.exec(admissionMigration)
  await db.exec(workerMigration)
}

async function insertQueuedReceipt(db, { id, scanSessionId = null, workflowStatus = 'queued', scanAttempts = 0, scanStartedAt = null }) {
  await db.query(
    `insert into receipts(id,user_id,supplier,file_path,mime_type,workflow_status,scan_session_id,scan_attempts,scan_started_at)
     values($1,$2,null,'path/to.jpg','image/jpeg',$3,$4,$5,$6)`,
    [id, owner, workflowStatus, scanSessionId, scanAttempts, scanStartedAt]
  )
}

test('claim_next_queued_receipt_service claims exactly one queued receipt and derives ownership from the row', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const receiptId = '40000000-0000-4000-8000-000000000001'
    await insertQueuedReceipt(db, { id: receiptId })

    await db.exec('set role service_role')
    const workerSessionId = '50000000-0000-4000-8000-000000000001'
    const claim = (await db.query('select public.claim_next_queued_receipt_service($1) value', [workerSessionId])).rows[0].value
    assert.equal(claim.claimed, true)
    assert.equal(claim.receipt_id, receiptId)
    assert.equal(claim.user_id, owner)
    assert.equal(claim.file_path, 'path/to.jpg')
    assert.equal(claim.mime_type, 'image/jpeg')
    assert.equal(claim.scan_session_id, workerSessionId)
    assert.equal(claim.scan_attempts, 1)

    const row = (await db.query('select workflow_status,scan_session_id,scan_attempts from receipts where id=$1', [receiptId])).rows[0]
    assert.equal(row.workflow_status, 'reading')
    assert.equal(row.scan_session_id, workerSessionId)
    assert.equal(row.scan_attempts, 1)

    const emptyClaim = (await db.query('select public.claim_next_queued_receipt_service($1) value', ['50000000-0000-4000-8000-000000000002'])).rows[0].value
    assert.equal(emptyClaim.claimed, false)
  } finally { await db.close() }
})

test('claim preserves an already-persisted scan_session_id on reclaim instead of overwriting it', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const receiptId = '40000000-0000-4000-8000-000000000002'
    const originalSessionId = '50000000-0000-4000-8000-000000000010'
    await insertQueuedReceipt(db, {
      id: receiptId, scanSessionId: originalSessionId, workflowStatus: 'reading',
      scanAttempts: 1, scanStartedAt: new Date(Date.now() - 15 * 60000).toISOString()
    })

    await db.exec('set role service_role')
    const claim = (await db.query('select public.claim_next_queued_receipt_service($1) value', ['50000000-0000-4000-8000-000000000011'])).rows[0].value
    assert.equal(claim.claimed, true)
    assert.equal(claim.scan_session_id, originalSessionId)
    assert.equal(claim.scan_attempts, 2)
  } finally { await db.close() }
})

test('stale reading rows are reclaimed only under the timeout and attempt cap; exhausted rows are left alone', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const freshReading = '40000000-0000-4000-8000-000000000003'
    const exhausted = '40000000-0000-4000-8000-000000000004'
    await insertQueuedReceipt(db, {
      id: freshReading, scanSessionId: '50000000-0000-4000-8000-000000000020', workflowStatus: 'reading',
      scanAttempts: 1, scanStartedAt: new Date().toISOString()
    })
    await insertQueuedReceipt(db, {
      id: exhausted, scanSessionId: '50000000-0000-4000-8000-000000000021', workflowStatus: 'reading',
      scanAttempts: 3, scanStartedAt: new Date(Date.now() - 15 * 60000).toISOString()
    })

    await db.exec('set role service_role')
    const claim = (await db.query('select public.claim_next_queued_receipt_service($1) value', ['50000000-0000-4000-8000-000000000022'])).rows[0].value
    assert.equal(claim.claimed, false)

    const rows = (await db.query('select id,workflow_status,scan_attempts from receipts order by id')).rows
    assert.deepEqual(rows, [
      { id: freshReading, workflow_status: 'reading', scan_attempts: 1 },
      { id: exhausted, workflow_status: 'reading', scan_attempts: 3 }
    ])
  } finally { await db.close() }
})

test('begin_receipt_ocr_service admits, respects Free quota, and cannot double-charge on retry', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const receiptId = '40000000-0000-4000-8000-000000000005'
    const sessionId = '50000000-0000-4000-8000-000000000030'
    await insertQueuedReceipt(db, { id: receiptId, scanSessionId: sessionId, workflowStatus: 'reading', scanAttempts: 1 })

    await db.exec('set role service_role')
    const first = (await db.query('select public.begin_receipt_ocr_service($1) value', [receiptId])).rows[0].value
    assert.equal(first.allowed, true)
    assert.equal(first.already_counted, false)

    const retry = (await db.query('select public.begin_receipt_ocr_service($1) value', [receiptId])).rows[0].value
    assert.equal(retry.allowed, true)

    await db.exec('reset role')
    assert.equal((await db.query("select count(*)::int count from ocr_scan_sessions where id=$1 and status='started'", [sessionId])).rows[0].count, 1)
  } finally { await db.close() }
})

test('begin_receipt_ocr_service rejects at the Free monthly limit and cannot be invoked by browser roles', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    await db.exec('set role service_role')
    for (let i = 1; i <= 10; i++) {
      const receiptId = `40000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
      const sessionId = `50000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`
      await insertQueuedReceipt(db, { id: receiptId, scanSessionId: sessionId, workflowStatus: 'reading', scanAttempts: 1 })
      await db.query('select public.begin_receipt_ocr_service($1)', [receiptId])
      await db.query('select public.complete_receipt_ocr_service($1,$2,true,$3,null,null,null,null)', [receiptId, sessionId, `Supplier ${i}`])
    }
    const overLimitReceipt = '40000000-0000-4000-8000-000000000199'
    const overLimitSession = '50000000-0000-4000-8000-000000000199'
    await insertQueuedReceipt(db, { id: overLimitReceipt, scanSessionId: overLimitSession, workflowStatus: 'reading', scanAttempts: 1 })
    const rejected = (await db.query('select public.begin_receipt_ocr_service($1) value', [overLimitReceipt])).rows[0].value
    assert.equal(rejected.allowed, false)
    assert.equal(rejected.reason, 'monthly_limit')

    await db.exec('reset role; set role authenticated')
    await assert.rejects(db.query('select public.begin_receipt_ocr_service($1)', [overLimitReceipt]))
    await assert.rejects(db.query("select public.claim_next_queued_receipt_service('50000000-0000-4000-8000-000000000200')"))
    await assert.rejects(db.query('select public.complete_receipt_ocr_service($1,$2,true)', [overLimitReceipt, overLimitSession]))
  } finally { await db.close() }
})

test('complete_receipt_ocr_service applies success fields and leaves reviewed_at untouched', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const receiptId = '40000000-0000-4000-8000-000000000006'
    const sessionId = '50000000-0000-4000-8000-000000000040'
    await insertQueuedReceipt(db, { id: receiptId, scanSessionId: sessionId, workflowStatus: 'reading', scanAttempts: 1 })

    await db.exec('set role service_role')
    await db.query('select public.begin_receipt_ocr_service($1)', [receiptId])
    const result = (await db.query(
      "select public.complete_receipt_ocr_service($1,$2,true,'Woolworths','2026-05-01',44.50,4.05,null) value",
      [receiptId, sessionId]
    )).rows[0].value
    assert.equal(result.applied, true)
    assert.equal(result.workflow_status, 'needs_review')

    const row = (await db.query('select workflow_status,supplier,receipt_date::text,total,gst,scan_error_summary,reviewed_at from receipts where id=$1', [receiptId])).rows[0]
    assert.equal(row.workflow_status, 'needs_review')
    assert.equal(row.supplier, 'Woolworths')
    assert.equal(row.receipt_date, '2026-05-01')
    assert.equal(Number(row.total), 44.5)
    assert.equal(Number(row.gst), 4.05)
    assert.equal(row.scan_error_summary, null)
    assert.equal(row.reviewed_at, null)
  } finally { await db.close() }
})

test('complete_receipt_ocr_service re-queues under the attempt cap and moves to needs_attention once exhausted', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const receiptId = '40000000-0000-4000-8000-000000000007'
    const sessionId = '50000000-0000-4000-8000-000000000050'
    await insertQueuedReceipt(db, { id: receiptId, scanSessionId: sessionId, workflowStatus: 'reading', scanAttempts: 2 })

    await db.exec('set role service_role')
    const underCap = (await db.query(
      "select public.complete_receipt_ocr_service($1,$2,false,null,null,null,null,'Gemini timed out') value",
      [receiptId, sessionId]
    )).rows[0].value
    assert.equal(underCap.workflow_status, 'queued')
    assert.equal((await db.query('select workflow_status,scan_error_summary from receipts where id=$1', [receiptId])).rows[0].workflow_status, 'queued')

    await db.query("update receipts set workflow_status='reading',scan_attempts=3 where id=$1", [receiptId])
    const atCap = (await db.query(
      "select public.complete_receipt_ocr_service($1,$2,false,null,null,null,null,'Gemini timed out') value",
      [receiptId, sessionId]
    )).rows[0].value
    assert.equal(atCap.workflow_status, 'needs_attention')
    const row = (await db.query('select workflow_status,scan_error_summary from receipts where id=$1', [receiptId])).rows[0]
    assert.equal(row.workflow_status, 'needs_attention')
    assert.equal(row.scan_error_summary, 'Gemini timed out')
  } finally { await db.close() }
})

test('complete_receipt_ocr_service moves a terminal/non-retryable failure to needs_attention immediately, without spending further attempts', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const receiptId = '40000000-0000-4000-8000-000000000009'
    const sessionId = '50000000-0000-4000-8000-000000000070'
    // Only the first of three attempts has been used, so a retryable failure
    // here would re-queue. A terminal failure must still go straight to
    // needs_attention despite attempts being well under the cap.
    await insertQueuedReceipt(db, { id: receiptId, scanSessionId: sessionId, workflowStatus: 'reading', scanAttempts: 1 })

    await db.exec('set role service_role')
    const terminal = (await db.query(
      "select public.complete_receipt_ocr_service($1,$2,false,null,null,null,null,'No meaningful receipt fields found',false) value",
      [receiptId, sessionId]
    )).rows[0].value
    assert.equal(terminal.workflow_status, 'needs_attention')

    const row = (await db.query('select workflow_status,scan_error_summary,scan_attempts from receipts where id=$1', [receiptId])).rows[0]
    assert.equal(row.workflow_status, 'needs_attention')
    assert.equal(row.scan_error_summary, 'No meaningful receipt fields found')
    assert.equal(row.scan_attempts, 1)
  } finally { await db.close() }
})

test('complete_receipt_ocr_service is a safe no-op for a stale/mismatched scan_session_id', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite()
  try {
    await workerSchema(db)
    const receiptId = '40000000-0000-4000-8000-000000000008'
    const staleSessionId = '50000000-0000-4000-8000-000000000060'
    const currentSessionId = '50000000-0000-4000-8000-000000000061'
    await insertQueuedReceipt(db, { id: receiptId, scanSessionId: currentSessionId, workflowStatus: 'reading', scanAttempts: 1 })

    await db.exec('set role service_role')
    const stale = (await db.query('select public.complete_receipt_ocr_service($1,$2,true) value', [receiptId, staleSessionId])).rows[0].value
    assert.equal(stale.applied, false)
    assert.equal(stale.reason, 'stale_session')

    const row = (await db.query('select workflow_status,scan_session_id from receipts where id=$1', [receiptId])).rows[0]
    assert.equal(row.workflow_status, 'reading')
    assert.equal(row.scan_session_id, currentSessionId)
  } finally { await db.close() }
})
