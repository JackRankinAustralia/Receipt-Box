const test = require('node:test')
const assert = require('node:assert/strict')
const { loadApp } = require('./load-app')

test('recognises known suppliers and chooses a plausible unknown supplier', () => {
  const app = loadApp()
  assert.equal(app.call('supplierFromLines', ['TAX INVOICE', 'OFFICEWORKS 0421', 'Melbourne VIC'], 'OFFICEWORKS 0421'), 'Officeworks')
  assert.equal(app.call('supplierFromLines', ['TAX INVOICE', 'Bright Star Catering', '12 Smith Street'], 'Bright Star Catering'), 'Bright Star Catering')
})

test('parses Australian numeric and named receipt dates', () => {
  const app = loadApp()
  assert.equal(app.call('isoDateFromText', 'Purchased 17/08/2026 at 10:30'), '2026-08-17')
  assert.equal(app.call('isoDateFromText', 'Invoice date: 3 August 2026'), '2026-08-03')
  assert.equal(app.call('isoDateFromText', 'Issued 2026-08-11'), '2026-08-11')
})

test('prefers explicit totals and excludes subtotal and change lines', () => {
  const app = loadApp()
  const lines = ['Subtotal $90.91', 'GST included $9.09', 'GRAND TOTAL AUD 100.00', 'Cash $120.00', 'Change $20.00']
  assert.equal(app.call('parseReceiptTotal', lines), 100)
})

test('parses GST amounts without treating tax invoice headings as values', () => {
  const app = loadApp()
  assert.equal(app.call('parseGST', ['TAX INVOICE 12345', 'GST included $12.34']), 12.34)
  assert.equal(app.call('parseGST', ['GST-FREE ITEMS $20.00']), null)
})

test('detects common receipt categories', () => {
  const app = loadApp()
  assert.equal(app.call('suggestCategory', 'Unleaded 91 40 litres', 'Ampol'), 'Fuel')
  assert.equal(app.call('suggestCategory', 'Printer toner and A4 paper', 'Officeworks'), 'Office Supplies')
  assert.equal(app.call('suggestCategory', 'Annual Creative Cloud subscription', 'Adobe'), 'Software')
  assert.equal(app.call('suggestCategory', 'General purchase', 'Local Store'), null)
})
