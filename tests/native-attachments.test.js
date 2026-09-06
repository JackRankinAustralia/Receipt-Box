const test = require('node:test')
const assert = require('node:assert/strict')
const { loadApp } = require('./load-app')

function receipt(overrides = {}) {
  return {
    id: 'receipt-1', supplier: 'Officeworks', receipt_date: '2026-08-10', total: 25, gst: 2.27,
    entity_name: 'AWTCO', category_name: 'Office Supplies', project_name: 'Expo', notes: '',
    file_path: 'user/receipt-1/receipt.jpg', original_filename: 'receipt.jpg', mime_type: 'image/jpeg',
    workflow_status: 'completed', ...overrides
  }
}

function backend(rows, signedUrl = 'https://storage.example.test/private/signed-receipt') {
  return {
    storage: {
      from() {
        return { async createSignedUrl(path, expiresIn) { return { data: { signedUrl }, error: null, path, expiresIn } } }
      }
    },
    rows
  }
}

function browserPlugin({ error } = {}) {
  const calls = []
  return {
    calls,
    plugin: { async open(options) { calls.push(options); if (error) throw error } }
  }
}

test('browser image attachment retains the existing window-open path', async () => {
  const row = receipt(), app = loadApp()
  app.setBackend(backend([row])); app.setRows([row])

  await app.call('viewFile', row.id)

  assert.deepEqual(app.openedWindows, [['https://storage.example.test/private/signed-receipt', '_blank']])
  assert.equal(app.element('detailBody').innerHTML, '')
})

test('native image attachment stays in Receipt Box and does not open Browser', async () => {
  const row = receipt(), app = loadApp(), browser = browserPlugin()
  app.setBackend(backend([row])); app.setRows([row]); app.setNativePlugins({ Browser: browser.plugin })

  await app.call('viewFile', row.id)

  assert.equal(browser.calls.length, 0)
  assert.equal(app.openedWindows.length, 0)
  assert.match(app.element('detailBody').innerHTML, /alt="Receipt attachment"/)
  assert.match(app.element('detailBody').innerHTML, /https:\/\/storage\.example\.test\/private\/signed-receipt/)
  assert.equal(app.element('detailModal').classList.contains('hidden'), false)
})

test('browser PDF attachment retains the existing window-open path', async () => {
  const row = receipt({ file_path: 'user/receipt-1/receipt.pdf', original_filename: 'receipt.pdf', mime_type: 'application/pdf' }), app = loadApp()
  app.setBackend(backend([row])); app.setRows([row])

  await app.call('viewFile', row.id)

  assert.deepEqual(app.openedWindows, [['https://storage.example.test/private/signed-receipt', '_blank']])
})

test('native PDF attachment opens its signed URL through Capacitor Browser', async () => {
  const row = receipt({ file_path: 'user/receipt-1/receipt.pdf', original_filename: 'receipt.pdf', mime_type: 'application/pdf' }), app = loadApp(), browser = browserPlugin()
  app.setBackend(backend([row])); app.setRows([row]); app.setNativePlugins({ Browser: browser.plugin }, { registerOnly: true })

  await app.call('viewFile', row.id)

  assert.deepEqual(JSON.parse(JSON.stringify(browser.calls)), [{ url: 'https://storage.example.test/private/signed-receipt', presentationStyle: 'fullscreen' }])
  assert.equal(app.openedWindows.length, 0)
  assert.doesNotMatch(app.element('detailBody').innerHTML, /storage\.example\.test/)
})

test('native attachment failure is friendly and recoverable without exposing details', async () => {
  const row = receipt({ file_path: 'user/receipt-1/receipt.pdf', original_filename: 'receipt.pdf', mime_type: 'application/pdf' }), app = loadApp(), browser = browserPlugin({ error: Error('private signed URL detail') })
  app.setBackend(backend([row])); app.setRows([row]); app.setNativePlugins({ Browser: browser.plugin })

  await app.call('viewFile', row.id)

  assert.deepEqual(app.alerts, ['Receipt Box could not open this attachment. Please try again.'])
  assert.doesNotMatch(app.alerts.join(' '), /private signed URL detail/)
  assert.equal(app.element('modalViewFile').disabled, false)
})

test('matching-receipt image keeps its contextual in-app viewer on native', async () => {
  const row = receipt({ supplier: 'Pearl Energy Wodonga', total: 23.25, receipt_date: '2025-11-14' }), app = loadApp(), browser = browserPlugin()
  app.setBackend(backend([row])); app.setRows([row]); app.setNativePlugins({ Browser: browser.plugin })

  await app.call('viewMatchingReceipt', row.id)

  assert.equal(browser.calls.length, 0)
  assert.match(app.element('detailBody').innerHTML, /Matching receipt/)
  assert.match(app.element('detailBody').innerHTML, /class="matchingpreview"/)
})

test('native attachment viewing never invokes report Filesystem or Share plugins', async () => {
  const row = receipt({ file_path: 'user/receipt-1/receipt.pdf', original_filename: 'receipt.pdf', mime_type: 'application/pdf' }), app = loadApp(), browser = browserPlugin()
  let writes = 0, shares = 0
  app.setBackend(backend([row])); app.setRows([row]); app.setNativePlugins({
    Browser: browser.plugin,
    Filesystem: { async writeFile() { writes++ } },
    Share: { async share() { shares++ } }
  })

  await app.call('viewFile', row.id)

  assert.equal(browser.calls.length, 1)
  assert.equal(writes, 0)
  assert.equal(shares, 0)
})
