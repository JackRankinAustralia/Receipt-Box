// Pure validator for the optional per-invocation maxReceipts override, kept
// separate from index.ts so it can be unit tested without Deno.
//
// Valid values are integers 1..upperBound inclusive. A request can only
// lower the bound (for controlled manual testing), never raise it above the
// existing MAX_RECEIPTS_PER_INVOCATION cap.
export function resolveMaxReceipts(requestedValue, upperBound) {
  if (requestedValue === undefined) return { ok: true, value: upperBound }
  if (typeof requestedValue !== 'number' || !Number.isInteger(requestedValue)) {
    return { ok: false, error: `maxReceipts must be an integer between 1 and ${upperBound}.` }
  }
  if (requestedValue < 1 || requestedValue > upperBound) {
    return { ok: false, error: `maxReceipts must be an integer between 1 and ${upperBound}.` }
  }
  return { ok: true, value: requestedValue }
}
