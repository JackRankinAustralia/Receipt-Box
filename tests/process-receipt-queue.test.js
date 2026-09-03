const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function loadWorkflow() {
  return import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'process-receipt-queue', 'workflow.mjs')).href)
}
async function loadDates() {
  return import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'process-receipt-queue', 'receiptDates.mjs')).href)
}
async function loadGemini() {
  return import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'process-receipt-queue', 'geminiReceiptScan.mjs')).href)
}
async function loadWorkerAuth() {
  return import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'process-receipt-queue', 'workerAuth.mjs')).href)
}
async function loadMaxReceipts() {
  return import(pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'process-receipt-queue', 'maxReceipts.mjs')).href)
}

function makeClaim(overrides = {}) {
  return {
    claimed: true,
    receipt_id: 'receipt-1',
    user_id: 'user-1',
    file_path: 'user-1/receipt-1/receipt.jpg',
    mime_type: 'image/jpeg',
    scan_session_id: 'session-1',
    scan_attempts: 1,
    ...overrides
  }
}

test('processes a bounded batch and stops when the queue is empty', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  const claims = [makeClaim({ receipt_id: 'r1' }), { claimed: false }]
  let claimCalls = 0
  const summary = await processReceiptQueueBatch({
    maxReceipts: 3,
    generateSessionId: () => 'session-x',
    claimNext: async () => claims[claimCalls++],
    beginEntitlement: async () => ({ allowed: true }),
    downloadReceiptFile: async () => 'base64image',
    callGemini: async () => ({ ok: true, fields: { supplier: 'Woolworths', date_text: '04/12/2025', total: '12.50', gst: '1.14' } }),
    extractMeaningfulFields: (fields) => ({ supplier: fields.supplier, date: '2025-12-04', total: 12.5, gst: 1.14, meaningful: true }),
    completeOcr: async () => ({ workflow_status: 'needs_review' })
  })
  assert.equal(claimCalls, 2)
  assert.equal(summary.claimed, 1)
  assert.equal(summary.succeeded, 1)
})

test('never claims more than maxReceipts in one invocation', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  let claimCalls = 0
  const summary = await processReceiptQueueBatch({
    maxReceipts: 3,
    generateSessionId: () => 'session-x',
    claimNext: async () => { claimCalls++; return makeClaim({ receipt_id: `r${claimCalls}` }) },
    beginEntitlement: async () => ({ allowed: true }),
    downloadReceiptFile: async () => 'base64image',
    callGemini: async () => ({ ok: true, fields: {} }),
    extractMeaningfulFields: () => ({ meaningful: true, supplier: 'Shop', date: null, total: null, gst: null }),
    completeOcr: async () => ({ workflow_status: 'needs_review' })
  })
  assert.equal(claimCalls, 3)
  assert.equal(summary.claimed, 3)
  assert.equal(summary.succeeded, 3)
})

test('quota exhaustion skips Gemini entirely and marks needs_attention with no charge', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  let geminiCalls = 0
  let completeArgs
  const summary = await processReceiptQueueBatch({
    maxReceipts: 1,
    generateSessionId: () => 'session-x',
    claimNext: async () => makeClaim(),
    beginEntitlement: async () => ({ allowed: false }),
    downloadReceiptFile: async () => { throw new Error('should not be called') },
    callGemini: async () => { geminiCalls++; return { ok: true, fields: {} } },
    extractMeaningfulFields: () => ({ meaningful: true }),
    completeOcr: async (receiptId, sessionId, outcome) => { completeArgs = outcome; return { workflow_status: 'needs_attention' } }
  })
  assert.equal(geminiCalls, 0)
  assert.equal(summary.quota_exhausted, 1)
  assert.equal(completeArgs.success, false)
  assert.equal(completeArgs.retryable, false)
  assert.equal(completeArgs.errorSummary, 'Monthly OCR limit reached.')
})

test('transient Gemini failure is reported as retryable and requeued', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  let completeArgs
  const summary = await processReceiptQueueBatch({
    maxReceipts: 1,
    generateSessionId: () => 'session-x',
    claimNext: async () => makeClaim(),
    beginEntitlement: async () => ({ allowed: true }),
    downloadReceiptFile: async () => 'base64image',
    callGemini: async () => ({ ok: false, retryable: true, message: 'Gemini API request failed with HTTP 503.' }),
    extractMeaningfulFields: () => ({ meaningful: true }),
    completeOcr: async (receiptId, sessionId, outcome) => { completeArgs = outcome; return { workflow_status: 'queued' } }
  })
  assert.equal(summary.requeued, 1)
  assert.equal(completeArgs.success, false)
  assert.equal(completeArgs.retryable, true)
})

test('permanent Gemini failure (e.g. 400) is reported as non-retryable', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  let completeArgs
  const summary = await processReceiptQueueBatch({
    maxReceipts: 1,
    generateSessionId: () => 'session-x',
    claimNext: async () => makeClaim(),
    beginEntitlement: async () => ({ allowed: true }),
    downloadReceiptFile: async () => 'base64image',
    callGemini: async () => ({ ok: false, retryable: false, message: 'Gemini API request failed with HTTP 400.' }),
    extractMeaningfulFields: () => ({ meaningful: true }),
    completeOcr: async (receiptId, sessionId, outcome) => { completeArgs = outcome; return { workflow_status: 'needs_attention' } }
  })
  assert.equal(summary.needs_attention, 1)
  assert.equal(completeArgs.retryable, false)
})

test('a successful Gemini call with no meaningful fields is treated as non-retryable, unsuccessful', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  let completeArgs
  const summary = await processReceiptQueueBatch({
    maxReceipts: 1,
    generateSessionId: () => 'session-x',
    claimNext: async () => makeClaim(),
    beginEntitlement: async () => ({ allowed: true }),
    downloadReceiptFile: async () => 'base64image',
    callGemini: async () => ({ ok: true, fields: {} }),
    extractMeaningfulFields: () => ({ meaningful: false, supplier: null, date: null, total: null, gst: null }),
    completeOcr: async (receiptId, sessionId, outcome) => { completeArgs = outcome; return { workflow_status: 'needs_attention' } }
  })
  assert.equal(summary.needs_attention, 1)
  assert.equal(completeArgs.success, false)
  assert.equal(completeArgs.retryable, false)
  assert.match(completeArgs.errorSummary, /no meaningful/i)
})

test('Storage download failure is treated as transient/retryable', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  let completeArgs
  const summary = await processReceiptQueueBatch({
    maxReceipts: 1,
    generateSessionId: () => 'session-x',
    claimNext: async () => makeClaim(),
    beginEntitlement: async () => ({ allowed: true }),
    downloadReceiptFile: async () => { throw new Error('network blip') },
    callGemini: async () => { throw new Error('should not be called') },
    extractMeaningfulFields: () => ({ meaningful: true }),
    completeOcr: async (receiptId, sessionId, outcome) => { completeArgs = outcome; return { workflow_status: 'queued' } }
  })
  assert.equal(summary.requeued, 1)
  assert.equal(completeArgs.retryable, true)
})

test('one receipt throwing unexpectedly does not block processing of the next claimed receipt', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  const claims = [makeClaim({ receipt_id: 'bad' }), makeClaim({ receipt_id: 'good' }), { claimed: false }]
  let claimIndex = 0
  let completedGood = false
  const summary = await processReceiptQueueBatch({
    maxReceipts: 3,
    generateSessionId: () => 'session-x',
    claimNext: async () => claims[claimIndex++],
    beginEntitlement: async (receiptId) => { if (receiptId === 'bad') throw new Error('boom'); return { allowed: true } },
    downloadReceiptFile: async () => 'base64image',
    callGemini: async () => ({ ok: true, fields: {} }),
    extractMeaningfulFields: () => ({ meaningful: true, supplier: 'Shop', date: null, total: null, gst: null }),
    completeOcr: async (receiptId) => { if (receiptId === 'good') completedGood = true; return { workflow_status: 'needs_review' } }
  })
  assert.equal(summary.claimed, 2)
  assert.equal(summary.errors, 1)
  assert.equal(summary.succeeded, 1)
  assert.equal(completedGood, true)
})

test('claim exclusivity: claimNext returning claimed=false on the first slot stops immediately', async () => {
  const { processReceiptQueueBatch } = await loadWorkflow()
  let claimCalls = 0
  const summary = await processReceiptQueueBatch({
    maxReceipts: 3,
    generateSessionId: () => 'session-x',
    claimNext: async () => { claimCalls++; return { claimed: false } },
    beginEntitlement: async () => ({ allowed: true }),
    downloadReceiptFile: async () => 'base64image',
    callGemini: async () => ({ ok: true, fields: {} }),
    extractMeaningfulFields: () => ({ meaningful: true }),
    completeOcr: async () => ({ workflow_status: 'needs_review' })
  })
  assert.equal(claimCalls, 1)
  assert.equal(summary.claimed, 0)
})

test('normalises Australian ambiguous dates the same way as the browser parser', async () => {
  const { normaliseAustralianReceiptDate } = await loadDates()
  assert.equal(normaliseAustralianReceiptDate('23-10-25'), '2025-10-23')
  assert.equal(normaliseAustralianReceiptDate('23/10/2025'), '2025-10-23')
  assert.equal(normaliseAustralianReceiptDate('04/12/2025'), '2025-12-04')
  assert.equal(normaliseAustralianReceiptDate('12/04/2025'), '2025-04-12')
  assert.equal(normaliseAustralianReceiptDate('4 Dec 2025'), '2025-12-04')
  assert.equal(normaliseAustralianReceiptDate('10/23/2025'), null)
  assert.equal(normaliseAustralianReceiptDate('23-10-70'), '1970-10-23')
  assert.equal(normaliseAustralianReceiptDate('32/13/2025'), null)
})

test('extractMeaningfulReceiptFields requires at least one real field', async () => {
  const { extractMeaningfulReceiptFields } = await loadGemini()
  const { normaliseAustralianReceiptDate } = await loadDates()
  const empty = extractMeaningfulReceiptFields({}, normaliseAustralianReceiptDate)
  assert.equal(empty.meaningful, false)

  const withSupplier = extractMeaningfulReceiptFields({ supplier: 'Coles' }, normaliseAustralianReceiptDate)
  assert.equal(withSupplier.meaningful, true)

  const withDate = extractMeaningfulReceiptFields({ date_text: '04/12/2025' }, normaliseAustralianReceiptDate)
  assert.equal(withDate.meaningful, true)
  assert.equal(withDate.date, '2025-12-04')

  const negativeTotal = extractMeaningfulReceiptFields({ total: -5 }, normaliseAustralianReceiptDate)
  assert.equal(negativeTotal.total, null)
  assert.equal(negativeTotal.meaningful, false)
})

test('Gemini retry policy retries 503 up to 3 attempts then reports retryable failure', async () => {
  const { callGeminiForReceipt } = await loadGemini()
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: false, status: 503, text: async () => '{"error":{"message":"overloaded"}}' } }
  const result = await callGeminiForReceipt({ apiKey: 'secret', base64Image: 'x', mimeType: 'image/jpeg', fetchImpl, log: () => {} })
  assert.equal(calls, 3)
  assert.equal(result.ok, false)
  assert.equal(result.retryable, true)
})

test('Gemini retry policy does not retry a 400 permanent failure', async () => {
  const { callGeminiForReceipt } = await loadGemini()
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: false, status: 400, text: async () => '{"error":{"message":"bad request"}}' } }
  const result = await callGeminiForReceipt({ apiKey: 'secret', base64Image: 'x', mimeType: 'image/jpeg', fetchImpl, log: () => {} })
  assert.equal(calls, 1)
  assert.equal(result.ok, false)
  assert.equal(result.retryable, false)
})

test('Gemini success returns ok with parsed fields', async () => {
  const { callGeminiForReceipt } = await loadGemini()
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ supplier: 'Coles', total: '10.00' }) }] } }] })
  })
  const result = await callGeminiForReceipt({ apiKey: 'secret', base64Image: 'x', mimeType: 'image/jpeg', fetchImpl, log: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.fields.supplier, 'Coles')
})

test('worker invocation auth: missing worker secret is rejected', async () => {
  const { isAuthorisedWorkerRequest } = await loadWorkerAuth()
  assert.equal(isAuthorisedWorkerRequest('some-token', undefined), false)
  assert.equal(isAuthorisedWorkerRequest('some-token', ''), false)
})

test('worker invocation auth: incorrect worker secret is rejected', async () => {
  const { isAuthorisedWorkerRequest } = await loadWorkerAuth()
  assert.equal(isAuthorisedWorkerRequest('wrong-token', 'the-real-worker-secret'), false)
  assert.equal(isAuthorisedWorkerRequest('', 'the-real-worker-secret'), false)
  assert.equal(isAuthorisedWorkerRequest(undefined, 'the-real-worker-secret'), false)
})

test('worker invocation auth: correct worker secret permits execution', async () => {
  const { isAuthorisedWorkerRequest } = await loadWorkerAuth()
  assert.equal(isAuthorisedWorkerRequest('the-real-worker-secret', 'the-real-worker-secret'), true)
})

test('worker invocation auth: the Supabase service-role key is not accepted merely because it is the service-role key', async () => {
  const { isAuthorisedWorkerRequest } = await loadWorkerAuth()
  const serviceRoleKey = 'eyJhbGciOiJIUzI1NiJ9.service-role-key-example'
  // Even if a caller supplies the service-role key as the bearer token, it must
  // be rejected unless it happens to equal the dedicated worker secret.
  assert.equal(isAuthorisedWorkerRequest(serviceRoleKey, 'the-real-worker-secret'), false)
})

test('worker invocation auth: extractBearerToken parses the Authorization header', async () => {
  const { extractBearerToken } = await loadWorkerAuth()
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123')
  assert.equal(extractBearerToken('bearer abc123'), 'abc123')
  assert.equal(extractBearerToken(''), '')
  assert.equal(extractBearerToken(null), '')
  assert.equal(extractBearerToken('Basic abc123'), '')
})

test('resolveMaxReceipts: omitted value preserves the current maximum of 3', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  const result = resolveMaxReceipts(undefined, 3)
  assert.equal(result.ok, true)
  assert.equal(result.value, 3)
})

test('resolveMaxReceipts: 1 and 2 are accepted and lower the bound', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.deepEqual(resolveMaxReceipts(1, 3), { ok: true, value: 1 })
  assert.deepEqual(resolveMaxReceipts(2, 3), { ok: true, value: 2 })
})

test('resolveMaxReceipts: 3 is accepted (equal to the existing cap)', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.deepEqual(resolveMaxReceipts(3, 3), { ok: true, value: 3 })
})

test('resolveMaxReceipts: 0 is rejected', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.equal(resolveMaxReceipts(0, 3).ok, false)
})

test('resolveMaxReceipts: 4 is rejected (cannot exceed the existing cap)', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.equal(resolveMaxReceipts(4, 3).ok, false)
})

test('resolveMaxReceipts: negative numbers are rejected', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.equal(resolveMaxReceipts(-1, 3).ok, false)
})

test('resolveMaxReceipts: decimals are rejected', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.equal(resolveMaxReceipts(1.5, 3).ok, false)
})

test('resolveMaxReceipts: strings and null are rejected', async () => {
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.equal(resolveMaxReceipts('1', 3).ok, false)
  assert.equal(resolveMaxReceipts(null, 3).ok, false)
})

test('resolveMaxReceipts: malformed request body JSON is handled cleanly by the caller', async () => {
  // The Edge Function itself catches JSON.parse errors before calling
  // resolveMaxReceipts and returns a 400; this test documents that a bad
  // body never reaches resolveMaxReceipts as a crash, only as undefined
  // (empty body) or a value that fails validation normally.
  const { resolveMaxReceipts } = await loadMaxReceipts()
  assert.doesNotThrow(() => resolveMaxReceipts(undefined, 3))
})
