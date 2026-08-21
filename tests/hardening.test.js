const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

test('sign-out removes receipt, supplier, financial, settings and OCR data from state and DOM', async () => {
  const app = loadApp()
  let signOuts = 0
  app.setBackend({ auth: { async signOut() { signOuts++; return { error: null } } } }, { id: 'owner-a', email: 'owner@example.com' })
  app.setRows([{
    id: 'private-receipt', supplier: 'Private Supplier', receipt_date: '2026-08-18',
    total: 987.65, gst: 89.79, entity_id: 'private-entity', entity_name: 'Private Entity',
    category_id: 'private-category', category_name: 'Private Category', project_id: 'private-project',
    project_name: 'Private Project', notes: 'Private financial note', file_path: 'owner-a/private.jpg'
  }])
  app.setSettings({
    entities: [{ id: 'private-entity', name: 'Private Entity', is_default: true, is_archived: false }],
    categories: [{ id: 'private-category', name: 'Private Category', is_default: true, is_archived: false }],
    projects: [{ id: 'private-project', name: 'Private Project', is_default: true, is_archived: false }]
  })
  app.call('renderSettingChoices')
  app.call('renderSettings')
  app.call('renderRows')
  app.call('renderReports')
  app.call('openDetail', 'private-receipt')
  app.call('editReceipt', 'private-receipt')
  app.element('ocrDiagnosticsText').textContent = 'PRIVATE RAW OCR $987.65'
  app.element('ocrDiagnostics').classList.remove('hidden')
  app.element('fileName').textContent = 'private.jpg'
  app.element('receiptPreview').src = 'blob:private-preview'
  app.element('email').value = 'owner@example.com'
  app.element('password').value = 'private-password'
  app.element('newPassword').value = 'new-private-password'
  app.setPreviewUrl('blob:private-preview')

  await app.call('signOutCurrentUser')

  const state = app.state()
  assert.equal(state.user, null)
  assert.deepEqual(Array.from(state.allRows), [])
  assert.deepEqual(Array.from(state.receiptRows), [])
  assert.deepEqual(Object.fromEntries(Object.entries(state.settingsData).map(([key, value]) => [key, Array.from(value)])), { entities: [], categories: [], projects: [] })
  assert.equal(state.previewUrl, null)
  assert.deepEqual(app.revokedObjectUrls, ['blob:private-preview'])
  assert.equal(signOuts, 1)
  assert.equal(app.element('gate').classList.contains('hidden'), false)
  assert.equal(app.element('appShell').classList.contains('hidden'), true)
  assert.equal(app.element('supplier').value, '')
  assert.equal(app.element('amount').value, '')
  assert.equal(app.element('gst').value, '')
  assert.equal(app.element('notes').value, '')
  assert.equal(app.element('email').value, '')
  assert.equal(app.element('password').value, '')
  assert.equal(app.element('newPassword').value, '')
  assert.equal(app.element('saveBtn').dataset.edit, undefined)
  assert.equal(app.element('receiptPreview').src, undefined)
  assert.equal(app.element('ocrDiagnosticsText').textContent, '')
  assert.equal(app.element('ocrDiagnostics').classList.contains('hidden'), true)
  assert.equal(app.element('receipts').innerHTML, 'No receipts yet.')
  assert.equal(app.element('total').textContent, '$0.00')
  assert.equal(app.element('gstTotal').textContent, '$0.00')
  assert.equal(app.element('reportTotal').textContent, '$0.00')
  assert.equal(app.element('reportGST').textContent, '$0.00')
  assert.equal(app.element('reportCount').textContent, 0)
  const visibleData = ['receipts', 'detailBody', 'entitiesList', 'categoriesList', 'projectsList', 'categoryReport', 'entityReport', 'monthlyReport']
    .map(id => `${app.element(id).innerHTML} ${app.element(id).textContent} ${app.element(id).value}`).join(' ')
  assert.doesNotMatch(visibleData, /Private Supplier|Private Entity|Private Category|Private Project|987\.65|financial note/i)
})

test('a receipt load started by the previous user cannot repopulate data after sign-out', async () => {
  const app = loadApp()
  let finishReceiptLoad
  const delayedReceipts = new Promise(resolve => { finishReceiptLoad = resolve })
  app.setBackend({
    from(table) {
      if (table === 'receipts') return { select() { return { order: () => delayedReceipts } } }
      return { select() { return { order: async () => ({ data: [], error: null }) } } }
    },
    auth: { async signOut() { return { error: null } } }
  }, { id: 'owner-a' })

  const loading = app.call('load')
  app.call('showSignedOutState')
  finishReceiptLoad({ data: [{ id: 'late-row', supplier: 'Late Private Supplier', total: 500 }], error: null })
  await loading

  assert.deepEqual(Array.from(app.state().allRows), [])
  assert.equal(app.element('receipts').innerHTML, 'No receipts yet.')
  assert.doesNotMatch(`${app.element('receipts').innerHTML} ${app.element('supplier').value}`, /Late Private Supplier|500/)
})

test('composite foreign-key migration adds only the four non-redundant referencing indexes', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821133000_add_composite_fk_indexes.sql'), 'utf8')
  const expected = [
    /receipts_user_entity_idx\s+on public\.receipts \(user_id, entity_id\)/i,
    /receipts_user_category_idx\s+on public\.receipts \(user_id, category_id\)/i,
    /receipts_user_project_idx\s+on public\.receipts \(user_id, project_id\)/i,
    /projects_user_entity_idx\s+on public\.projects \(user_id, entity_id\)/i
  ]
  expected.forEach(pattern => assert.match(migration, pattern))
  assert.equal((migration.match(/create index if not exists/gi) || []).length, 4)
  assert.doesNotMatch(migration, /on public\.receipts \(user_id\)\s*;/i)
})
