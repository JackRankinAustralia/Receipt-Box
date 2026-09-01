const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821090000_add_user_managed_dimensions.sql'), 'utf8')
const lifecycleMigration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260901193000_add_receipt_workflow_lifecycle.sql'), 'utf8')

test('receipt lifecycle migration defaults legacy receipts to completed without changing ownership policies', () => {
  assert.match(lifecycleMigration, /alter table public\.receipts[\s\S]*add column if not exists workflow_status text not null default 'completed'/i)
  assert.match(lifecycleMigration, /add column if not exists reviewed_at timestamptz/i)
  assert.match(lifecycleMigration, /set workflow_status = 'completed'\s+where workflow_status is null/i)
  assert.match(lifecycleMigration, /check \(workflow_status in \('uploading', 'queued', 'reading', 'needs_review', 'needs_attention', 'completed'\)\)/i)
  assert.doesNotMatch(lifecycleMigration, /\b(?:create|alter|drop)\s+policy\b/i)
  assert.doesNotMatch(lifecycleMigration, /\b(?:grant|revoke)\b/i)
})

test('migration reconciles an already partially-created production schema', () => {
  for (const table of ['entities', 'categories', 'projects']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`, 'i'))
    assert.match(migration, new RegExp(`alter table public\\.${table}[\\s\\S]*?add column if not exists is_default`, 'i'))
  }
  for (const column of ['entity_id', 'category_id', 'project_id']) assert.match(migration, new RegExp(`add column if not exists ${column}`, 'i'))
  assert.match(migration, /drop policy if exists %I/i)
  assert.match(migration, /revoke all privileges on table public\.%I from anon/i)
  assert.match(migration, /grant select, insert, update, delete on table public\.%I to authenticated/i)
  assert.match(migration, /for update to authenticated using .* with check/i)
})

test('migration preserves historical text while backfilling relational IDs', () => {
  assert.doesNotMatch(migration, /set\s+(?:entity_name|category_name|project_name)\s*=/i)
  assert.match(migration, /set entity_id = d\.id[\s\S]*d\.user_id = r\.user_id/i)
  assert.match(migration, /set category_id = d\.id[\s\S]*d\.user_id = r\.user_id/i)
  assert.match(migration, /set project_id = d\.id[\s\S]*d\.user_id = r\.user_id/i)
  assert.match(migration, /lower\(btrim\(name\)\)/i)
})

test('composite foreign keys reject cross-user managed-dimension references', () => {
  for (const type of ['entity', 'category', 'project']) {
    const table = { entity: 'entities', category: 'categories', project: 'projects' }[type]
    assert.match(migration, new RegExp(`${table}_user_id_id_idx`, 'i'))
    assert.match(migration, new RegExp(`foreign key \\(user_id, ${type}_id\\)[\\s\\S]*references public\\.${table}\\(user_id, id\\)`, 'i'))
  }
  assert.match(migration, /foreign key \(user_id, entity_id\)[\s\S]*references public\.entities\(user_id, id\)/i)
  assert.match(migration, /alter table public\.projects validate constraint projects_user_entity_fkey/i)
})

test('transactional cleanup is executable only by service_role', () => {
  assert.match(migration, /create or replace function public\.delete_account_data\(target_user_id uuid\)/i)
  assert.match(migration, /security invoker/i)
  assert.match(migration, /revoke all on function public\.delete_account_data\(uuid\) from public/i)
  assert.match(migration, /revoke all on function public\.delete_account_data\(uuid\) from anon/i)
  assert.match(migration, /revoke all on function public\.delete_account_data\(uuid\) from authenticated/i)
  assert.match(migration, /grant execute on function public\.delete_account_data\(uuid\) to service_role/i)
  assert.match(migration, /delete from public\.receipts[\s\S]*delete from public\.projects[\s\S]*delete from public\.categories[\s\S]*delete from public\.entities/i)
})

async function workflow() {
  return import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'delete-account', 'workflow.mjs')).href)
}

test('Storage failure prevents database and Auth deletion', async () => {
  const { deleteAccountResources } = await workflow(), calls = []
  await assert.rejects(deleteAccountResources({
    listPaths: async () => ['owner/receipt/file.jpg'],
    removePaths: async () => { calls.push('storage'); throw Error('storage failed') },
    cleanupData: async () => calls.push('database'),
    deleteAuth: async () => calls.push('auth')
  }), /storage failed/)
  assert.deepEqual(calls, ['storage'])
})

test('database cleanup failure prevents Auth deletion and remains retryable', async () => {
  const { deleteAccountResources } = await workflow(), calls = []
  await assert.rejects(deleteAccountResources({
    listPaths: async () => [], removePaths: async () => calls.push('storage'),
    cleanupData: async () => { calls.push('database'); throw Error('transaction rolled back') },
    deleteAuth: async () => calls.push('auth')
  }), /transaction rolled back/)
  assert.deepEqual(calls, ['database'])
})

test('Auth deletion runs only after successful Storage and database cleanup', async () => {
  const { deleteAccountResources } = await workflow(), calls = []
  assert.equal(await deleteAccountResources({
    listPaths: async () => ['one'], removePaths: async () => calls.push('storage'),
    cleanupData: async () => calls.push('database'), deleteAuth: async () => calls.push('auth')
  }), true)
  assert.deepEqual(calls, ['storage', 'database', 'auth'])
})
