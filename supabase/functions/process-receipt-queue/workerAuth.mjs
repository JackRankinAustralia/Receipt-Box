// Pure invocation-authentication check for the background OCR worker
// Edge Function, kept separate from index.ts so it can be unit tested
// without Deno. This intentionally checks a DEDICATED worker secret
// (RECEIPT_QUEUE_WORKER_SECRET), not the Supabase service-role key: the
// service-role key must remain purely internal, used only to construct
// the privileged Supabase client for RPC/Storage calls, and must never be
// accepted as an externally supplied invocation credential.
export function isAuthorisedWorkerRequest(providedToken, expectedSecret) {
  if (!expectedSecret) return false
  if (!providedToken) return false
  return providedToken === expectedSecret
}

export function extractBearerToken(authorizationHeader) {
  const value = String(authorizationHeader || '').trim()
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}
