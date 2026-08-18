const test = require('node:test')
const assert = require('node:assert/strict')
const { loadApp } = require('./load-app')

const boundaryRows = [
  { id: 'before-last', receipt_date: '2025-06-30', total: 10 },
  { id: 'last-start', receipt_date: '2025-07-01', total: 20 },
  { id: 'last-end', receipt_date: '2026-06-30', total: 30 },
  { id: 'fy-start', receipt_date: '2026-07-01', total: 40 },
  { id: 'month', receipt_date: '2026-08-05', total: 50 },
  { id: 'fy-end', receipt_date: '2027-06-30', total: 60 },
  { id: 'after-fy', receipt_date: '2027-07-01', total: 70 }
]

function ids(rows) {
  return JSON.parse(JSON.stringify(rows)).map(row => row.id)
}

test('uses Australian July-to-June financial-year boundaries', () => {
  const app = loadApp()
  app.setRows(boundaryRows)

  app.setPeriod('fy')
  assert.deepEqual(ids(app.call('reportPeriodRows')), ['fy-start', 'month', 'fy-end'])

  app.setPeriod('lastfy')
  assert.deepEqual(ids(app.call('reportPeriodRows')), ['last-start', 'last-end'])

  app.setPeriod('month')
  assert.deepEqual(ids(app.call('reportPeriodRows')), ['month'])

  app.setPeriod('all')
  assert.deepEqual(ids(app.call('reportPeriodRows')), boundaryRows.map(row => row.id))
})

test('calculates totals, averages, and category/entity groups', () => {
  const app = loadApp()
  const rows = [
    { total: 110, gst: 10, category_name: 'Fuel', entity_name: 'AWTCO' },
    { total: 55, gst: 5, category_name: 'Fuel', entity_name: 'National Events' },
    { total: 220, gst: 20, category_name: 'Software', entity_name: 'AWTCO' }
  ]
  assert.equal(app.call('sumRows', rows, 'total'), 385)
  assert.equal(app.call('sumRows', rows, 'gst'), 35)
  assert.equal(app.call('sumRows', rows, 'total') / rows.length, 385 / 3)
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('groupedReport', rows, 'category_name'))), [
    { name: 'Software', total: 220, count: 1 },
    { name: 'Fuel', total: 165, count: 2 }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('groupedReport', rows, 'entity_name'))), [
    { name: 'AWTCO', total: 330, count: 2 },
    { name: 'National Events', total: 55, count: 1 }
  ])
})

test('builds CSV report data for the selected period with escaped text', () => {
  const app = loadApp()
  app.setPeriod('all')
  app.setRows([{
    receipt_date: '2026-08-02', supplier: 'Smith "Office"', total: 44, gst: 4,
    entity_name: 'AWTCO', category_name: 'Office Supplies', project_name: 'Expo', notes: 'Paper, pens'
  }])
  const csv = app.call('buildReportCSV')
  assert.match(csv, /^"Date","Supplier","Total","GST","Entity","Category","Project","Notes"/)
  assert.match(csv, /"Smith ""Office"""/)
  assert.match(csv, /"Paper, pens"/)
})

test('neutralises spreadsheet formulas in every CSV value', () => {
  const app = loadApp()
  for (const prefix of ['=', '+', '-', '@']) {
    assert.equal(app.call('csvValue', prefix + 'SUM(A1:A2)'), '"\'' + prefix + 'SUM(A1:A2)"')
  }
  assert.equal(app.call('csvValue', 'Normal supplier'), '"Normal supplier"')

  app.setPeriod('all')
  app.setRows([{
    receipt_date: '2026-08-03', supplier: '=HYPERLINK("https://example.test")', total: 10, gst: 1,
    entity_name: 'AWTCO', category_name: 'Other', project_name: '+CMD', notes: '@malicious'
  }])
  const csv = app.call('buildReportCSV')
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test""\)"/)
  assert.match(csv, /"'\+CMD"/)
  assert.match(csv, /"'@malicious"/)
})

test('passes selected-period metrics, summaries, and receipts to the PDF report', () => {
  const app = loadApp()
  app.setPeriod('all')
  app.setRows([
    { receipt_date: '2026-08-01', supplier: 'Ampol', total: 110, gst: 10, category_name: 'Fuel', entity_name: 'AWTCO' },
    { receipt_date: '2026-08-02', supplier: 'Adobe', total: 220, gst: 20, category_name: 'Software', entity_name: 'National Events' }
  ])

  const state = { texts: [], tables: [], filename: null }
  class FakePDF {
    constructor() {
      this.internal = { pageSize: { getWidth: () => 210 }, getNumberOfPages: () => 1 }
      this.lastAutoTable = { finalY: 0 }
    }
    setFillColor() {}
    rect() {}
    setTextColor() {}
    setFont() {}
    setFontSize() {}
    roundedRect() {}
    text(value) { state.texts.push(String(value)) }
    autoTable(options) {
      state.tables.push(options)
      this.lastAutoTable.finalY = Number(options.startY) + 20
      if (options.didDrawPage) options.didDrawPage({})
    }
    save(filename) { state.filename = filename }
  }
  app.setPDFConstructor(FakePDF)
  app.call('exportReportPDF')

  assert.equal(state.filename, 'receipt-box-all-report.pdf')
  assert.ok(state.texts.includes('$330.00'))
  assert.ok(state.texts.includes('$30.00'))
  assert.ok(state.texts.includes('2'))
  assert.ok(state.texts.includes('$165.00'))
  const plain = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(state.tables[0].head), [['Category', 'Receipts', 'Total']])
  assert.deepEqual(plain(state.tables[1].head), [['Entity', 'Receipts', 'Total']])
  assert.deepEqual(plain(state.tables[2].head), [['Date', 'Supplier', 'Category', 'Entity', 'GST', 'Total']])
  assert.equal(state.tables[2].body.length, 2)
  assert.deepEqual(plain(state.tables[2].body[0]), ['2026-08-01', 'Ampol', 'Fuel', 'AWTCO', '$10.00', '$110.00'])
})
