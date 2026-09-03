// Focused Gemini receipt-scan client for the background OCR worker.
// Deliberately mirrors the proven retry policy and Australian receipt
// prompt already used by handleScanReceipt() in server.js and
// scanReceiptWithGemini() in index.html, adapted for direct calls to the
// Gemini REST API (the Edge Function has no access to the Node server).
//
// Retry policy (unchanged from the existing working policy):
//   - retry HTTP 429/500/502/503/504
//   - do NOT retry 400/401/403 (permanent input/auth problems)
//   - maximum 3 attempts, backoff ~0s/1s/2s
//
// This is a SEPARATE, short-lived in-invocation retry loop from the
// durable receipt-level retry (scan_attempts/queued). A receipt that
// exhausts these 3 Gemini attempts is reported to the caller as a
// transient/retryable failure so the durable retry can pick it up later.

const MAX_ATTEMPTS = 3
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])
const BACKOFF_MS = [0, 1000, 2000]

const RECEIPT_PROMPT = `Analyze this receipt image and extract the key receipt information into JSON format with the following keys:
  - supplier: store/merchant name
  - date: purchase date in YYYY-MM-DD format
  - date_text: date text exactly as it appears on the receipt
  - total: numeric total amount paid
  - gst: numeric GST/tax amount (if indicated)
  This receipt is processed for an Australian user. Interpret ambiguous numeric dates as DD/MM/YYYY unless the receipt clearly indicates otherwise.`

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

// fetchImpl is injected so tests can run without real network access.
export async function callGeminiForReceipt({ apiKey, base64Image, mimeType, fetchImpl = fetch, log = () => {} }) {
  const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
  const payload = {
    contents: [{ parts: [{ text: RECEIPT_PROMPT }, { inlineData: { mimeType, data: base64Image } }] }],
    generationConfig: { responseMimeType: 'application/json' }
  }

  let upstream, text, body
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await sleep(BACKOFF_MS[attempt - 1])
    upstream = await fetchImpl(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload)
    })
    text = await upstream.text()
    try { body = JSON.parse(text) } catch { body = { error: { message: text || `Gemini API returned HTTP ${upstream.status}.` } } }

    if (upstream.ok) break
    const isRetryable = RETRYABLE_STATUS_CODES.has(upstream.status)
    if (!isRetryable || attempt === MAX_ATTEMPTS) break
    log(`Gemini temporary failure (${upstream.status}), retrying attempt ${attempt + 1} of ${MAX_ATTEMPTS}`)
  }

  if (!upstream.ok) {
    return { ok: false, status: upstream.status, retryable: RETRYABLE_STATUS_CODES.has(upstream.status), message: body?.error?.message || `Gemini API request failed with HTTP ${upstream.status}.` }
  }

  const responseText = body.candidates?.[0]?.content?.parts?.[0]?.text
  if (!responseText) return { ok: false, status: upstream.status, retryable: false, message: 'Gemini API returned no receipt data.' }

  let fields
  try { fields = JSON.parse(responseText) } catch { return { ok: false, status: upstream.status, retryable: false, message: 'Gemini API returned unparsable receipt data.' } }

  return { ok: true, fields }
}

// A "meaningful" result must contain at least one plausible, distinct
// receipt field. This mirrors the browser's existing rule (readReceiptWithGemini
// treats a scan as meaningful only if at least one of supplier/date/total/GST
// was actually filled in) rather than accepting any syntactically valid JSON.
export function extractMeaningfulReceiptFields(fields, normaliseDate) {
  const supplier = typeof fields?.supplier === 'string' && fields.supplier.trim() ? fields.supplier.trim() : null
  const date = normaliseDate(fields?.date_text || fields?.date) || (String(fields?.date || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || null)
  const total = Number(fields?.total)
  const gst = Number(fields?.gst)
  const result = {
    supplier,
    date,
    total: Number.isFinite(total) && total >= 0 ? total : null,
    gst: Number.isFinite(gst) && gst >= 0 ? gst : null
  }
  const meaningful = Boolean(result.supplier || result.date || result.total !== null || result.gst !== null)
  return { ...result, meaningful }
}
