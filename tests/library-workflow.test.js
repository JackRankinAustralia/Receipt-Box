const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

function receipt(overrides = {}) {
  return {
    id: 'receipt-1', user_id: 'test-user', supplier: 'Alpha Supplies',
    receipt_date: '2026-08-10', total: 25, gst: 2.27,
    entity_name: 'AWTCO', category_name: 'Office Supplies',
    project_name: 'Expo', notes: 'Original', file_path: 'test-user/receipt-1/image.jpg',
    original_filename: 'image.jpg', mime_type: 'image/jpeg', ...overrides
  }
}

function backend(initialRows = []) {
  const rows = initialRows.map(row => ({ ...row }))
  const dimensions = {
    entities: [{ id: 'entity-national', user_id: 'test-user', name: 'National Events', is_default: true, is_archived: false }, { id: 'entity-awtco', user_id: 'test-user', name: 'AWTCO', is_default: false, is_archived: false }, { id: 'entity-personal', user_id: 'test-user', name: 'Personal', is_default: false, is_archived: false }],
    categories: [{ id: 'category-other', user_id: 'test-user', name: 'Other', is_default: true, is_archived: false }, { id: 'category-equipment', user_id: 'test-user', name: 'Equipment', is_default: false, is_archived: false }, { id: 'category-travel', user_id: 'test-user', name: 'Travel', is_default: false, is_archived: false }, { id: 'category-office', user_id: 'test-user', name: 'Office Supplies', is_default: false, is_archived: false }],
    projects: [{ id: 'project-expo', user_id: 'test-user', name: 'Expo', is_default: false, is_archived: false }, { id: 'project-showground', user_id: 'test-user', name: 'Showground', is_default: false, is_archived: false }, { id: 'project-updated', user_id: 'test-user', name: 'Updated project', is_default: false, is_archived: false }]
  }
  const calls = { inserts: [], updates: [], deletes: [], uploads: [], removes: [] }
  const api = {
    calls,
    rows,
    from(table) {
      if (dimensions[table]) return {
        select() { return { order: async () => ({ data: dimensions[table].map(row => ({ ...row })), error: null }) } },
        update(payload) { return { eq: async (_column, id) => { const row = dimensions[table].find(item => item.id === id); if (row) Object.assign(row, payload); return { error: null } } } },
        delete() { return { eq: async (_column, id) => { const index = dimensions[table].findIndex(item => item.id === id); if (index >= 0) dimensions[table].splice(index, 1); return { error: null } } } }
      }
      return {
        select() { return { order: async () => ({ data: rows.map(row => ({ ...row })), error: null }) } },
        async insert(payload) { calls.inserts.push({ ...payload }); rows.push({ ...payload }); return { error: null } },
        update(payload) {
          return { eq: async (_column, id) => {
            calls.updates.push({ id, payload: { ...payload } })
            const index = rows.findIndex(row => row.id === id)
            if (index >= 0) rows[index] = { ...rows[index], ...payload }
            return { error: null }
          } }
        },
        delete() {
          return { eq: async (_column, id) => {
            calls.deletes.push(id)
            const index = rows.findIndex(row => row.id === id)
            if (index >= 0) rows.splice(index, 1)
            return { error: null }
          } }
        }
      }
    },
    storage: { from() { return {
      async upload(path, file) { calls.uploads.push({ path, file }); return { error: null } },
      async remove(paths) { calls.removes.push(paths); return { error: null } },
      async createSignedUrl() { return { data: { signedUrl: 'https://example.test/receipt' }, error: null } }
    } } }
  }
  return api
}

function deferred() {
  let resolve, reject
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

async function waitFor(condition) {
  while (!condition()) await new Promise(resolve => setImmediate(resolve))
}

function fillForm(app, values = {}) {
  const defaults = {
    supplier: 'Corrected Supplier', date: '2026-08-17', amount: '88.40', gst: '8.04',
    entity: 'AWTCO', category: 'Equipment', project: 'Showground', notes: 'Manually corrected after OCR'
  }
  for (const [id, value] of Object.entries({ ...defaults, ...values })) app.element(id).value = value
}

test('save preserves manual OCR corrections and keeps the saved receipt open for review', async () => {
  const app = loadApp()
  const db = backend()
  app.setBackend(db)
  await app.call('loadSettings')
  fillForm(app)

  const result = await app.call('save')

  assert.equal(db.calls.inserts.length, 1)
  assert.equal(db.calls.inserts[0].supplier, 'Corrected Supplier')
  assert.equal(db.calls.inserts[0].total, 88.40)
  assert.equal(db.calls.inserts[0].notes, 'Manually corrected after OCR')
  assert.equal(result.id, 'new-receipt-id')
  assert.equal(app.element('amount').value, '88.40')
  assert.equal(app.element('saveBtn').dataset.edit, 'new-receipt-id')
  assert.match(app.element('saveMsg').innerHTML, /Receipt saved/i)
})

test('Save & add another saves once then fully resets transient receipt state', async () => {
  const app = loadApp()
  const db = backend()
  app.setBackend(db)
  await app.call('loadSettings')
  fillForm(app)
  app.element('cameraFile').files = [new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })]
  app.call('showPreview')
  app.call('rotateReceiptPreview')
  app.element('ocrStatus').textContent = 'OCR complete'
  app.element('ocrDiagnosticsText').textContent = 'diagnostics'

  const result = await app.call('saveAndAddAnother')

  assert.equal(db.calls.inserts.length, 1)
  assert.equal(db.calls.uploads.length, 1)
  assert.equal(result.addAnother, true)
  for (const id of ['supplier', 'amount', 'gst', 'project', 'notes', 'cameraFile', 'libraryFile']) assert.equal(app.element(id).value, '')
  assert.equal(app.element('date').value, '2026-08-18')
  assert.equal(app.element('entity').value, 'National Events')
  assert.equal(app.element('category').value, 'Other')
  assert.equal(app.element('previewFrame').style.display, 'none')
  assert.equal(app.element('receiptPreview').style.transform, '')
  assert.equal(app.element('ocrDiagnosticsText').textContent, '')
  assert.match(app.element('ocrStatus').innerHTML, /Read receipt automatically/)
  assert.match(app.element('saveMsg').innerHTML, /Ready for the next receipt/i)
  assert.equal(db.rows.length, 1)
})

test('sorts, searches, and filters the receipt library without mutating source rows', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'b', supplier: 'Zulu Fuel', receipt_date: '2026-07-01', total: 90, entity_name: 'AWTCO', category_name: 'Fuel' }),
    receipt({ id: 'a', supplier: 'Alpha Office', receipt_date: '2026-08-15', total: 20, entity_name: 'National Events', category_name: 'Office Supplies' }),
    receipt({ id: 'c', supplier: 'Metro Hire', receipt_date: '2026-08-05', total: 55, entity_name: 'AWTCO', category_name: 'Equipment', project_name: 'Festival' })
  ]
  const ids = options => Array.from(app.call('filterAndSortReceipts', rows, options), row => row.id)
  assert.deepEqual(ids({ sort: 'newest' }), ['a', 'c', 'b'])
  assert.deepEqual(ids({ sort: 'oldest' }), ['b', 'c', 'a'])
  assert.deepEqual(ids({ sort: 'supplier' }), ['a', 'c', 'b'])
  assert.deepEqual(ids({ sort: 'highest' }), ['b', 'c', 'a'])
  assert.deepEqual(ids({ sort: 'lowest' }), ['a', 'c', 'b'])
  assert.deepEqual(ids({ query: 'festival', entity: 'AWTCO', dateFrom: '2026-08-01', dateTo: '2026-08-31' }), ['c'])
  assert.deepEqual(rows.map(row => row.id), ['b', 'a', 'c'])
})

test('editing updates the existing receipt with every editable field and does not insert a duplicate', async () => {
  const app = loadApp()
  const db = backend([receipt()])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  app.call('editReceipt', 'receipt-1')
  assert.equal(app.state().receiptMode, 'edit')
  assert.equal(app.state().editingExistingReceipt, true)
  fillForm(app, { supplier: 'Updated Supplier', date: '2026-08-18', amount: '101.20', gst: '9.20', entity: 'Personal', category: 'Travel', project: 'Updated project', notes: 'Updated notes' })

  await app.call('save')

  assert.equal(db.calls.inserts.length, 0)
  assert.equal(db.calls.updates.length, 1)
  assert.equal(db.calls.updates[0].id, 'receipt-1')
  assert.deepEqual(
    Object.fromEntries(['supplier', 'receipt_date', 'total', 'gst', 'entity_name', 'category_name', 'project_name', 'notes'].map(key => [key, db.calls.updates[0].payload[key]])),
    { supplier: 'Updated Supplier', receipt_date: '2026-08-18', total: 101.2, gst: 9.2, entity_name: 'Personal', category_name: 'Travel', project_name: 'Updated project', notes: 'Updated notes' }
  )
  assert.equal(db.rows.length, 1)
})

test('selecting a new receipt after saving creates a new receipt instead of updating the prior one', async () => {
  const app = loadApp(), db = backend()
  app.setBackend(db)
  await app.call('loadSettings')
  fillForm(app, { supplier: 'Receipt A' })
  await app.call('save')
  app.element('libraryFile').files = [new File([new Uint8Array([1])], 'receipt-b.jpg', { type: 'image/jpeg' })]
  app.setFunction('prepareReceiptFile', async file => file)
  await app.call('handleReceiptSelection', app.element('libraryFile').files[0])
  fillForm(app, { supplier: 'Receipt B' })
  await app.call('save')
  assert.equal(db.calls.inserts.length, 2)
  assert.equal(db.calls.updates.length, 0)
})

test('prevents overlapping saves and restores controls after a failed save', async () => {
  const app = loadApp(), db = backend(), upload = deferred()
  db.storage.from = () => ({
    upload: async () => upload.promise,
    remove: async () => ({ error: null }),
    createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/receipt' }, error: null })
  })
  app.setBackend(db)
  await app.call('loadSettings')
  app.element('libraryFile').files = [new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })]
  fillForm(app)
  const first = app.call('save')
  assert.equal(app.element('saveBtn').disabled, true)
  assert.equal(app.element('saveAnotherBtn').disabled, true)
  assert.equal(app.element('saveMsg').textContent, 'Saving receipt…')
  await app.call('save')
  assert.equal(db.calls.inserts.length, 0)
  upload.resolve({ error: new Error('Upload failed') })
  assert.equal(await first, null)
  assert.equal(app.element('saveBtn').disabled, false)
  assert.equal(app.element('saveAnotherBtn').disabled, false)
})

test('ignores Gemini fields after the active receipt selection changes', async () => {
  const app = loadApp(), db = backend(), scan = deferred()
  db.rpc = async name => name === 'begin_ocr_scan' ? { data: { allowed: true }, error: null } : { data: {}, error: null }
  app.setBackend(db)
  app.element('libraryFile').files = [new File([new Uint8Array([1])], 'receipt-a.jpg', { type: 'image/jpeg', lastModified: Date.now() })]
  let scanStarted = false
  app.setFunction('fileToBase64', async () => 'test-image')
  app.setFunction('scanReceiptWithGemini', async () => { scanStarted = true; return scan.promise })
  app.setFunction('prepareReceiptFile', async file => file)
  app.run('receiptOCRReady = true; receiptSelectionGeneration = 1')
  const reading = app.call('readReceiptWithGemini')
  while (!scanStarted) await new Promise(resolve => setImmediate(resolve))
  const receiptB = new File([new Uint8Array([2])], 'receipt-b.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [receiptB]
  await app.call('handleReceiptSelection', receiptB)
  scan.resolve({ supplier: 'Stale supplier', date: '2025-10-23', total: 25.23, gst: 2.29 })
  await reading
  assert.equal(app.element('supplier').value, '')
  assert.equal(app.element('date').value, '2026-08-18')
  assert.equal(app.element('amount').value, '')
})

test('selecting an image automatically reads and fills receipt fields once', async () => {
  const app = loadApp(), db = backend()
  db.rpc = async name => name === 'begin_ocr_scan' ? { data: { allowed: true }, error: null } : { data: {}, error: null }
  app.setBackend(db)
  let reads = 0
  app.setFunction('prepareReceiptFile', async file => file)
  app.setFunction('fileToBase64', async () => 'test-image')
  app.setFunction('scanReceiptWithGemini', async () => { reads++; return { supplier: 'APCO Wangaratta', date: '2025-10-23', total: 25.23, gst: 2.29 } })
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [image]
  await app.call('handleReceiptSelection', image)
  await waitFor(() => reads === 1)
  await waitFor(() => app.element('supplier').value === 'APCO Wangaratta')
  assert.equal(app.element('date').value, '2025-10-23')
  assert.equal(app.element('amount').value, '25.23')
  assert.equal(app.element('gst').value, '2.29')
  assert.match(app.element('ocrStatus').innerHTML, /Receipt details filled in/i)
  await app.call('readReceiptWithGemini')
  assert.equal(reads, 2, 'Read again remains available after automatic reading')
})

test('does not auto-read PDFs and leaves them available for saving', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.match(html, /if\(f\.type==='application\/pdf'\)\{[\s\S]*?return\}await handleReceiptFileInput/)
  assert.doesNotMatch(html, /if\(f\.type==='application\/pdf'\)\{[\s\S]*?startAutomaticReceiptReading/)
})

test('automatic reading respects the existing Free-plan admission result', async () => {
  const app = loadApp(), db = backend()
  db.rpc = async name => name === 'begin_ocr_scan' ? { data: { allowed: false }, error: null } : { data: {}, error: null }
  app.setBackend(db)
  let reads = 0
  app.setFunction('prepareReceiptFile', async file => file)
  app.setFunction('scanReceiptWithGemini', async () => { reads++ })
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [image]
  await app.call('handleReceiptSelection', image)
  await waitFor(() => !app.state().saveInProgress && app.element('ocrStatus').innerHTML.includes('Automatic reading is unavailable'))
  assert.equal(reads, 0)
  assert.equal(app.element('readBtn').disabled, false)
})

test('selecting B during automatic reading keeps B as the active scan and rejects A', async () => {
  const app = loadApp(), db = backend(), scanA = deferred()
  db.rpc = async name => name === 'begin_ocr_scan' ? { data: { allowed: true }, error: null } : { data: {}, error: null }
  app.setBackend(db)
  app.setFunction('prepareReceiptFile', async file => file)
  app.setFunction('fileToBase64', async () => 'test-image')
  let reads = 0
  app.setFunction('scanReceiptWithGemini', async () => ++reads === 1 ? scanA.promise : { supplier: 'Receipt B', date: '2025-10-24', total: 30, gst: 2.73 })
  const receiptA = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [receiptA]
  await app.call('handleReceiptSelection', receiptA)
  await waitFor(() => reads === 1)
  const receiptB = new File([new Uint8Array([2])], 'b.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [receiptB]
  await app.call('handleReceiptSelection', receiptB)
  await waitFor(() => reads === 2 && app.element('supplier').value === 'Receipt B')
  scanA.resolve({ supplier: 'Receipt A', date: '2025-10-23', total: 25.23, gst: 2.29 })
  await waitFor(() => !app.state().ocrReading)
  assert.equal(app.element('supplier').value, 'Receipt B')
  assert.equal(app.element('date').value, '2025-10-24')
})

test('does not start two automatic scans for one image selection', async () => {
  const app = loadApp(), db = backend(), scan = deferred()
  db.rpc = async name => name === 'begin_ocr_scan' ? { data: { allowed: true }, error: null } : { data: {}, error: null }
  app.setBackend(db)
  app.setFunction('prepareReceiptFile', async file => file)
  app.setFunction('fileToBase64', async () => 'test-image')
  let reads = 0
  app.setFunction('scanReceiptWithGemini', async () => { reads++; return scan.promise })
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [image]
  await app.call('handleReceiptSelection', image)
  await waitFor(() => reads === 1)
  await app.call('readReceiptWithGemini')
  assert.equal(reads, 1)
  scan.resolve({ supplier: 'Single scan', date: '2025-10-23', total: 25.23, gst: 2.29 })
  await waitFor(() => !app.state().ocrReading)
})

test('delete requires explicit confirmation and removes the stored attachment and row', async () => {
  const app = loadApp()
  const db = backend([receipt()])
  app.setBackend(db)
  app.setRows(db.rows)
  app.setConfirm(false)
  await app.call('deleteReceipt', 'receipt-1')
  assert.equal(db.calls.deletes.length, 0)

  app.setConfirm(true)
  const deleted = await app.call('deleteReceipt', 'receipt-1')
  assert.equal(deleted, true)
  assert.equal(JSON.stringify(db.calls.removes), JSON.stringify([['test-user/receipt-1/image.jpg']]))
  assert.deepEqual(db.calls.deletes, ['receipt-1'])
  assert.equal(db.rows.length, 0)
})
