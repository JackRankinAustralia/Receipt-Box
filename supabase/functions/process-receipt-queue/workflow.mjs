// Bounded background OCR queue processor. Pure orchestration: all I/O
// (claiming, entitlement, Storage download, Gemini, completion) is
// injected so this can be tested without any real network/Supabase/Gemini
// access, mirroring the existing supabase/functions/delete-account/workflow.mjs
// pattern used elsewhere in this repo.
//
// Each invocation processes at most maxReceipts receipts, sequentially.
// A failure on one receipt must not prevent attempting the next receipt.

export async function processReceiptQueueBatch({
  maxReceipts = 3,
  generateSessionId,
  claimNext,
  beginEntitlement,
  downloadReceiptFile,
  callGemini,
  extractMeaningfulFields,
  completeOcr,
  log = () => {}
}) {
  const summary = { claimed: 0, succeeded: 0, requeued: 0, needs_attention: 0, quota_exhausted: 0, errors: 0 }

  for (let slot = 0; slot < maxReceipts; slot++) {
    const sessionId = generateSessionId()
    const claim = await claimNext(sessionId)
    if (!claim?.claimed) break
    summary.claimed++

    try {
      await processOneReceipt({ claim, beginEntitlement, downloadReceiptFile, callGemini, extractMeaningfulFields, completeOcr, log, summary })
    } catch (error) {
      // A single receipt's unexpected failure must not stop the batch.
      log(`Unexpected worker error for receipt ${claim.receipt_id}: ${error instanceof Error ? error.message : 'unknown error'}`)
      summary.errors++
    }
  }

  return summary
}

async function processOneReceipt({ claim, beginEntitlement, downloadReceiptFile, callGemini, extractMeaningfulFields, completeOcr, log, summary }) {
  const { receipt_id: receiptId, scan_session_id: scanSessionId, file_path: filePath, mime_type: mimeType } = claim

  const entitlement = await beginEntitlement(receiptId)
  if (!entitlement?.allowed) {
    const outcome = await completeOcr(receiptId, scanSessionId, { success: false, errorSummary: 'Monthly OCR limit reached.', retryable: false })
    tally(summary, outcome, { forceQuotaExhausted: true })
    return
  }

  let base64Image
  try {
    base64Image = await downloadReceiptFile(filePath)
  } catch (error) {
    log(`Storage download failed for receipt ${receiptId}: ${error instanceof Error ? error.message : 'unknown error'}`)
    const outcome = await completeOcr(receiptId, scanSessionId, { success: false, errorSummary: 'Could not download the stored receipt image.', retryable: true })
    tally(summary, outcome)
    return
  }

  const geminiResult = await callGemini({ base64Image, mimeType })
  if (!geminiResult.ok) {
    const outcome = await completeOcr(receiptId, scanSessionId, { success: false, errorSummary: safeErrorSummary(geminiResult.message), retryable: Boolean(geminiResult.retryable) })
    tally(summary, outcome)
    return
  }

  const fields = extractMeaningfulFields(geminiResult.fields)
  if (!fields.meaningful) {
    const outcome = await completeOcr(receiptId, scanSessionId, { success: false, errorSummary: 'No meaningful receipt fields could be read from this image.', retryable: false })
    tally(summary, outcome)
    return
  }

  const outcome = await completeOcr(receiptId, scanSessionId, {
    success: true,
    supplier: fields.supplier,
    receiptDate: fields.date,
    total: fields.total,
    gst: fields.gst
  })
  tally(summary, outcome)
}

function tally(summary, outcome, { forceQuotaExhausted = false } = {}) {
  if (forceQuotaExhausted) { summary.quota_exhausted++; return }
  const status = outcome?.workflow_status
  if (status === 'needs_review') summary.succeeded++
  else if (status === 'queued') summary.requeued++
  else if (status === 'needs_attention') summary.needs_attention++
  else summary.errors++
}

// Keeps only a short, safe-to-display reason; never echoes raw upstream
// bodies (which could contain request-identifying details) into the
// database or the invocation response.
function safeErrorSummary(message) {
  const text = String(message || 'Receipt processing failed.').slice(0, 200)
  return text
}
