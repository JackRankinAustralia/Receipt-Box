const test = require('node:test')
const assert = require('node:assert/strict')
const { loadApp } = require('./load-app')

function receipt(overrides = {}) {
  return {
    id: 'receipt-1', supplier: 'Officeworks', receipt_date: '2026-08-10', total: 25, gst: 2.27,
    entity_name: 'AWTCO', category_name: 'Office Supplies', project_name: 'Expo', notes: '', ...overrides
  }
}

function nativePlugins({ shareError } = {}) {
  const calls = { writes: [], shares: [], deletes: [] }
  return {
    calls,
    plugins: {
      Filesystem: {
        async writeFile(options) { calls.writes.push(options); return { uri: 'file:///tmp/' + options.path } },
        async deleteFile(options) { calls.deletes.push(options) }
      },
      Share: {
        async share(options) { calls.shares.push(options); if (shareError) throw shareError; return { activityType: 'test' } }
      }
    }
  }
}

class FakePDF {
  constructor() {
    this.internal = { pageSize: { getWidth: () => 210 }, getNumberOfPages: () => 1 }
    this.lastAutoTable = { finalY: 0 }
    FakePDF.instance = this
  }
  setFillColor() {}
  rect() {}
  setTextColor() {}
  setFont() {}
  setFontSize() {}
  roundedRect() {}
  text() {}
  autoTable(options) { this.lastAutoTable.finalY = Number(options.startY) + 20; options.didDrawPage?.({}) }
  save(filename) { this.saved = filename }
  output(type) { this.outputType = type; return 'data:application/pdf;base64,JVBERi0xLjQ=' }
}

test('browser filtered CSV export retains the anchor-download path', async () => {
  const app = loadApp()
  app.setRows([receipt()])

  await app.call('exportCSV')

  const anchor = app.createdElements.find(element => element.tagName === 'A')
  assert.equal(anchor.download, 'receipts_export.csv')
  assert.equal(anchor.clickCount, 1)
})

test('browser report CSV export retains its existing preview/share modal path', async () => {
  const app = loadApp()
  app.setPeriod('all'); app.setRows([receipt()])

  await app.call('exportReportCSV')

  assert.equal(app.element('exportModal').classList.contains('hidden'), false)
  assert.match(app.element('exportPreview').value, /"Officeworks"/)
})

test('browser PDF export retains the jsPDF save path', async () => {
  const app = loadApp()
  app.setPeriod('all'); app.setRows([receipt()]); app.setPDFConstructor(FakePDF)

  await app.call('exportReportPDF')

  assert.equal(FakePDF.instance.saved, 'Receipt-Box-All-Time.pdf')
  assert.equal(FakePDF.instance.outputType, undefined)
})

test('native filtered CSV export writes UTF-8 CSV and opens the native share sheet', async () => {
  const app = loadApp(), native = nativePlugins()
  app.setNativePlugins(native.plugins); app.setRows([receipt()])

  await app.call('exportCSV')

  assert.equal(native.calls.writes[0].path, 'receipts_export.csv')
  assert.equal(native.calls.writes[0].directory, 'TEMPORARY')
  assert.equal(native.calls.writes[0].encoding, 'utf8')
  assert.match(native.calls.writes[0].data, /"Officeworks"/)
  assert.deepEqual(JSON.parse(JSON.stringify(native.calls.shares[0].files)), ['file:///tmp/receipts_export.csv'])
})

test('plain native page registers header-backed plugin proxies without bundled imports', async () => {
  const app = loadApp(), native = nativePlugins()
  app.setNativePlugins(native.plugins, { registerOnly: true }); app.setRows([receipt()])

  await app.call('exportCSV')

  assert.equal(native.calls.writes.length, 1)
  assert.equal(native.calls.shares.length, 1)
})

test('native report CSV preserves the period filename and CSV file type', async () => {
  const app = loadApp(), native = nativePlugins()
  app.setNativePlugins(native.plugins); app.setPeriod('all'); app.setRows([receipt()])

  await app.call('exportReportCSV')

  assert.equal(native.calls.writes[0].path, 'Receipt-Box-All-Time.csv')
  const result = await app.call('shareNativeExport', { filename: 'mime.csv', mimeType: 'text/csv', text: 'a,b', title: 'CSV' })
  assert.equal(result.mimeType, 'text/csv')
})

test('native PDF export writes base64 PDF content with the correct filename and type', async () => {
  const app = loadApp(), native = nativePlugins()
  app.setNativePlugins(native.plugins); app.setPeriod('all'); app.setRows([receipt()]); app.setPDFConstructor(FakePDF)

  await app.call('exportReportPDF')

  assert.equal(native.calls.writes[0].path, 'Receipt-Box-All-Time.pdf')
  assert.equal(native.calls.writes[0].data, 'JVBERi0xLjQ=')
  assert.equal(native.calls.writes[0].encoding, undefined)
  assert.equal(FakePDF.instance.saved, undefined)
})

test('native exports clean temporary files only after sharing settles', async () => {
  const app = loadApp(), native = nativePlugins()
  app.setNativePlugins(native.plugins)

  await app.call('shareNativeExport', { filename: 'Receipt-Box.csv', mimeType: 'text/csv', text: 'a,b', title: 'CSV' })

  assert.equal(native.calls.shares.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(native.calls.deletes[0])), { path: 'Receipt-Box.csv', directory: 'TEMPORARY' })
})

test('native share failure shows a concise error, cleans up, and leaves the UI usable', async () => {
  const app = loadApp(), native = nativePlugins({ shareError: Error('private native detail') })
  app.setNativePlugins(native.plugins); app.setPeriod('all'); app.setRows([receipt()])

  await app.call('exportReportCSV')

  assert.deepEqual(app.alerts, ['Receipt Box could not share this export. Please try again.'])
  assert.equal(native.calls.deletes.length, 1)
  assert.equal(app.element('reportCsvBtn').disabled, false)
})

test('native CSV export never invokes the browser download path', async () => {
  const app = loadApp(), native = nativePlugins()
  app.setNativePlugins(native.plugins); app.setRows([receipt()])

  await app.call('exportCSV')

  assert.equal(app.createdElements.some(element => element.tagName === 'A'), false)
  assert.equal(native.calls.shares.length, 1)
})
