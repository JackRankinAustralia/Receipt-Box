export const APPLE_MONTHLY_PRODUCT_ID = 'com.receiptgo.pro.monthly'
export const APPLE_BUNDLE_ID = 'au.com.receiptbox.app'

const asDate = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? new Date(Number(value)).toISOString()
  : null

export function subscriptionRecord(transaction, renewal = {}, notificationType = null, now = Date.now()) {
  if (!transaction || transaction.productId !== APPLE_MONTHLY_PRODUCT_ID) throw new Error('unsupported_product')
  if (transaction.bundleId !== APPLE_BUNDLE_ID) throw new Error('invalid_bundle')
  if (!transaction.appAccountToken) throw new Error('missing_app_account_token')
  if (!transaction.originalTransactionId || !transaction.transactionId) throw new Error('missing_transaction_identity')

  const expiresMs = Number(transaction.expiresDate)
  const graceMs = Number(renewal.gracePeriodExpiresDate)
  const revokedMs = Number(transaction.revocationDate)
  const effectiveExpiry = Number.isFinite(graceMs) ? graceMs : expiresMs
  let status = 'expired'
  if (Number.isFinite(revokedMs)) status = 'revoked'
  else if (Number.isFinite(graceMs) && graceMs > now) status = 'grace_period'
  else if (Number.isFinite(expiresMs) && expiresMs > now) status = 'active'
  else if (renewal.isInBillingRetryPeriod === true) status = 'billing_retry'

  return {
    original_transaction_id: String(transaction.originalTransactionId),
    user_id: String(transaction.appAccountToken),
    app_account_token: String(transaction.appAccountToken),
    product_id: transaction.productId,
    transaction_id: String(transaction.transactionId),
    environment: transaction.environment,
    status,
    purchased_at: asDate(transaction.purchaseDate),
    expires_at: asDate(transaction.expiresDate),
    grace_period_expires_at: asDate(renewal.gracePeriodExpiresDate),
    revoked_at: asDate(transaction.revocationDate),
    last_notification_type: notificationType,
    last_signed_at: asDate(Math.max(Number(transaction.signedDate) || 0, Number(renewal.signedDate) || 0) || now),
    last_verified_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  }
}

export function assertTransactionOwner(record, userId) {
  if (!userId || record.user_id !== userId) throw new Error('transaction_account_mismatch')
  return record
}

export async function storeSubscription(admin, record) {
  const { error } = await admin.rpc('upsert_apple_subscription', { subscription: record })
  if (error) throw new Error('subscription_store_failed')
  return record
}

export function safeSubscriptionResponse(record) {
  return {
    productId: record.product_id,
    status: record.status,
    expiresAt: record.expires_at,
    active: ['active', 'grace_period'].includes(record.status),
  }
}
