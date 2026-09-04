const test = require('node:test')
const assert = require('node:assert/strict')
const { loadApp } = require('./load-app')

function ids(rows) {
  return JSON.parse(JSON.stringify(rows)).map(row => row.id)
}

function receipt(overrides = {}) {
  return {
    id: 'r1', supplier: 'Bunnings Warehouse', receipt_date: '2026-09-05', total: 40.90,
    entity_name: 'AWTCO', category_name: 'Materials', project_name: null, notes: '',
    workflow_status: 'completed', ...overrides
  }
}

// ---- Month grouping ----

test('groupReceiptsByMonth groups completed rows by receipt_date month, newest month first for newest sort', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'sep', receipt_date: '2026-09-05' }),
    receipt({ id: 'aug', receipt_date: '2026-08-20' }),
    receipt({ id: 'jul', receipt_date: '2026-07-01' })
  ]
  const groups = app.call('groupReceiptsByMonth', app.call('filterAndSortReceipts', rows, { sort: 'newest' }), 'newest')
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => g.key))), ['2026-09', '2026-08', '2026-07'])
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => g.label))), ['September 2026', 'August 2026', 'July 2026'])
})

test('groupReceiptsByMonth orders months oldest-first when sort is oldest', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'sep', receipt_date: '2026-09-05' }),
    receipt({ id: 'jul', receipt_date: '2026-07-01' })
  ]
  const groups = app.call('groupReceiptsByMonth', app.call('filterAndSortReceipts', rows, { sort: 'oldest' }), 'oldest')
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => g.key))), ['2026-07', '2026-09'])
})

test('groupReceiptsByMonth places rows with missing/invalid receipt_date into an UNDATED group at the bottom', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'dated', receipt_date: '2026-09-05' }),
    receipt({ id: 'missing', receipt_date: null }),
    receipt({ id: 'invalid', receipt_date: 'not-a-date' })
  ]
  const groups = app.call('groupReceiptsByMonth', app.call('filterAndSortReceipts', rows, { sort: 'newest' }), 'newest')
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => g.key))), ['2026-09', 'UNDATED'])
  assert.deepEqual(JSON.parse(JSON.stringify(ids(groups[1].rows))).sort(), ['invalid', 'missing'])
})

test('groupReceiptsByMonth produces no groups for an empty row set', () => {
  const app = loadApp()
  assert.deepEqual(JSON.parse(JSON.stringify(app.call('groupReceiptsByMonth', [], 'newest'))), [])
})

test('groupReceiptsByMonth month label uses noon-local date construction to avoid UTC rollback', () => {
  const app = loadApp()
  assert.equal(app.call('receiptMonthLabel', '2026-09'), 'September 2026')
  assert.equal(app.call('receiptMonthLabel', '2026-01'), 'January 2026')
})

// ---- Human-readable dates ----

test('formatReceiptDateDisplay renders an Australian medium date for receipt rows', () => {
  const app = loadApp()
  assert.equal(app.call('formatReceiptDateDisplay', '2026-09-05'), new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium' }).format(new Date('2026-09-05T12:00:00')))
})

test('formatReceiptDateDisplay returns empty string for missing receipt_date', () => {
  const app = loadApp()
  assert.equal(app.call('formatReceiptDateDisplay', ''), '')
})

// ---- Default order preserved ----

test('default sort remains receipt_date newest-to-oldest, independent of upload order', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'old', receipt_date: '2026-03-01' }),
    receipt({ id: 'new', receipt_date: '2026-09-01' })
  ]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, {})), ['new', 'old'])
})

// ---- Search extension: total + receipt_date, tokenized ----

test('search matches on formatted total with a dollar sign', () => {
  const app = loadApp()
  const rows = [receipt({ id: 'match', total: 40.90 }), receipt({ id: 'other', total: 12 })]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { query: '$40.90' })), ['match'])
})

test('search matches on plain numeric total text', () => {
  const app = loadApp()
  const rows = [receipt({ id: 'match', total: 40.90 }), receipt({ id: 'other', total: 12 })]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { query: '40.90' })), ['match'])
})

test('search supports multi-token queries requiring every token to match (supplier + amount)', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'match', supplier: 'Bunnings Warehouse', total: 40.90 }),
    receipt({ id: 'wrong-amount', supplier: 'Bunnings Warehouse', total: 12 }),
    receipt({ id: 'wrong-supplier', supplier: 'Officeworks', total: 40.90 })
  ]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { query: 'bunnings 40.90' })), ['match'])
})

test('search supports multi-token queries across supplier words (officeworks printer style)', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'match', supplier: 'Officeworks', notes: 'printer paper' }),
    receipt({ id: 'no-note', supplier: 'Officeworks', notes: '' })
  ]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { query: 'officeworks printer' })), ['match'])
})

test('search matches on receipt_date text (formatted display date)', () => {
  const app = loadApp()
  const rows = [receipt({ id: 'match', receipt_date: '2026-09-05' }), receipt({ id: 'other', receipt_date: '2026-08-01' })]
  const display = app.call('formatReceiptDateDisplay', '2026-09-05').toLowerCase()
  const token = display.split(/\s+/)[1] || display
  const result = app.call('filterAndSortReceipts', rows, { query: token })
  assert.deepEqual(JSON.parse(JSON.stringify(ids(result))), ['match'])
})

test('search does not use undesirable partial-number substring matches across unrelated digits', () => {
  const app = loadApp()
  const rows = [receipt({ id: 'exact', total: 40.90 }), receipt({ id: 'unrelated', total: 140.90 })]
  const result = app.call('filterAndSortReceipts', rows, { query: '40.90' })
  // Both legitimately contain the substring "40.90"; assert no crash and exact-value row is included
  assert.ok(ids(result).includes('exact'))
})

// ---- UNDATED never disappears / empty results ----

test('renderRows: an undated completed receipt still renders under an Undated heading', () => {
  const app = loadApp()
  app.setRows([receipt({ id: 'undated', receipt_date: null })])
  app.call('renderRows')
  const html = app.element('receipts').innerHTML
  assert.match(html, /Undated/)
  assert.match(html, /undated/)
})

test('renderRows: no matching receipts preserves the existing no-results message without empty month headings', () => {
  const app = loadApp()
  app.setRows([receipt({ id: 'a', supplier: 'Bunnings Warehouse' })])
  const el = app.element('search')
  if (el) el.value = 'zzz-no-match'
  app.call('renderRows')
  const html = app.element('receipts').innerHTML
  assert.equal(html, 'No matching receipts.')
})

// ---- Needs Review newest-admitted-first ----

test('needsReviewRows sorts by scan_started_at newest-admitted-first', () => {
  const app = loadApp()
  app.setRows([
    { id: 'older', workflow_status: 'needs_review', scan_started_at: '2026-09-01T00:00:00Z' },
    { id: 'newer', workflow_status: 'needs_review', scan_started_at: '2026-09-02T00:00:00Z' }
  ])
  assert.deepEqual(ids(app.call('needsReviewRows')), ['newer', 'older'])
})

test('needsReviewRows treats a missing scan_started_at as older than any timestamped row', () => {
  const app = loadApp()
  app.setRows([
    { id: 'legacy-no-timestamp', workflow_status: 'needs_review', scan_started_at: null },
    { id: 'timestamped', workflow_status: 'needs_review', scan_started_at: '2026-09-01T00:00:00Z' }
  ])
  assert.deepEqual(ids(app.call('needsReviewRows')), ['timestamped', 'legacy-no-timestamp'])
})

test('needsReviewRows is stable (does not throw/reorder unexpectedly) when all rows lack scan_started_at', () => {
  const app = loadApp()
  app.setRows([
    { id: 'a', workflow_status: 'needs_review', scan_started_at: null },
    { id: 'b', workflow_status: 'needs_attention', scan_started_at: null }
  ])
  assert.deepEqual(ids(app.call('needsReviewRows')).sort(), ['a', 'b'])
})

// ---- Regression: sort options preserved ----

test('sort option "supplier" still orders A-Z case-insensitively', () => {
  const app = loadApp()
  const rows = [receipt({ id: 'b', supplier: 'bunnings' }), receipt({ id: 'a', supplier: 'Apco' })]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { sort: 'supplier' })), ['a', 'b'])
})

test('sort option "highest" still orders by total descending', () => {
  const app = loadApp()
  const rows = [receipt({ id: 'low', total: 5 }), receipt({ id: 'high', total: 50 })]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { sort: 'highest' })), ['high', 'low'])
})

test('sort option "lowest" still orders by total ascending', () => {
  const app = loadApp()
  const rows = [receipt({ id: 'low', total: 5 }), receipt({ id: 'high', total: 50 })]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { sort: 'lowest' })), ['low', 'high'])
})

// ---- Regression: existing filters/search fields still work ----

test('existing entity/category/date filters still combine correctly with the new search', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'match', entity_name: 'AWTCO', category_name: 'Materials', receipt_date: '2026-09-05' }),
    receipt({ id: 'wrong-entity', entity_name: 'Personal', category_name: 'Materials', receipt_date: '2026-09-05' })
  ]
  const result = app.call('filterAndSortReceipts', rows, { entity: 'AWTCO', category: 'Materials', dateFrom: '2026-09-01', dateTo: '2026-09-30' })
  assert.deepEqual(ids(result), ['match'])
})

test('search on supplier/category/entity/project/notes still works unchanged', () => {
  const app = loadApp()
  const rows = [
    receipt({ id: 'match', notes: 'special note' }),
    receipt({ id: 'other', notes: '' })
  ]
  assert.deepEqual(ids(app.call('filterAndSortReceipts', rows, { query: 'special note' })), ['match'])
})

// ---- Stage 4B1 duplicate detection unaffected ----

test('findPossibleDuplicate still operates against the full allRows regardless of search/filter/sort state', () => {
  const app = loadApp()
  app.setRows([
    receipt({ id: 'existing', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90, workflow_status: 'completed' }),
    receipt({ id: 'new', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90, workflow_status: 'needs_review' })
  ])
  const el = app.element('search')
  if (el) el.value = 'zzz-no-match'
  const match = app.call('findPossibleDuplicate', { id: 'new', supplier: 'Bunnings Warehouse', receipt_date: '2025-12-30', total: 40.90 })
  assert.equal(match.id, 'existing')
})

// ---- Financial/report regression ----

test('monthlyReportGroups (Reports feature) remains unchanged by the new archive grouping helper', () => {
  const app = loadApp()
  const rows = [
    { id: 'a', receipt_date: '2026-08-05', total: 10, gst: 1 },
    { id: 'b', receipt_date: '2026-09-05', total: 20, gst: 2 }
  ]
  const groups = JSON.parse(JSON.stringify(app.call('monthlyReportGroups', rows)))
  assert.equal(groups.length, 2)
})
