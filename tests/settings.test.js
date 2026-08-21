const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

function settingsBackend() {
  const tables = {
    entities: [{ id: 'e1', user_id: 'test-user', name: 'National Events', is_default: true, is_archived: false }],
    categories: [{ id: 'c1', user_id: 'test-user', name: 'Other', is_default: true, is_archived: false }],
    projects: [{ id: 'p1', user_id: 'test-user', name: 'Expo', is_default: false, is_archived: false }],
    receipts: [{ id: 'r1', user_id: 'test-user', entity_id: 'e1', entity_name: 'National Events', category_id: 'c1', category_name: 'Other', project_id: 'p1', project_name: 'Expo' }]
  }
  let next = 2
  const calls = { functionInvocations: [], signOuts: 0 }
  const api = {
    tables, calls,
    from(table) {
      return {
        select() { return { order: async () => ({ data: tables[table].map(row => ({ ...row })), error: null }) } },
        insert(payload) {
          const row = { id: `${table[0]}${next++}`, is_default: false, is_archived: false, ...payload }
          tables[table].push(row)
          return { select() { return { single: async () => ({ data: { ...row }, error: null }) } } }
        },
        update(payload) { return { eq: async (column, value) => { tables[table].filter(row => row[column] === value).forEach(row => Object.assign(row, payload)); return { error: null } } } },
        delete() { return { eq: async (column, value) => { tables[table] = tables[table].filter(row => row[column] !== value); return { error: null } } } }
      }
    },
    auth: {
      async updateUser() { return { error: null } },
      async resetPasswordForEmail() { return { error: null } },
      async signOut() { calls.signOuts++; return { error: null } }
    },
    functions: { async invoke(name) { calls.functionInvocations.push(name); return { data: { deleted: true }, error: null } } }
  }
  return api
}

function prepareApp() {
  const app = loadApp(), db = settingsBackend()
  app.setBackend(db, { id: 'test-user', email: 'owner@example.com' })
  app.setRows(db.tables.receipts)
  app.setSettings({ entities: db.tables.entities, categories: db.tables.categories, projects: db.tables.projects })
  return { app, db }
}

test('entity, category and project records support add, rename, archive, restore and safe delete', async () => {
  const { app, db } = prepareApp()
  for (const [table, input] of [['entities', 'newEntity'], ['categories', 'newCategory'], ['projects', 'newProject']]) {
    app.element(input).value = `New ${table}`
    const added = await app.call('addSetting', table)
    assert.equal(added.user_id, 'test-user')
    await app.call('renameSetting', table, added.id, `Renamed ${table}`)
    assert.equal(db.tables[table].find(row => row.id === added.id).name, `Renamed ${table}`)
    await app.call('archiveSetting', table, added.id, true)
    assert.equal(db.tables[table].find(row => row.id === added.id).is_archived, true)
    await app.call('archiveSetting', table, added.id, false)
    assert.equal(await app.call('deleteSetting', table, added.id), true)
    assert.equal(db.tables[table].some(row => row.id === added.id), false)
  }
})

test('defaults are exclusive per setting type and drive new receipt values', async () => {
  const { app } = prepareApp()
  app.element('newEntity').value = 'Personal'
  const personal = await app.call('addSetting', 'entities')
  await app.call('setDefaultSetting', 'entities', personal.id)
  app.call('resetReceiptForm')
  assert.equal(app.element('entity').value, 'Personal')
  const defaults = app.call('defaultSetting', 'entities')
  assert.equal(defaults.id, personal.id)
})

test('renaming a used setting preserves the receipt assignment and deleting it is blocked', async () => {
  const { app, db } = prepareApp()
  await app.call('renameSetting', 'projects', 'p1', 'Spring Expo')
  assert.equal(db.tables.receipts[0].project_id, 'p1')
  assert.equal(db.tables.receipts[0].project_name, 'Spring Expo')
  assert.equal(await app.call('deleteSetting', 'projects', 'p1'), false)
  assert.equal(db.tables.projects.length, 1)
})

test('settings navigation exposes the signed-in email and returns to receipts', () => {
  const { app } = prepareApp()
  app.call('openSettings')
  assert.equal(app.element('accountEmail').value, 'owner@example.com')
  assert.equal(app.element('mainArea').classList.contains('hidden'), true)
  assert.equal(app.element('settingsArea').classList.contains('hidden'), false)
  app.call('closeSettings')
  assert.equal(app.element('mainArea').classList.contains('hidden'), false)
})

test('account deletion requires confirmation and calls the server cleanup endpoint before sign-out', async () => {
  const { app, db } = prepareApp()
  app.setConfirm(false)
  assert.equal(await app.call('deleteAccount'), false)
  assert.deepEqual(db.calls.functionInvocations, [])
  app.setConfirm(true)
  assert.equal(await app.call('deleteAccount'), true)
  assert.deepEqual(db.calls.functionInvocations, ['delete-account'])
  assert.equal(db.calls.signOuts, 1)
})

test('new tables enforce owner-only RLS and account cleanup deletes Auth last', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821090000_add_user_managed_dimensions.sql'), 'utf8')
  assert.match(migration, /foreach table_name in array array\['entities', 'categories', 'projects'\]/i)
  assert.match(migration, /alter table public\.%I enable row level security/i)
  assert.match(migration, /revoke all privileges on table public\.%I from anon/i)
  assert.match(migration, /grant select, insert, update, delete on table public\.%I to authenticated/i)
  assert.match(migration, /to authenticated using \(\(select auth\.uid\(\)\) = user_id\)/i)
  assert.match(migration, /to authenticated with check \(\(select auth\.uid\(\)\) = user_id\)/i)
  assert.equal((migration.match(/one_default_per_user/g) || []).length, 3)
  const edge = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'delete-account', 'index.ts'), 'utf8')
  assert.ok(edge.indexOf('storage.from("receipts").remove') < edge.indexOf('admin.auth.admin.deleteUser'))
  assert.ok(edge.indexOf('admin.rpc("delete_account_data"') < edge.indexOf('admin.auth.admin.deleteUser'))
  assert.match(edge, /authenticated\.auth\.getUser\(\)/)
  assert.doesNotMatch(edge, /body\.user_id|body\.userId/)
})
