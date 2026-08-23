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

test('uses inclusive custom date boundaries and report filters', () => {
  const app = loadApp()
  app.setRows([
    { id: 'before', receipt_date: '2026-07-31', entity_name: 'AWTCO', category_name: 'Fuel', project_name: 'Expo' },
    { id: 'first', receipt_date: '2026-08-01', entity_name: 'AWTCO', category_name: 'Fuel', project_name: 'Expo' },
    { id: 'other', receipt_date: '2026-08-10', entity_name: 'Personal', category_name: 'Fuel', project_name: 'Expo' },
    { id: 'last', receipt_date: '2026-08-31', entity_name: 'AWTCO', category_name: 'Fuel', project_name: 'Expo' },
    { id: 'after', receipt_date: '2026-09-01', entity_name: 'AWTCO', category_name: 'Fuel', project_name: 'Expo' }
  ])
  app.setPeriod('custom')
  app.element('reportDateFrom').value = '2026-08-01'
  app.element('reportDateTo').value = '2026-08-31'
  assert.deepEqual(ids(app.call('reportPeriodRows')), ['first', 'other', 'last'])
  app.element('reportEntity').value = 'AWTCO'
  assert.deepEqual(ids(app.call('reportPeriodRows')), ['first', 'last'])
  app.element('reportDateFrom').value = '2026-09-01'
  app.element('reportDateTo').value = '2026-08-01'
  assert.deepEqual(ids(app.call('reportPeriodRows')), [])
})

test('calculates totals, averages, and entity/category/project/month groups', () => {
  const app = loadApp()
  const rows = [
    { receipt_date: '2026-07-01', total: 110, gst: 10, category_name: 'Fuel', entity_name: 'AWTCO', project_name: 'Expo' },
    { receipt_date: '2026-08-01', total: 55, gst: 5, category_name: 'Fuel', entity_name: 'National Events', project_name: 'Expo' },
    { receipt_date: '2026-08-02', total: 220, gst: 20, category_name: 'Software', entity_name: 'AWTCO', project_name: '' }
  ]
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('reportMetrics', rows))), { total: 385, gst: 35, count: 3, average: 385 / 3 })
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('groupedReport', rows, 'category_name'))), [
    { name: 'Software', total: 220, count: 1 },
    { name: 'Fuel', total: 165, count: 2 }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('groupedReport', rows, 'entity_name'))), [
    { name: 'AWTCO', total: 330, count: 2 },
    { name: 'National Events', total: 55, count: 1 }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('groupedReport', rows, 'project_name', 'No project'))), [
    { name: 'No project', total: 220, count: 1 },
    { name: 'Expo', total: 165, count: 2 }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('monthlyReportGroups', rows))), [
    { key: '2026-07', name: 'July 2026', total: 110, count: 1 },
    { key: '2026-08', name: 'August 2026', total: 275, count: 2 }
  ])
})

test('drill-down returns only receipts contributing to the selected group', () => {
  const app = loadApp()
  const rows = [
    { id: 'fuel-july', receipt_date: '2026-07-05', category_name: 'Fuel', entity_name: 'AWTCO', project_name: 'Expo' },
    { id: 'fuel-august', receipt_date: '2026-08-05', category_name: 'Fuel', entity_name: 'Personal', project_name: '' },
    { id: 'office', receipt_date: '2026-08-06', category_name: 'Office', entity_name: 'AWTCO', project_name: 'Expo' }
  ]
  assert.deepEqual(ids(app.call('reportDrillRows', 'category', 'Fuel', rows)), ['fuel-july', 'fuel-august'])
  assert.deepEqual(ids(app.call('reportDrillRows', 'entity', 'AWTCO', rows)), ['fuel-july', 'office'])
  assert.deepEqual(ids(app.call('reportDrillRows', 'project', 'No project', rows)), ['fuel-august'])
  assert.deepEqual(ids(app.call('reportDrillRows', 'month', '2026-08', rows)), ['fuel-august', 'office'])
})

test('builds CSV report data for the selected period with escaped text', () => {
  const app = loadApp()
  app.setPeriod('all')
  app.setRows([{
    receipt_date: '2026-08-02', supplier: 'Smith "Office"', total: 44, gst: 4,
    entity_name: 'AWTCO', category_name: 'Office Supplies', project_name: 'Expo', notes: 'Paper, pens', file_path: 'user/receipt/paper.pdf'
  }])
  const csv = app.call('buildReportCSV')
  assert.match(csv, /^"Date","Supplier","Total","GST","Entity","Category","Project","Notes","Attachment present","Attachment filename"/)
  assert.match(csv, /"Smith ""Office"""/)
  assert.match(csv, /"Paper, pens"/)
  assert.match(csv, /"Yes","paper.pdf"/)
  assert.equal(app.call('reportFilename', 'csv'), 'Receipt-Box-All-Time.csv')
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

test('passes selected-period metrics, summaries, projects, and receipts to the PDF report', () => {
  const app = loadApp()
  app.setPeriod('custom')
  app.element('reportDateFrom').value = '2026-08-01'
  app.element('reportDateTo').value = '2026-08-31'
  app.setRows([
    { receipt_date: '2026-07-31', supplier: 'Excluded', total: 999, gst: 90, category_name: 'Other', entity_name: 'Personal', project_name: 'Old project' },
    { receipt_date: '2026-08-01', supplier: 'Ampol', total: 110, gst: 10, category_name: 'Fuel', entity_name: 'AWTCO', project_name: 'A very long project name that must wrap safely' },
    { receipt_date: '2026-08-02', supplier: 'Adobe', total: 220, gst: 20, category_name: 'Software', entity_name: 'National Events', project_name: '' }
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

  assert.equal(state.filename, 'Receipt-Box-2026-08-01-to-2026-08-31.pdf')
  assert.ok(state.texts.includes('$330.00'))
  assert.ok(state.texts.includes('$30.00'))
  assert.ok(state.texts.includes('2'))
  assert.ok(state.texts.includes('$165.00'))
  const plain = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(state.tables[0].head), [['Entity', 'Receipts', 'Total']])
  assert.deepEqual(plain(state.tables[1].head), [['Category', 'Receipts', 'Total']])
  assert.deepEqual(plain(state.tables[2].head), [['Project', 'Receipts', 'Total']])
  assert.deepEqual(plain(state.tables[3].head), [['Date', 'Supplier', 'Entity', 'Category', 'Project', 'GST', 'Total']])
  assert.equal(state.tables[3].body.length, 2)
  assert.equal(state.tables[3].body.some(row => row.includes('Excluded')), false)
  assert.deepEqual(plain(state.tables[3].body[0]), ['2026-08-01', 'Ampol', 'AWTCO', 'Fuel', 'A very long project name that must wrap safely', '$10.00', '$110.00'])
  assert.equal(state.tables[3].showHead, 'everyPage')
  assert.equal(Object.values(state.tables[3].columnStyles).reduce((sum, column) => sum + column.cellWidth, 0), 182)
  assert.equal(state.tables[3].styles.overflow, 'linebreak')
})

test('uses clear financial-year and custom-range export filenames', () => {
  const app = loadApp()
  app.setPeriod('fy')
  assert.equal(app.call('reportFilename', 'csv'), 'Receipt-Box-FY2026-27.csv')
  app.setPeriod('custom')
  app.element('reportDateFrom').value = '2026-08-01'
  app.element('reportDateTo').value = '2026-08-31'
  assert.equal(app.call('reportFilename', 'pdf'), 'Receipt-Box-2026-08-01-to-2026-08-31.pdf')
})
