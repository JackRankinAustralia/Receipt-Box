const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

const colesOCR = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'coles-ocr.json'), 'utf8'))

test('recognises known suppliers and chooses a plausible unknown supplier', () => {
  const app = loadApp()
  assert.equal(app.call('supplierFromLines', ['TAX INVOICE', 'OFFICEWORKS 0421', 'Melbourne VIC'], 'OFFICEWORKS 0421'), 'Officeworks')
  assert.equal(app.call('supplierFromLines', ['TAX INVOICE', 'Bright Star Catering', '12 Smith Street'], 'Bright Star Catering'), 'Bright Star Catering')
})

test('detects HEIC and HEIF photos without changing other upload types', () => {
  const app = loadApp()
  assert.equal(app.call('isHeicFile', { name: 'receipt.HEIC', type: '' }), true)
  assert.equal(app.call('isHeicFile', { name: 'receipt', type: 'image/heif' }), true)
  assert.equal(app.call('isHeicFile', { name: 'receipt.jpg', type: 'image/jpeg' }), false)
  assert.equal(app.call('isHeicFile', { name: 'receipt.pdf', type: 'application/pdf' }), false)
})

test('converts HEIC photos to JPEG and reports conversion failures clearly', async () => {
  const app = loadApp()
  const source = new File([new Uint8Array([1, 2, 3])], 'phone-receipt.HEIC', { type: 'image/heic', lastModified: 123 })
  let options
  app.setHeicConverter(async value => {
    options = value
    return new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' })
  })
  const converted = await app.call('convertReceiptFile', source)
  assert.equal(converted.name, 'phone-receipt.jpg')
  assert.equal(converted.type, 'image/jpeg')
  assert.equal(options.blob, source)
  assert.equal(options.toType, 'image/jpeg')

  app.setHeicConverter(async () => { throw new Error('decoder failed') })
  await assert.rejects(
    app.call('convertReceiptFile', source),
    /HEIC\/HEIF photo could not be converted.*JPEG/i
  )
})

test('enables OCR diagnostics only for development or an explicit debug flag', () => {
  const app = loadApp()
  assert.equal(app.call('ocrDebugEnabled', { protocol: 'file:', hostname: '', search: '' }), false)
  assert.equal(app.call('ocrDebugEnabled', { protocol: 'http:', hostname: 'localhost', search: '' }), false)
  assert.equal(app.call('ocrDebugEnabled', { protocol: 'https:', hostname: 'receiptboxapp.vercel.app', search: '?debug=ocr' }), true)
  assert.equal(app.call('ocrDebugEnabled', { protocol: 'https:', hostname: 'receiptboxapp.vercel.app', search: '' }), false)
})

test('prefers OCR output containing receipt totals, payments, GST, and dates', () => {
  const app = loadApp()
  const raw = { confidence: 38, text: 'COLES\nTotal 3.2' }
  const processed = { confidence: 55, text: 'COLES\nDate 13/08/2026\nTotal for 14 items $73.22\nEFT $73.22\nGST INCLUDED IN TOTAL $1.31' }
  assert.ok(app.call('ocrResultScore', processed) > app.call('ocrResultScore', raw))
})

test('builds field-level consensus from Coles raw, enhanced, binary, and bottom OCR', () => {
  const app = loadApp()
  const fields = app.call('receiptFieldsFromOCR', colesOCR)
  assert.equal(fields.supplier.value, 'Coles')
  assert.equal(fields.date.value, '2026-08-13')
  assert.equal(fields.total.value, 73.22)
  assert.equal(fields.gst.value, 1.31)
  assert.equal(fields.supplier.source, 'enhanced')
  assert.equal(fields.date.source, 'enhanced')
  assert.match(fields.date.reason, /inferred from 13\/08\/202/i)
  assert.match(fields.total.source, /raw/)
  assert.match(fields.total.source, /bottom crop/)
  assert.equal(fields.gst.source, 'bottom crop')
  assert.match(fields.total.reason, /raw exact/i)
  assert.match(fields.total.reason, /bottom crop TOTAL slash-normalised/i)
  assert.match(fields.total.reason, /bottom crop EFT\/payment/i)
  assert.match(fields.total.reason, /item-sum corroboration/i)
  assert.match(fields.gst.reason, /bottom crop GST label space-normalised/i)
  const twoDollarItem = fields.candidates.totals.find(candidate => candidate.value === 2)
  assert.ok(twoDollarItem.score < fields.total.score)
  assert.match(twoDollarItem.reason, /item-line penalty/i)
  const itemCandidate = fields.candidates.totals.find(candidate => candidate.value === 20)
  assert.notEqual(fields.total.value, 20)
  assert.ok(itemCandidate.score < fields.total.score)
  assert.ok(itemCandidate.score < 100)
  assert.match(itemCandidate.reason, /item-line context/i)
  assert.match(itemCandidate.reason, /item-line penalty/i)
})

test('infers only a plausible final date digit near the receipt date', () => {
  const app = loadApp()
  const inferred = app.call('dateInfoFromText', 'noise 13/08/202 text', new Date('2026-08-18T12:00:00+10:00'))
  assert.deepEqual(JSON.parse(JSON.stringify(inferred)), {
    value: '2026-08-13', inferred: true, raw: '13/08/202', distance: 5
  })
  assert.equal(app.call('dateInfoFromText', 'noise 13/08/199 text', new Date('2026-08-18T12:00:00+10:00')), null)
})

test('does not admit bare payment integers as total candidates', () => {
  const app = loadApp()
  const consensus = app.call('totalConsensusFromOCR', {
    raw: { confidence: 50, text: 'COLES\nEFT 2\nCARD 20' }
  })
  assert.equal(consensus.selected, null)
  assert.deepEqual(JSON.parse(JSON.stringify(consensus.candidates)), [])
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

test('parses Coles supermarket totals and supporting payment amounts', () => {
  const app = loadApp()
  const lines = [
    'COLES', '13/08/2026 18:42', 'Bananas 3.50', 'Milk 4.60',
    'SUBTOTAL $74.53', 'SAVINGS $1.31', 'Total for 14 items $73.22',
    'EFT $73.22', 'GST INCLUDED IN TOTAL $1.31'
  ]
  const text = lines.join('\n')
  assert.equal(app.call('supplierFromLines', lines, text), 'Coles')
  assert.equal(app.call('isoDateFromText', text), '2026-08-13')
  assert.equal(app.call('parseReceiptTotal', lines), 73.22)
  assert.equal(app.call('parseGST', lines), 1.31)
})

test('parses Coles totals when OCR separates labels, item counts, and values', () => {
  const app = loadApp()
  const variants = [
    ['COLES', '13 / 08 / 2026', 'Total for 14 items', '$73.22', 'EFT', '73.22', 'GST INCLUDED IN TOTAL', '1.31'],
    ['COLES', '13-08-2026', 'TOTAL 14 ITEMS 73.22', 'VISA PURCHASE 73.22', 'GST INCLUDED IN TOTAL 1.31'],
    ['COLES', '13.08.2026', 'Total for', '14 items   $ 73.22', 'Mastercard', '$73.22', 'GST INCLUDED IN TOTAL $1.31']
  ]
  for (const lines of variants) {
    assert.equal(app.call('parseReceiptTotal', lines), 73.22)
    assert.equal(app.call('parseGST', lines), 1.31)
  }
})

test('total fallback rejects non-total receipt numbers', () => {
  const app = loadApp()
  const lines = [
    'COLES 0412 345 678', '13/08/2026', 'ITEM 1 $8.50', 'SUBTOTAL $65.00',
    'SAVINGS $8.22', 'GST INCLUDED IN TOTAL $1.31', 'CHANGE $26.78'
  ]
  assert.equal(app.call('parseReceiptTotal', lines), null)
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
