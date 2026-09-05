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
  const calls = { inserts: [], updates: [], deletes: [], uploads: [], removes: [], signedUrls: [] }
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
      async upload(path, file) { calls.uploads.push({ path, file }); if (api.uploadShouldFail) return { error: Error('Simulated storage upload failure') }; return { error: null } },
      async remove(paths) { calls.removes.push(paths); return { error: null } },
      async createSignedUrl(path) { calls.signedUrls.push(path); return { data: { signedUrl: 'https://example.test/receipt' }, error: null } }
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
  assert.equal(db.calls.inserts[0].workflow_status, 'completed')
  assert.match(db.calls.inserts[0].reviewed_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(result.id, 'new-receipt-id')
  assert.equal(app.element('amount').value, '88.40')
  assert.equal(app.element('saveBtn').dataset.edit, 'new-receipt-id')
  assert.match(app.element('saveMsg').innerHTML, /Receipt saved\.<\/strong> You can keep editing, add another, or view it in Receipts\./i)
})

test('dashboard totals exclude incomplete receipts', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'completed', total: 25, gst: 2.27, workflow_status: 'completed' }),
    receipt({ id: 'needs-review', total: 100, gst: 9.09, workflow_status: 'needs_review' })
  ])
  app.setBackend(db)

  await app.call('load')

  assert.equal(app.element('total').textContent, '$25.00')
  assert.equal(app.element('gstTotal').textContent, '$2.27')
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
  assert.match(app.element('ocrStatus').textContent, /Receipt Box reads new receipt photos automatically\. Use Read again if you want to scan this image again\./)
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

test('editing populates the saved fields and updates the existing receipt without automatic reading', async () => {
  const app = loadApp()
  const db = backend([receipt()])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  let reads = 0
  app.setFunction('scanReceiptWithGemini', async () => { reads++ })
  await app.call('editReceipt', 'receipt-1')
  assert.equal(app.state().receiptMode, 'edit')
  assert.equal(app.state().editingExistingReceipt, true)
  assert.equal(app.element('supplier').value, 'Alpha Supplies')
  assert.equal(app.element('date').value, '2026-08-10')
  assert.equal(app.element('amount').value, 25)
  assert.equal(app.element('gst').value, 2.27)
  assert.equal(app.element('entity').value, 'AWTCO')
  assert.equal(app.element('category').value, 'Office Supplies')
  assert.equal(app.element('project').value, 'Expo')
  assert.equal(app.element('notes').value, 'Original')
  assert.equal(app.element('receiptPreview').src, 'https://example.test/receipt')
  assert.equal(app.element('previewFrame').style.display, 'grid')
  assert.equal(reads, 0)
  fillForm(app, { supplier: 'Updated Supplier', date: '2026-08-18', amount: '101.20', gst: '9.20', entity: 'Personal', category: 'Travel', project: 'Updated project', notes: 'Updated notes' })

  await app.call('save')

  assert.equal(db.calls.inserts.length, 0)
  assert.equal(db.calls.updates.length, 1)
  assert.equal(db.calls.updates[0].id, 'receipt-1')
  assert.equal(db.calls.updates[0].payload.workflow_status, 'completed')
  assert.match(db.calls.updates[0].payload.reviewed_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(
    Object.fromEntries(['supplier', 'receipt_date', 'total', 'gst', 'entity_name', 'category_name', 'project_name', 'notes'].map(key => [key, db.calls.updates[0].payload[key]])),
    { supplier: 'Updated Supplier', receipt_date: '2026-08-18', total: 101.2, gst: 9.2, entity_name: 'Personal', category_name: 'Travel', project_name: 'Updated project', notes: 'Updated notes' }
  )
  assert.equal(db.rows.length, 1)
  assert.match(app.element('saveMsg').innerHTML, /Receipt updated\.<\/strong> You can keep editing, add another, or view it in Receipts\./i)
})

test('editing from the Receipt Library activates the Add Receipt tab without reading the receipt', async () => {
  const app = loadApp(), db = backend([receipt()])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  app.call('activateMainTab', 'receipts')
  let reads = 0
  app.setFunction('scanReceiptWithGemini', async () => { reads++ })

  await app.call('editReceipt', 'receipt-1')

  const [tabbar, , addView, , receiptsView] = app.element('mainArea').children
  assert.equal(tabbar.children[0].classList.contains('active'), true)
  assert.equal(tabbar.children[0]['aria-selected'], 'true')
  assert.equal(addView.classList.contains('hidden'), false)
  assert.equal(receiptsView.classList.contains('hidden'), true)
  assert.equal(app.element('supplier').value, 'Alpha Supplies')
  assert.equal(app.element('receiptPreview').src, 'https://example.test/receipt')
  assert.equal(reads, 0)
})

test('editing from the receipt detail view activates the Add Receipt tab', async () => {
  const app = loadApp(), db = backend([receipt()])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  app.call('activateMainTab', 'receipts')

  app.call('openDetail', 'receipt-1')
  app.element('modalEditReceipt').onclick()
  await waitFor(() => app.state().receiptMode === 'edit')

  const [tabbar, , addView, , receiptsView] = app.element('mainArea').children
  assert.equal(tabbar.children[0].classList.contains('active'), true)
  assert.equal(addView.classList.contains('hidden'), false)
  assert.equal(receiptsView.classList.contains('hidden'), true)
  assert.equal(app.element('supplier').value, 'Alpha Supplies')
})

test('a stale stored image preview cannot replace a newer receipt selection', async () => {
  const app = loadApp(), db = backend([receipt()]), signedUrl = deferred()
  db.storage.from = () => ({
    upload: async () => ({ error: null }),
    remove: async () => ({ error: null }),
    createSignedUrl: async () => signedUrl.promise
  })
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  const editing = app.call('editReceipt', 'receipt-1')
  const receiptB = new File([new Uint8Array([1])], 'receipt-b.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [receiptB]
  app.setFunction('prepareReceiptFile', async file => file)
  await app.call('handleReceiptSelection', receiptB)
  signedUrl.resolve({ data: { signedUrl: 'https://example.test/receipt-a' }, error: null })
  await editing
  assert.notEqual(app.element('receiptPreview').src, 'https://example.test/receipt-a')
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

test('selecting a new image while editing creates a new receipt and may read it automatically', async () => {
  const app = loadApp(), db = backend([receipt()])
  db.rpc = async name => name === 'begin_ocr_scan' ? { data: { allowed: true }, error: null } : { data: {}, error: null }
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('editReceipt', 'receipt-1')
  let reads = 0
  app.setFunction('prepareReceiptFile', async file => file)
  app.setFunction('fileToBase64', async () => 'test-image')
  app.setFunction('scanReceiptWithGemini', async () => { reads++; return { supplier: 'Receipt B', date: '2025-10-24', total: 30, gst: 2.73 } })
  const receiptB = new File([new Uint8Array([1])], 'receipt-b.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [receiptB]
  await app.call('handleReceiptSelection', receiptB)
  await waitFor(() => reads === 1 && app.element('supplier').value === 'Receipt B')
  assert.equal(app.state().receiptMode, 'create')
  assert.equal(app.element('saveBtn').dataset.edit, undefined)
  await app.call('save')
  assert.equal(db.calls.inserts.length, 1)
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
  assert.match(html, /if\(files\.length===1&&pdfs\.length===1\)\{[\s\S]*?return;[\s\S]*?\}/)
  assert.doesNotMatch(html, /if\(files\.length===1&&pdfs\.length===1\)\{[\s\S]*?startAutomaticReceiptReading/)
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

test('production load path: a needs_review row from the backend is excluded from Library/reports and appears in Needs Review', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'completed-row', workflow_status: 'completed', total: 25, gst: 2.27 }),
    receipt({ id: 'cases-row', workflow_status: 'needs_review', supplier: 'CASES', total: 1, gst: 0.09 })
  ])
  app.setBackend(db)

  // Exercises the exact sb.from('receipts').select('*')... path used in production load().
  await app.call('load')

  assert.equal(JSON.stringify(app.call('filterAndSortReceipts', db.rows, {}).map(r => r.id)), JSON.stringify(['completed-row']))
  assert.equal(JSON.stringify(app.call('needsReviewRows').map(r => r.id)), JSON.stringify(['cases-row']))

  const fyRows = app.call('reportPeriodRows', db.rows, { mode: 'fy' })
  assert.equal(JSON.stringify(fyRows.map(r => r.id)), JSON.stringify(['completed-row']))

  assert.equal(app.element('needsReviewCount').textContent, '1')
  assert.match(app.element('needsReviewList').innerHTML, /CASES/)
  assert.equal(app.element('total').textContent.replace(/[^0-9.]/g, ''), '25.00')
})

test('admitDurableReceipt creates a durable row first, then uploads, then marks it queued', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const file = new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' })

  const id = await app.call('admitDurableReceipt', file)

  assert.equal(db.calls.inserts.length, 1)
  assert.equal(db.calls.inserts[0].user_id, 'test-user')
  assert.equal(db.calls.inserts[0].supplier, null)
  assert.equal(db.calls.inserts[0].workflow_status, 'uploading')
  assert.equal(typeof db.calls.inserts[0].scan_session_id, 'string')
  assert.equal(typeof db.calls.inserts[0].scan_started_at, 'string')

  assert.equal(db.calls.uploads.length, 1)
  assert.match(db.calls.uploads[0].path, new RegExp('^test-user/' + id + '/receipt\\.jpg$'))

  const row = db.rows.find(r => r.id === id)
  assert.equal(row.workflow_status, 'queued')
  assert.equal(row.file_path, db.calls.uploads[0].path)
  assert.equal(row.supplier, null)
  assert.equal(row.scan_session_id, db.calls.inserts[0].scan_session_id)

  // Durable across a fresh load(), not merely in-memory.
  await app.call('load')
  assert.equal(app.call('needsReviewRows').map(r => r.id).includes(id), true)
  assert.equal(app.element('needsReviewCount').textContent, '1')
  assert.match(app.element('needsReviewList').innerHTML, /Processing/)

  // Financially inactive.
  assert.equal(app.call('filterAndSortReceipts', db.rows, {}).map(r => r.id).includes(id), false)
  assert.equal(app.call('reportPeriodRows', db.rows, { mode: 'fy' }).map(r => r.id).includes(id), false)
})

test('admitDurableReceipt keeps the durable row and marks it needs_attention when Storage upload fails', async () => {
  const app = loadApp(), db = backend([])
  db.uploadShouldFail = true
  app.setBackend(db)
  const file = new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' })

  await assert.rejects(app.call('admitDurableReceipt', file))

  assert.equal(db.rows.length, 1)
  const row = db.rows[0]
  assert.equal(row.workflow_status, 'needs_attention')
  assert.equal(row.scan_error_summary, 'Image upload failed.')
  assert.equal(row.supplier, null)

  assert.equal(app.call('filterAndSortReceipts', db.rows, {}).map(r => r.id).includes(row.id), false)
  assert.equal(app.call('reportPeriodRows', db.rows, { mode: 'fy' }).map(r => r.id).includes(row.id), false)
  const needsReview = app.call('needsReviewRows')
  assert.equal(needsReview.map(r => r.id).includes(row.id), true)
})

test('admitDurableReceipt requires a signed-in user and a file', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db, null)
  await assert.rejects(app.call('admitDurableReceipt', new File(['x'], 'r.jpg', { type: 'image/jpeg' })), /signed in/)
  assert.equal(db.calls.inserts.length, 0)
})

test('the stored image for a durably admitted receipt can later be opened', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const id = await app.call('admitDurableReceipt', new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' }))
  await app.call('load')
  await app.call('viewFile', id)
  assert.equal(db.calls.uploads.length, 1)
})

test('durable admission does not disturb existing completed receipts or the ordinary Edit/Review flows', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'completed-1', workflow_status: 'completed' })])
  app.setBackend(db)
  await app.call('load')
  await app.call('admitDurableReceipt', new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' }))

  const completedRow = db.rows.find(r => r.id === 'completed-1')
  assert.equal(completedRow.workflow_status, 'completed')
  assert.equal(completedRow.supplier, 'Alpha Supplies')
  assert.equal(JSON.stringify(app.call('filterAndSortReceipts', db.rows, {}).map(r => r.id)), JSON.stringify(['completed-1']))
})

test('libraryFile input supports multi-select and cameraFile does not', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.match(html, /<input id="libraryFile" type="file" accept="image\/\*,application\/pdf" multiple/)
  assert.match(html, /<input id="cameraFile" type="file" accept="image\/\*" capture="environment"/)
  assert.doesNotMatch(html, /<input id="cameraFile"[^>]*multiple/)
})

test('admitDurableReceiptBatch admits every file independently with distinct ids, scan sessions and paths', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const files = [
    new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
    new File(['b'], 'two.jpg', { type: 'image/jpeg' }),
    new File(['c'], 'three.jpg', { type: 'image/jpeg' })
  ]

  const results = await app.call('admitDurableReceiptBatch', files, 3)

  assert.equal(results.length, 3)
  assert.equal(results.every(r => r.ok), true)
  assert.equal(db.calls.inserts.length, 3)
  const ids = db.calls.inserts.map(i => i.id)
  assert.equal(new Set(ids).size, 3, 'each admission gets a distinct receipt id')
  const scanSessionIds = db.calls.inserts.map(i => i.scan_session_id)
  assert.equal(new Set(scanSessionIds).size, 3, 'each admission gets a distinct scan_session_id')
  const paths = db.calls.uploads.map(u => u.path)
  assert.equal(new Set(paths).size, 3, 'each admission gets a distinct storage path')

  await app.call('load')
  assert.equal(app.call('needsReviewRows').length, 3)
  assert.equal(app.element('needsReviewCount').textContent, '3')
  assert.equal(app.call('filterAndSortReceipts', db.rows, {}).length, 0)
  assert.equal(app.call('reportPeriodRows', db.rows, { mode: 'fy' }).length, 0)
})

test('admitDurableReceiptBatch isolates a single failure from its siblings', async () => {
  const app = loadApp(), db = backend([])
  let uploadCount = 0
  db.storage.from = () => ({
    async upload(uploadPath, file) {
      uploadCount++
      db.calls.uploads.push({ path: uploadPath, file })
      if (file.name === 'bad.jpg') return { error: Error('Simulated storage upload failure') }
      return { error: null }
    },
    async remove(paths) { db.calls.removes.push(paths); return { error: null } },
    async createSignedUrl() { return { data: { signedUrl: 'https://example.test/receipt' }, error: null } }
  })
  app.setBackend(db)
  const files = [
    new File(['a'], 'good1.jpg', { type: 'image/jpeg' }),
    new File(['b'], 'bad.jpg', { type: 'image/jpeg' }),
    new File(['c'], 'good2.jpg', { type: 'image/jpeg' })
  ]

  const results = await app.call('admitDurableReceiptBatch', files, 3)

  assert.equal(uploadCount, 3, 'every file was attempted, one failure did not stop the others')
  assert.equal(results.filter(r => r.ok).length, 2)
  assert.equal(results.filter(r => !r.ok).length, 1)
  await app.call('load')
  const needsAttention = db.rows.filter(r => r.workflow_status === 'needs_attention')
  assert.equal(needsAttention.length, 1)
  assert.equal(db.rows.filter(r => r.workflow_status === 'queued').length, 2)
})

test('batchAdmissionSummary reports a non-technical success/failure count', () => {
  const app = loadApp()
  assert.equal(app.call('batchAdmissionSummary', [{ ok: true }, { ok: true }, { ok: false }]), "2 receipts safely added. 1 could not be added. The others are waiting in Needs Review.")
  assert.equal(app.call('batchAdmissionSummary', [{ ok: true }]), "1 receipt safely added. They're waiting in Needs Review.")
})

test('handleLibraryFileSelection admits a single new library image durably and does not use foreground OCR', async () => {
  const app = loadApp(), db = backend([])
  let reads = 0
  app.setBackend(db)
  app.setFunction('scanReceiptWithGemini', async () => { reads++; return { supplier: 'APCO Wangaratta', date: '2025-10-23', total: 25.23, gst: 2.29 } })
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [image]

  await app.call('handleLibraryFileSelection', [image], app.element('libraryFile'))

  assert.equal(db.calls.inserts.length, 1, 'single new library image is durably admitted like camera capture')
  assert.equal(db.calls.uploads.length, 1)
  assert.equal(reads, 0, 'foreground Gemini OCR must not be used for a single new library image')
  assert.equal(app.element('supplier').value, '', 'the Add Receipt form is cleared, not populated with foreground OCR fields')
  assert.equal(app.element('admitBanner').classList.contains('hidden'), false, 'the Receipt added confirmation is shown')
  assert.equal(app.element('admitBanner').scrollIntoViewCalls.length, 1, 'the single-library confirmation is brought into view once')
  assert.equal(
    JSON.stringify(app.element('admitBanner').scrollIntoViewCalls[0]),
    JSON.stringify({ behavior: 'smooth', block: 'center' })
  )
})

test('handleLibraryFileSelection keeps the existing single-PDF manual-entry flow unchanged', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const pdf = new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' })

  await app.call('handleLibraryFileSelection', [pdf], app.element('libraryFile'))

  assert.match(app.element('ocrStatus').textContent, /PDF selected/)
  assert.equal(db.calls.inserts.length, 0, 'single PDF selection does not go through durable admission')
})

test('handleLibraryFileSelection admits a multi-image selection as a batch and reports a plain-language summary', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const files = [
    new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
    new File(['b'], 'two.jpg', { type: 'image/jpeg' })
  ]

  await app.call('handleLibraryFileSelection', files, app.element('libraryFile'))

  assert.equal(db.calls.inserts.length, 2)
  assert.match(app.element('batchStatus').textContent, /2 receipts safely added/)
  assert.match(app.element('batchStatus').textContent, /waiting in Needs Review/)
  assert.doesNotMatch(app.element('batchStatus').textContent, /reading|processing|scan/i)
  assert.equal(app.element('libraryFile').value, '', 'the file input is reset after the batch completes')
})

test('handleLibraryFileSelection skips PDFs mixed into a multi-file selection and still admits the images', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const files = [
    new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
    new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' }),
    new File(['b'], 'two.jpg', { type: 'image/jpeg' })
  ]

  await app.call('handleLibraryFileSelection', files, app.element('libraryFile'))

  assert.equal(db.calls.inserts.length, 2, 'only the two images were durably admitted')
  assert.match(app.element('batchStatus').textContent, /2 receipts safely added/)
  assert.match(app.element('batchStatus').textContent, /1 PDF was skipped/)
})

test('handleLibraryFileSelection reports partial-failure feedback with correct "the others" wording', async () => {
  const app = loadApp(), db = backend([])
  db.storage.from = () => ({
    async upload(uploadPath, file) {
      db.calls.uploads.push({ path: uploadPath, file })
      if (file.name === 'bad.jpg') return { error: Error('Simulated storage upload failure') }
      return { error: null }
    },
    async remove(paths) { db.calls.removes.push(paths); return { error: null } },
    async createSignedUrl() { return { data: { signedUrl: 'https://example.test/receipt' }, error: null } }
  })
  app.setBackend(db)
  const files = [
    new File(['a'], 'good1.jpg', { type: 'image/jpeg' }),
    new File(['b'], 'bad.jpg', { type: 'image/jpeg' }),
    new File(['c'], 'good2.jpg', { type: 'image/jpeg' })
  ]

  await app.call('handleLibraryFileSelection', files, app.element('libraryFile'))

  assert.equal(app.element('batchStatus').textContent, '2 receipts safely added. 1 could not be added. The others are waiting in Needs Review.')
})

test('handleLibraryFileSelection does not call begin_ocr_scan or Gemini for batch admission', async () => {
  const app = loadApp(), db = backend([])
  const scanRpcCalls = []
  let geminiCalls = 0
  db.rpc = async (name) => { if (name === 'begin_ocr_scan' || name === 'complete_ocr_scan') scanRpcCalls.push(name); return { data: {}, error: null } }
  app.setBackend(db)
  app.setFunction('scanReceiptWithGemini', async () => { geminiCalls++; return {} })
  const files = [
    new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
    new File(['b'], 'two.jpg', { type: 'image/jpeg' })
  ]

  await app.call('handleLibraryFileSelection', files, app.element('libraryFile'))

  assert.equal(scanRpcCalls.length, 0, 'batch admission must never consume OCR entitlement')
  assert.equal(geminiCalls, 0)
})

test('normal Receipt Library only shows completed receipts', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'completed', workflow_status: 'completed' }),
    receipt({ id: 'needs-review', workflow_status: 'needs_review' }),
    receipt({ id: 'needs-attention', workflow_status: 'needs_attention' }),
    receipt({ id: 'queued', workflow_status: 'queued' }),
    receipt({ id: 'reading', workflow_status: 'reading' }),
    receipt({ id: 'uploading', workflow_status: 'uploading' })
  ]
  const ids = Array.from(app.call('filterAndSortReceipts', rows, {}), r => r.id)
  assert.deepEqual(ids, ['completed'])
})

test('Needs Review includes every non-completed workflow state', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'completed', workflow_status: 'completed' }),
    receipt({ id: 'needs-review', workflow_status: 'needs_review' }),
    receipt({ id: 'needs-attention', workflow_status: 'needs_attention' }),
    receipt({ id: 'queued', workflow_status: 'queued' }),
    receipt({ id: 'reading', workflow_status: 'reading' }),
    receipt({ id: 'uploading', workflow_status: 'uploading' })
  ])
  const ids = app.call('needsReviewRows').map(r => r.id)
  assert.deepEqual(ids.sort(), ['needs-attention', 'needs-review', 'queued', 'reading', 'uploading'].sort())
})

test('Needs Review renders user-facing labels, not raw workflow_status', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'needs-review', workflow_status: 'needs_review', supplier: 'Ready Co', total: 40 }),
    receipt({ id: 'needs-attention', workflow_status: 'needs_attention', supplier: null, total: null, receipt_date: null }),
    receipt({ id: 'queued', workflow_status: 'queued', supplier: null, total: null, receipt_date: null }),
    receipt({ id: 'uploading', workflow_status: 'uploading', supplier: null, total: null, receipt_date: null })
  ])
  app.setBackend(db)

  await app.call('load')

  assert.equal(app.element('needsReviewCount').textContent, '4')
  const html = app.element('needsReviewList').innerHTML
  assert.match(html, /Ready to review/)
  assert.match(html, /Needs attention/)
  assert.match(html, /Processing/)
  assert.match(html, /Uploading/)
  assert.equal(html.includes('needs_review'), false)
  assert.equal(html.includes('needs_attention'), false)
  assert.match(html, /Unknown supplier/)
})

test('Processing badge shows an animated spinner for active states; Ready to review and Needs attention stay static', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'needs-review', workflow_status: 'needs_review', supplier: 'Ready Co', total: 40 }),
    receipt({ id: 'needs-attention', workflow_status: 'needs_attention', supplier: null, total: null, receipt_date: null }),
    receipt({ id: 'queued', workflow_status: 'queued', supplier: null, total: null, receipt_date: null }),
    receipt({ id: 'reading', workflow_status: 'reading', supplier: null, total: null, receipt_date: null }),
    receipt({ id: 'uploading', workflow_status: 'uploading', supplier: null, total: null, receipt_date: null })
  ])
  app.setBackend(db)

  await app.call('load')

  const html = app.element('needsReviewList').innerHTML
  const spinnerCount = (html.match(/class="statusspinner"/g) || []).length
  assert.equal(spinnerCount, 2, 'only the two active-processing rows (queued, reading) get a spinner')
})

test('findPossibleDuplicate: identical supplier/date/total on another completed receipt is a duplicate', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 }),
    receipt({ id: 'b', workflow_status: 'needs_review', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match?.id, 'a')
})

test('findPossibleDuplicate: supplier case differences still match', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'BUNNINGS WAREHOUSE', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match?.id, 'a')
})

test('findPossibleDuplicate: supplier outer whitespace differences still match', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: '  Bunnings Warehouse  ', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match?.id, 'a')
})

test('findPossibleDuplicate: different supplier does not match', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Officeworks', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: different date does not match', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-31', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: different total does not match', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 12.34 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: missing supplier on the current receipt never flags', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: '', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: missing date on the current receipt never flags', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: null, total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: missing total on the current receipt never flags', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: null })
  assert.equal(match, null)
})

test('findPossibleDuplicate: a receipt never matches itself', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'a', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: completed candidate rows are eligible', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match?.id, 'a')
})

test('findPossibleDuplicate: needs_review candidate rows are eligible', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'needs_review', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match?.id, 'a')
})

test('findPossibleDuplicate: needs_attention candidates are ignored', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'needs_attention', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: queued candidates are ignored', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'queued', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: reading candidates are ignored', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'reading', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: uploading candidates are ignored', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'a', workflow_status: 'uploading', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match, null)
})

test('findPossibleDuplicate: legacy/missing workflow_status follows existing completed semantics', () => {
  const app = loadApp()
  const legacyRow = receipt({ id: 'a', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  delete legacyRow.workflow_status
  app.setRows([legacyRow])
  const match = app.call('findPossibleDuplicate', { id: 'b', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match?.id, 'a')
})

test('Review warning renders the correct candidate supplier/date/total and links View receipt to the candidate id', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'existing-1', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 }),
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  const html = app.element('dupBanner').innerHTML
  assert.equal(app.element('dupBanner').classList.contains('hidden'), false)
  assert.match(html, /Possible duplicate/)
  assert.match(html, /Bunnings Warehouse/)
  assert.match(html, /\$40\.90/)
  assert.match(html, /30 Dec 2025/)
  assert.match(html, /viewMatchingReceipt\('existing-1'\)/)
})

test('Save & complete remains enabled while a possible-duplicate warning is showing', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'existing-1', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 }),
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.element('dupBanner').classList.contains('hidden'), false)
  assert.equal(app.element('saveBtn').disabled, false)
})

test('Save & review next remains enabled while a possible-duplicate warning is showing', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'existing-1', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 }),
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.element('dupBanner').classList.contains('hidden'), false)
  assert.equal(app.element('saveAnotherBtn').disabled, false)
})

test('Editing Supplier/Date/Total so the match disappears removes the duplicate warning', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'existing-1', workflow_status: 'completed', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 }),
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')
  assert.equal(app.element('dupBanner').classList.contains('hidden'), false)

  app.element('amount').value = '99.99'
  app.call('syncDuplicateWarning')

  assert.equal(app.element('dupBanner').classList.contains('hidden'), true)
  assert.doesNotMatch(app.element('dupBanner').innerHTML, /Delete this receipt/, 'the contextual delete action exists only while a duplicate warning is present')
})

test('Editing fields to create a new match shows the duplicate warning', async () => {
  const app = loadApp()
  const db = backend([
    receipt({ id: 'existing-1', workflow_status: 'completed', supplier: 'Officeworks', receipt_date: '2025-11-01', total: 12.50 }),
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')
  assert.equal(app.element('dupBanner').classList.contains('hidden'), true)

  app.element('supplier').value = 'Officeworks'
  app.element('date').value = '2025-11-01'
  app.element('amount').value = '12.50'
  app.call('syncDuplicateWarning')

  assert.equal(app.element('dupBanner').classList.contains('hidden'), false)
  assert.match(app.element('dupBanner').innerHTML, /Officeworks/)
})

test('Review opens the existing Add Receipt form without triggering automatic Gemini', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Draft Supplier' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  let reads = 0
  app.setFunction('scanReceiptWithGemini', async () => { reads++ })

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.state().receiptMode, 'edit')
  assert.equal(app.element('saveBtn').dataset.edit, 'needs-review-1')
  assert.equal(app.element('supplier').value, 'Draft Supplier')
  assert.equal(app.element('receiptPreview').src, 'https://example.test/receipt')
  assert.equal(app.element('addReceiptHeading').textContent, 'Review receipt')
  assert.equal(app.element('reviewBanner').classList.contains('hidden'), false)
  assert.equal(app.element('saveBtn').textContent, 'Save & complete')
  assert.equal(reads, 0)

  const [tabbar, , addView] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true)
  assert.equal(tabbar.children[0].classList.contains('active'), false)
  assert.equal(addView.classList.contains('hidden'), false)
})

test('New receipt / Clear form from Review mode exits review and switches to Add Receipt', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Draft Supplier' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')
  assert.equal(app.state().reviewMode, true)
  const [tabbarBefore] = app.element('mainArea').children
  assert.equal(tabbarBefore.children[1].classList.contains('active'), true, 'Receipts tab active while reviewing')

  app.call('resetReceiptForm')

  assert.equal(app.state().reviewMode, false)
  assert.equal(app.state().receiptMode, 'create')
  const [tabbar, , addView] = app.element('mainArea').children
  assert.equal(tabbar.children[0].classList.contains('active'), true, 'Add Receipt tab becomes active')
  assert.equal(tabbar.children[1].classList.contains('active'), false, 'Receipts tab no longer active')
  assert.equal(addView.classList.contains('hidden'), false, 'Add Receipt view is shown')
  assert.equal(app.element('addReceiptHeading').textContent, 'Add receipt')
  assert.equal(app.element('saveAnotherBtn').textContent, 'Save & add another')
  assert.equal(app.element('reviewBanner').classList.contains('hidden'), true)
  assert.equal(app.element('supplierError').classList.contains('hidden'), true)
  assert.equal(app.element('dateError').classList.contains('hidden'), true)
  assert.equal(app.element('amountError').classList.contains('hidden'), true)
})

test('New receipt / Clear form in ordinary Add Receipt mode keeps existing behavior', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  await app.call('loadSettings')
  app.element('supplier').value = 'Some Supplier'

  app.call('resetReceiptForm')

  assert.equal(app.state().reviewMode, false)
  assert.equal(app.state().receiptMode, 'create')
  const [tabbar, , addView] = app.element('mainArea').children
  assert.equal(tabbar.children[0].classList.contains('active'), true, 'Add Receipt tab remains active')
  assert.equal(addView.classList.contains('hidden'), false)
  assert.equal(app.element('supplier').value, '')
})

test('Review shows a needs-attention message and still allows manual completion', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'attn-1', workflow_status: 'needs_attention', supplier: 'Blurry Co' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'attn-1')

  assert.match(app.element('reviewBanner').innerHTML, /needs attention/i)
})

test('saving a reviewed receipt updates the existing row, completes it, and sets reviewed_at', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-2', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-2')
  fillForm(app)

  await app.call('save')

  assert.equal(db.calls.inserts.length, 0)
  assert.equal(db.calls.updates.length, 1)
  assert.equal(db.calls.updates[0].id, 'needs-review-2')
  assert.equal(db.calls.updates[0].payload.workflow_status, 'completed')
  assert.match(db.calls.updates[0].payload.reviewed_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(app.element('saveMsg').innerHTML, /Receipt completed/i)
})

test('a completed review disappears from Needs Review and appears in the normal Library, and the badge updates', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-3', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('load')
  assert.equal(app.element('needsReviewCount').textContent, '1')

  await app.call('reviewReceipt', 'needs-review-3')
  fillForm(app)
  await app.call('save')

  assert.equal(app.element('needsReviewCount').textContent, '0')
  const libraryIds = Array.from(app.call('filteredRows'), r => r.id)
  assert.deepEqual(libraryIds, ['needs-review-3'])
})

test('ordinary completed Edit is unaffected by the review flow', async () => {
  const app = loadApp(), db = backend([receipt()])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('editReceipt', 'receipt-1')

  assert.equal(app.element('addReceiptHeading').textContent, 'Add receipt')
  assert.equal(app.element('reviewBanner').classList.contains('hidden'), true)
  assert.equal(app.element('saveBtn').textContent, 'Update receipt')
  assert.equal(app.state().receiptMode, 'edit')
})

test('a still-processing receipt is shown read-only in Needs Review and cannot be reviewed', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'queued-1', workflow_status: 'queued', supplier: null, total: null, receipt_date: null })])
  app.setBackend(db)

  await app.call('load')

  const html = app.element('needsReviewList').innerHTML
  assert.match(html, /disabled/)
  assert.match(html, /Processing/)
})

test('background polling starts when uploading/queued/reading receipts exist and stops once they clear', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'q-1', workflow_status: 'queued', supplier: null, total: null, receipt_date: null })])
  app.setBackend(db)

  await app.call('load')
  assert.equal(app.pendingTimeoutCount(), 1, 'a poll timer is scheduled while a receipt is in flight')

  // Resolve the in-flight receipt before the scheduled poll fires.
  const row = db.rows.find(r => r.id === 'q-1')
  Object.assign(row, { workflow_status: 'needs_review', supplier: 'Resolved Supplier', total: 12, receipt_date: '2026-08-10' })

  await app.flushTimeouts()

  assert.match(app.element('needsReviewList').innerHTML, /Ready to review/)
  assert.equal(app.pendingTimeoutCount(), 0, 'no further poll is scheduled once nothing remains in flight')
})

test('background polling does not create duplicate timers across repeated load() calls', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'q-1', workflow_status: 'reading', supplier: null, total: null, receipt_date: null })])
  app.setBackend(db)

  await app.call('load')
  await app.call('load')
  await app.call('load')

  assert.equal(app.pendingTimeoutCount(), 1, 'only one poll timer is ever scheduled at a time')
})

test('background polling does not start when no receipts are uploading/queued/reading', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'completed-1', workflow_status: 'completed' })])
  app.setBackend(db)

  await app.call('load')

  assert.equal(app.pendingTimeoutCount(), 0)
})

test('signing out stops any pending background poll timer', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'q-1', workflow_status: 'queued', supplier: null, total: null, receipt_date: null })])
  app.setBackend(db)

  await app.call('load')
  assert.equal(app.pendingTimeoutCount(), 1)

  app.call('clearPrivateApplicationData')

  assert.equal(app.pendingTimeoutCount(), 0)
})

test('batch admission never shows the single-image "Reading your receipt…" wording, even after a prior single-image selection left it visible', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  app.element('ocrStatus').textContent = 'Reading your receipt…'
  const files = [
    new File(['a'], 'one.jpg', { type: 'image/jpeg' }),
    new File(['b'], 'two.jpg', { type: 'image/jpeg' })
  ]

  await app.call('handleLibraryFileSelection', files, app.element('libraryFile'))

  assert.doesNotMatch(app.element('ocrStatus').textContent, /Reading your receipt/)
  assert.doesNotMatch(app.element('batchStatus').textContent, /Reading your receipt/)
})

test('single-image immediate OCR wording remains unchanged', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  app.setFunction('prepareReceiptFile', async file => file)
  app.setFunction('fileToBase64', async () => 'test-image')
  app.setFunction('scanReceiptWithGemini', () => new Promise(() => {})) // never resolves during assertion window
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]

  await app.call('handleReceiptFileInput', app.element('cameraFile'), app.element('libraryFile'))
  app.call('readReceiptWithGemini') // fire-and-forget; assert status text set synchronously before Gemini resolves

  await waitFor(() => app.element('ocrStatus').textContent === 'Reading your receipt…')
  assert.equal(app.element('ocrStatus').textContent, 'Reading your receipt…')
})

test('a failed upload retains original_filename and mime_type on the needs_attention row', async () => {
  const app = loadApp(), db = backend([])
  db.uploadShouldFail = true
  app.setBackend(db)
  const file = new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' })

  await assert.rejects(app.call('admitDurableReceipt', file))

  const row = db.rows[0]
  assert.equal(row.workflow_status, 'needs_attention')
  assert.equal(row.original_filename, 'receipt.jpg')
  assert.equal(row.mime_type, 'image/jpeg')
})

test('a needs_attention row with no attachment exposes a Retry upload action', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'failed-1', workflow_status: 'needs_attention', supplier: null, total: null, receipt_date: null, file_path: null, original_filename: null, mime_type: null, scan_error_summary: 'Image upload failed.' })])
  app.setBackend(db)

  await app.call('load')

  const html = app.element('needsReviewList').innerHTML
  assert.match(html, /Retry upload/)
  assert.match(html, /attachment failed to upload/i)
})

test('a needs_attention row that already has a file_path does not show a Retry upload action', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'failed-2', workflow_status: 'needs_attention', supplier: null, total: null, receipt_date: null })])
  app.setBackend(db)

  await app.call('load')

  assert.doesNotMatch(app.element('needsReviewList').innerHTML, /Retry upload/)
})

test('retryFailedUpload on success re-uploads to the deterministic path, resets error, and queues for background OCR without calling Gemini', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'failed-1', workflow_status: 'needs_attention', supplier: null, total: null, receipt_date: null, file_path: null, original_filename: null, mime_type: null, scan_error_summary: 'Image upload failed.', scan_session_id: 'session-1' })])
  app.setBackend(db)
  let geminiCalled = false
  app.setFunction('scanReceiptWithGemini', async () => { geminiCalled = true; return {} })
  const file = new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' })

  await app.call('load')
  await app.call('retryFailedUpload', 'failed-1', file)

  const row = db.rows.find(r => r.id === 'failed-1')
  assert.equal(row.workflow_status, 'queued')
  assert.equal(row.scan_error_summary, null)
  assert.match(row.file_path, /^test-user\/failed-1\/receipt\.jpg$/)
  assert.equal(row.original_filename, 'receipt.jpg')
  assert.equal(row.mime_type, 'image/jpeg')
  assert.equal(row.scan_session_id, 'session-1', 'existing scan_session_id is preserved')
  assert.equal(geminiCalled, false, 'retry never calls browser Gemini OCR directly')
  assert.equal(db.calls.uploads.length, 1)
})

test('retryFailedUpload on failure keeps the row needs_attention and retains metadata without deleting it', async () => {
  const app = loadApp()
  const db = backend([receipt({ id: 'failed-1', workflow_status: 'needs_attention', supplier: null, total: null, receipt_date: null, file_path: null, original_filename: null, mime_type: null, scan_error_summary: 'Image upload failed.' })])
  db.uploadShouldFail = true
  app.setBackend(db)
  const file = new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' })

  await app.call('load')
  await assert.rejects(app.call('retryFailedUpload', 'failed-1', file))

  assert.equal(db.rows.length, 1)
  const row = db.rows[0]
  assert.equal(row.workflow_status, 'needs_attention')
  assert.equal(row.original_filename, 'receipt.jpg')
  assert.equal(row.mime_type, 'image/jpeg')
})

test('Save & complete in review mode returns to Receipts, refreshes data, and scrolls to top', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')
  fillForm(app)
  let scrolled = false
  app.run("window.scrollTo = () => { __scrolled = true }")
  app.run('__scrolled = false')

  await app.call('save')

  const [tabbar, , addView, , receiptsView] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true, 'Receipts tab is now active')
  assert.equal(addView.classList.contains('hidden'), true)
  assert.equal(receiptsView.classList.contains('hidden'), false)
  assert.equal(app.run('__scrolled'), true, 'view scrolled to top after returning to Receipts')

  // Refreshed data: completed receipt no longer in Needs Review.
  assert.equal(app.element('needsReviewCount').textContent, '0')
  assert.equal(db.rows.find(r => r.id === 'needs-review-1').workflow_status, 'completed')
})

test('outside review mode, saveAnotherBtn keeps the "Save & add another" label and behavior', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  await app.call('loadSettings')
  app.call('resetReceiptForm')

  assert.equal(app.element('saveAnotherBtn').textContent, 'Save & add another')

  fillForm(app)
  const result = await app.call('save', { addAnother: true })

  assert.equal(result.addAnother, true)
  assert.equal(app.state().receiptMode, 'create', 'form resets for a new receipt, not the review workflow')
  assert.match(app.element('saveMsg').innerHTML, /Ready for the next receipt/i)
  const [tabbar] = app.element('mainArea').children
  assert.equal(tabbar.children[0].classList.contains('active'), true, 'stays on Add Receipt tab, unlike review mode')
})

test('in review mode, saveAnotherBtn label changes to "Save & review next"', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.element('saveAnotherBtn').textContent, 'Save & review next')
})

test('Save & review next opens the next reviewable receipt directly when one exists', async () => {
  const app = loadApp(), db = backend([
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'First Co' }),
    receipt({ id: 'needs-review-2', workflow_status: 'needs_review', supplier: 'Second Co' })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')
  fillForm(app)

  await app.call('save', { addAnother: true })

  assert.equal(app.element('saveBtn').dataset.edit, 'needs-review-2', 'the next reviewable receipt is now open for review')
  assert.equal(app.state().receiptMode, 'edit')
  assert.equal(app.element('addReceiptHeading').textContent, 'Review receipt')
  const [tabbar, , addView] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true, 'Receipts tab stays active while reviewing')
  assert.equal(addView.classList.contains('hidden'), false)
})

test('Save & review next returns to Receipts at top when no reviewable receipts remain', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')
  fillForm(app)
  app.run("window.scrollTo = () => { __scrolled = true }")
  app.run('__scrolled = false')

  await app.call('save', { addAnother: true })

  const [tabbar, , addView, , receiptsView] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true)
  assert.equal(addView.classList.contains('hidden'), true)
  assert.equal(receiptsView.classList.contains('hidden'), false)
  assert.equal(app.run('__scrolled'), true)
})

test('review-mode save transitions do not create a duplicate receipt row or a second write', async () => {
  const app = loadApp(), db = backend([
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review' }),
    receipt({ id: 'needs-review-2', workflow_status: 'needs_review' })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')
  fillForm(app)

  await app.call('save', { addAnother: true })

  assert.equal(db.calls.inserts.length, 0)
  assert.equal(db.calls.updates.length, 1)
  assert.equal(db.rows.length, 2, 'no duplicate rows were created during the review-to-review-next transition')
})

test('Review keeps the Receipts tab visually active while normal Add Receipt keeps Add Receipt active', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')
  let [tabbar] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true, 'Receipts tab active during review')
  assert.equal(tabbar.children[0].classList.contains('active'), false)

  app.call('resetReceiptForm')
  app.call('activateMainTab', 'add')
  ;[tabbar] = app.element('mainArea').children
  assert.equal(tabbar.children[0].classList.contains('active'), true, 'Add Receipt tab active for normal add-receipt use')
})

test('reviewMode displays "Save & review next", and leaving reviewMode restores normal add-another wording', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')
  assert.equal(app.element('saveAnotherBtn').textContent, 'Save & review next')

  // Root cause regression guard: setReceiptMode must not clobber the review-mode label when
  // reviewMode is left off before the mode's base label is applied (order-of-operations bug).
  app.call('resetReceiptForm')
  assert.equal(app.element('saveAnotherBtn').textContent, 'Save & add another')
  assert.equal(app.state().reviewMode, false)
})

test('review form immediately marks a missing required Date while Supplier and Total remain normal', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'BP Glenrowan Northbound', total: 20.02, receipt_date: null })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.element('date').classList.contains('field-error'), true)
  assert.equal(app.element('dateError').classList.contains('hidden'), false)
  assert.equal(app.element('dateError').textContent, 'Date needs checking')
  assert.equal(app.element('supplier').classList.contains('field-error'), false)
  assert.equal(app.element('amount').classList.contains('field-error'), false)
})

test('entering a valid Date clears its error state, and clearing it again restores the error state', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'BP', total: 20.02, receipt_date: null })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')
  assert.equal(app.element('date').classList.contains('field-error'), true)

  app.element('date').value = '2026-01-01'
  app.call('syncFieldValidationErrors')
  assert.equal(app.element('date').classList.contains('field-error'), false)
  assert.equal(app.element('dateError').classList.contains('hidden'), true)

  app.element('date').value = ''
  app.call('syncFieldValidationErrors')
  assert.equal(app.element('date').classList.contains('field-error'), true)
  assert.equal(app.element('dateError').classList.contains('hidden'), false)
})

test('optional empty fields (GST, Entity, Category, Project, Notes) are never marked as errors in review mode', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', gst: null, entity_name: '', category_name: '', project_name: '', notes: '' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.element('gst').classList.contains('field-error'), false)
  assert.equal(app.element('entity').classList.contains('field-error'), false)
  assert.equal(app.element('category').classList.contains('field-error'), false)
  assert.equal(app.element('project').classList.contains('field-error'), false)
  assert.equal(app.element('notes').classList.contains('field-error'), false)
})

test('save validation message is specific to only the missing field(s)', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'BP', total: 20.02, receipt_date: null })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')

  const result = await app.call('save')

  assert.equal(result, undefined, 'save is rejected while a required field is missing')
  assert.equal(app.element('saveMsg').textContent, 'Date is required.')
  assert.equal(db.calls.updates.length, 0, 'no write occurs on failed validation')
})

test('save validation message lists two missing fields with natural grammar', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: '', total: 20.02, receipt_date: null })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')

  await app.call('save')

  assert.equal(app.element('saveMsg').textContent, 'Supplier and date are required.')
})

test('save validation message lists all three missing fields with natural grammar', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: '', total: null, receipt_date: null })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')

  await app.call('save')

  assert.equal(app.element('saveMsg').textContent, 'Supplier, date and total are required.')
})

test('failed validation keeps Receipts tab active, keeps review mode, and does not complete the receipt', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review', receipt_date: null })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')

  await app.call('save')

  assert.equal(app.state().reviewMode, true)
  const [tabbar] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true)
  assert.equal(db.rows.find(r => r.id === 'needs-review-1').workflow_status, 'needs_review')
})

test('Save & review next still opens the next reviewable receipt after the review-navigation changes', async () => {
  const app = loadApp(), db = backend([
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'First Co' }),
    receipt({ id: 'needs-review-2', workflow_status: 'needs_review', supplier: 'Second Co' })
  ])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')
  fillForm(app)

  await app.call('save', { addAnother: true })

  assert.equal(app.element('saveBtn').dataset.edit, 'needs-review-2')
  const [tabbar] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true, 'Receipts tab remains active for the next review')
})

test('Save & complete still returns to Receipts at the top after the review-navigation changes', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')
  fillForm(app)
  app.run("window.scrollTo = () => { __scrolled = true }")
  app.run('__scrolled = false')

  await app.call('save')

  const [tabbar, , addView, , receiptsView] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true)
  assert.equal(addView.classList.contains('hidden'), true)
  assert.equal(receiptsView.classList.contains('hidden'), false)
  assert.equal(app.run('__scrolled'), true)
})

test('normal Add Receipt save behavior and validation message are unchanged outside review mode', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  await app.call('loadSettings')
  app.call('resetReceiptForm')
  app.element('supplier').value = ''
  app.element('date').value = ''
  app.element('amount').value = ''

  const result = await app.call('save')

  assert.equal(result, undefined)
  assert.equal(app.element('saveMsg').textContent, 'Supplier, date and total are required.')
  assert.equal(app.element('supplier').classList.contains('field-error'), false, 'field error styling is review-mode only')

  fillForm(app)
  const saved = await app.call('save', { addAnother: true })
  assert.equal(saved.addAnother, true)
  assert.equal(db.calls.inserts.length, 1)
})

test('camera capture durably admits the first receipt without calling browser-side Gemini', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  let geminiCalled = false
  app.setFunction('scanReceiptWithGemini', async () => { geminiCalled = true })
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]

  await app.call('handleCameraCapture')

  assert.equal(db.calls.inserts.length, 1)
  assert.equal(db.rows[0].workflow_status, 'queued')
  assert.equal(geminiCalled, false, 'rapid camera admission never calls browser Gemini')
  assert.equal(app.element('admitBanner').scrollIntoViewCalls, undefined, 'rapid camera capture never triggers the library confirmation scroll')
})

test('after successful admission the post-capture choice appears with count 1', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]

  await app.call('handleCameraCapture')

  assert.equal(app.element('rapidCaptureCard').classList.contains('hidden'), false)
  assert.match(app.element('rapidCaptureStatus').innerHTML, /1 receipt safely added\. Auto scan underway\./)
})

test('Take another receipt reopens the camera capture input', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]
  await app.call('handleCameraCapture')

  app.call('rapidCaptureTakeAnother')

  assert.equal(app.element('cameraFile').clickCount, 1, 'the native camera input is re-invoked')
})

test('a second successful capture increments the count to 2 without waiting for the first receipt to finish OCR', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const image1 = new File([new Uint8Array([1])], 'receipt1.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image1]
  await app.call('handleCameraCapture')
  assert.equal(app.state().reviewMode, false)

  const image2 = new File([new Uint8Array([2])], 'receipt2.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image2]
  await app.call('handleCameraCapture')

  assert.match(app.element('rapidCaptureStatus').innerHTML, /2 receipts safely added\. Auto scan underway\./)
  assert.equal(db.calls.inserts.length, 2)
  assert.equal(db.rows.filter(r => r.workflow_status === 'queued').length, 2, 'both receipts are queued for background OCR independently')
})

test('Done navigates to Receipts/Needs Review with Receipts active and clears camera-session state', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]
  await app.call('handleCameraCapture')
  app.run("window.scrollTo = () => { __scrolled = true }")
  app.run('__scrolled = false')

  await app.call('rapidCaptureFinish')

  const [tabbar, , , , receiptsView] = app.element('mainArea').children
  assert.equal(tabbar.children[1].classList.contains('active'), true)
  assert.equal(receiptsView.classList.contains('hidden'), false)
  assert.equal(app.run('__scrolled'), true)
  assert.equal(app.element('rapidCaptureCard').classList.contains('hidden'), true)
})

test('a later new camera session starts the count from zero', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]
  await app.call('handleCameraCapture')
  await app.call('rapidCaptureFinish')

  const image2 = new File([new Uint8Array([2])], 'receipt2.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image2]
  await app.call('handleCameraCapture')

  assert.match(app.element('rapidCaptureStatus').innerHTML, /1 receipt safely added\./)
})

test('cancelling a subsequent camera selection does not create a receipt or increment the count', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]
  await app.call('handleCameraCapture')
  assert.equal(db.calls.inserts.length, 1)

  app.element('cameraFile').files = [] // user cancelled the native camera
  await app.call('handleCameraCapture')

  assert.equal(db.calls.inserts.length, 1, 'no additional receipt was admitted on cancel')
  assert.match(app.element('rapidCaptureStatus').innerHTML, /1 receipt safely added\./, 'count is unaffected by a cancelled capture')
})

test('an admission/upload failure is represented durably and does not count as a successful receipt', async () => {
  const app = loadApp(), db = backend([])
  db.uploadShouldFail = true
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]

  await app.call('handleCameraCapture')

  assert.equal(db.rows.length, 1)
  assert.equal(db.rows[0].workflow_status, 'needs_attention')
  assert.match(app.element('rapidCaptureStatus').innerHTML, /could not be added safely/i)
  assert.doesNotMatch(app.element('rapidCaptureStatus').innerHTML, /1 receipt safely added/)
})

test('repeated/double invocation of the same capture cannot duplicate admission', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('cameraFile').files = [image]

  await Promise.all([app.call('handleCameraCapture'), app.call('handleCameraCapture')])

  assert.equal(db.calls.inserts.length, 1, 'the in-progress guard prevents a duplicate admission')
})

test('existing single-image photo-library workflow remains unchanged by rapid camera capture', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  app.setFunction('prepareReceiptFile', async file => file)
  app.setFunction('fileToBase64', async () => 'test-image')
  app.setFunction('scanReceiptWithGemini', () => new Promise(() => {}))
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [image]

  await app.call('handleLibraryFileSelection', [image], app.element('libraryFile'))

  assert.equal(app.element('rapidCaptureStatus').innerHTML, '', 'library selection never opens the rapid-capture UI')
  assert.equal(app.state().receiptMode, 'create')
})

test('existing multi-image library workflow remains unchanged by rapid camera capture', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  const files = [
    new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }),
    new File([new Uint8Array([2])], 'b.jpg', { type: 'image/jpeg' })
  ]

  await app.call('handleLibraryFileSelection', files, app.element('libraryFile'))

  assert.equal(db.calls.inserts.length, 2)
  assert.equal(app.element('rapidCaptureStatus').innerHTML, '')
})

test('existing Review workflow remains unchanged by rapid camera capture', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.element('addReceiptHeading').textContent, 'Review receipt')
  assert.equal(app.element('rapidCaptureCard').classList.contains('hidden'), true)
})

test('a failed single-library-image admission does not show the Receipt added confirmation', async () => {
  const app = loadApp(), db = backend([])
  db.storage.from = () => ({
    async upload() { return { error: Error('Simulated storage upload failure') } },
    async remove(paths) { db.calls.removes.push(paths); return { error: null } },
    async createSignedUrl() { return { data: { signedUrl: 'https://example.test/receipt' }, error: null } }
  })
  app.setBackend(db)
  const image = new File([new Uint8Array([1])], 'receipt.jpg', { type: 'image/jpeg' })
  app.element('libraryFile').files = [image]

  await app.call('handleLibraryFileSelection', [image], app.element('libraryFile'))

  assert.equal(app.element('admitBanner').classList.contains('hidden'), true)
  assert.equal(app.element('admitBanner').scrollIntoViewCalls, undefined, 'failed admission never scrolls to a success message')
  assert.match(app.element('batchStatus').innerHTML, /could not be added safely/)
})

test('Choose photo or PDF is rendered as a real secondary button beneath Take photo', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.match(html, /Take photo<input id="cameraFile"/)
  assert.match(html, /<label class="btn secondary"[^>]*>Choose photo or PDF<input id="libraryFile"/)
  assert.match(html, /\.filebox>\.captureimport>\.btn\.secondary\{[^}]*width:100%[^}]*min-height:48px[^}]*border:1px solid[^}]*background:#f5f9fc/)
})

test('new receipt mode keeps the capture and import block visible', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.match(html, /<div id="captureImportBlock" class="captureimport">/)
  const app = loadApp()
  app.call('setReviewMode', false)
  assert.equal(app.element('captureImportBlock').classList.contains('hidden'), false)
  assert.equal(app.element('receiptImageBox').classList.contains('review-preview-only'), false)
})

test('review mode hides capture controls while retaining the persisted receipt preview', async () => {
  const row = receipt({ id: 'review-image-1', workflow_status: 'needs_review' })
  const app = loadApp(), db = backend([row])
  app.setBackend(db); app.setRows(db.rows); await app.call('loadSettings')

  await app.call('reviewReceipt', 'review-image-1')

  assert.equal(app.element('captureImportBlock').classList.contains('hidden'), true)
  assert.equal(app.element('receiptImageBox').classList.contains('review-preview-only'), true)
  assert.equal(app.element('receiptPreview').src, 'https://example.test/receipt')
  assert.equal(app.element('previewFrame').style.display, 'grid')
})

test('leaving review restores the new-receipt capture and import block', async () => {
  const row = receipt({ id: 'review-image-1', workflow_status: 'needs_review' })
  const app = loadApp(), db = backend([row])
  app.setBackend(db); app.setRows(db.rows); await app.call('loadSettings')
  await app.call('reviewReceipt', 'review-image-1')

  app.call('resetReceiptForm')

  assert.equal(app.element('captureImportBlock').classList.contains('hidden'), false)
  assert.equal(app.element('receiptImageBox').classList.contains('review-preview-only'), false)
  assert.equal(app.element('previewFrame').style.display, 'none')
})

test('Read again / automatic OCR block is hidden by default in the normal new-receipt flow', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.match(html, /<div id="ocrRetryBox" class="ocrbox hidden">/)
})

test('duplicate banner button reads View matching receipt', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.ok(html.includes('View matching receipt'), 'duplicate banner should say View matching receipt')
  assert.ok(html.includes('esc(candidate.id)'), 'the button still targets the candidate id')
})

test('duplicate warning offers current-receipt deletion through the existing confirmed review path only', async () => {
  const app = loadApp(), db = backend([
    receipt({ id: 'existing-1', workflow_status: 'completed', supplier: 'Pearl Energy Wodonga', receipt_date: '2025-11-14', total: 23.25 }),
    receipt({ id: 'needs-review-1', workflow_status: 'needs_review', supplier: 'Pearl Energy Wodonga', receipt_date: '2025-11-14', total: 23.25 })
  ])
  app.setBackend(db); app.setRows(db.rows); await app.call('loadSettings'); await app.call('reviewReceipt', 'needs-review-1')
  const html = app.element('dupBanner').innerHTML
  assert.match(html, /viewMatchingReceipt\('existing-1'\)/)
  assert.match(html, /deleteReceiptFromReview\(\)/)
  assert.match(html, />Delete this receipt</)
  assert.doesNotMatch(html, /deleteReceipt\('existing-1'\)/, 'the matching receipt is never a delete target')

  app.setConfirm(true)
  await app.call('deleteReceiptFromReview')
  assert.deepEqual(db.calls.deletes, ['needs-review-1'])
})

test('matching receipt view adds context while normal receipt viewing remains unchanged', async () => {
  const row = receipt({ id: 'existing-1', supplier: 'Pearl Energy Wodonga', receipt_date: '2025-11-14', total: 23.25 })
  const app = loadApp(), db = backend([row])
  app.setBackend(db); app.setRows(db.rows)

  await app.call('viewMatchingReceipt', 'existing-1')
  assert.equal(app.element('detailTitle').textContent, 'Matching receipt')
  assert.match(app.element('detailBody').innerHTML, /Matching receipt/)
  assert.match(app.element('detailBody').innerHTML, /Pearl Energy Wodonga · \$23\.25 · 14 Nov 2025/)
  assert.match(app.element('detailBody').innerHTML, /class="matchingpreview"/)

  app.element('detailTitle').textContent = 'Receipt'
  app.element('detailBody').innerHTML = ''
  await app.call('viewFile', 'existing-1')
  assert.equal(app.element('detailTitle').textContent, 'Receipt')
  assert.equal(app.element('detailBody').innerHTML, '', 'ordinary attachment viewing does not add matching context')
})

test('Delete receipt button is hidden outside review mode and for brand-new unsaved entries', async () => {
  const app = loadApp(), db = backend([])
  app.setBackend(db)
  await app.call('resetReceiptForm')

  assert.equal(app.element('deleteReviewBtn').classList.contains('hidden'), true)
})

test('Delete receipt button appears only when reviewing an existing persisted receipt', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')

  await app.call('reviewReceipt', 'needs-review-1')

  assert.equal(app.element('deleteReviewBtn').classList.contains('hidden'), false)
})

test('deleting a receipt from review requires confirmation, uses the existing deletion path, and returns to Receipts', async () => {
  const app = loadApp(), db = backend([receipt({ id: 'needs-review-1', workflow_status: 'needs_review' })])
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'needs-review-1')

  let confirmed = false
  app.setConfirm(false)
  await app.call('deleteReceiptFromReview')
  assert.equal(db.calls.deletes.length, 0, 'declining the confirmation does not delete the receipt')

  app.setConfirm(true)
  await app.call('deleteReceiptFromReview')

  assert.equal(db.calls.deletes.length, 1)
  assert.equal(db.calls.deletes[0], 'needs-review-1')
  assert.equal(JSON.stringify(db.calls.removes), JSON.stringify([['test-user/receipt-1/image.jpg']]))
})

test('deleting a possible-duplicate candidate does not auto-delete the matching receipt', async () => {
  const rows = [
    receipt({ id: 'a', supplier: 'Bunnings', receipt_date: '2026-08-10', total: 40.90, workflow_status: 'needs_review' }),
    receipt({ id: 'b', supplier: 'Bunnings', receipt_date: '2026-08-10', total: 40.90, workflow_status: 'completed' })
  ]
  const app = loadApp(), db = backend(rows)
  app.setBackend(db)
  app.setRows(db.rows)
  await app.call('loadSettings')
  await app.call('reviewReceipt', 'a')
  app.setConfirm(true)

  await app.call('deleteReceiptFromReview')

  assert.equal(db.calls.deletes.length, 1)
  assert.equal(db.calls.deletes[0], 'a', 'only the receipt being reviewed is deleted, not the matching receipt')
})
