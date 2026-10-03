const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const modulePath = path.join(__dirname,'..','supabase','functions','_shared','appleSubscription.mjs')

test('verified Apple transaction becomes an active server entitlement', async () => {
  const { subscriptionRecord, assertTransactionOwner } = await import(modulePath)
  const now=Date.parse('2026-10-03T00:00:00Z')
  const record=subscriptionRecord({
    productId:'com.receiptgo.pro.monthly',bundleId:'au.com.receiptbox.app',
    appAccountToken:'11111111-1111-4111-8111-111111111111',originalTransactionId:'100',transactionId:'101',
    environment:'Sandbox',purchaseDate:now-1000,expiresDate:now+86400000,
  },{},null,now)
  assert.equal(record.status,'active')
  assert.equal(record.grace_period_expires_at,null)
  assert.equal(record.revoked_at,null)
  assert.equal(assertTransactionOwner(record,'11111111-1111-4111-8111-111111111111'),record)
})

test('expired, revoked, billing retry and grace period states do not overgrant Pro', async () => {
  const { subscriptionRecord } = await import(modulePath)
  const now=Date.parse('2026-10-03T00:00:00Z')
  const base={productId:'com.receiptgo.pro.monthly',bundleId:'au.com.receiptbox.app',appAccountToken:'11111111-1111-4111-8111-111111111111',originalTransactionId:'100',transactionId:'101',environment:'Production',purchaseDate:now-100000}
  assert.equal(subscriptionRecord({...base,expiresDate:now-1},{},null,now).status,'expired')
  assert.equal(subscriptionRecord({...base,expiresDate:now+1000,revocationDate:now-1},{},null,now).status,'revoked')
  assert.equal(subscriptionRecord({...base,expiresDate:now-1},{isInBillingRetryPeriod:true},null,now).status,'billing_retry')
  assert.equal(subscriptionRecord({...base,expiresDate:now-1},{gracePeriodExpiresDate:now+1000},null,now).status,'grace_period')
})

test('newer signed renewal state wins the server ordering timestamp', async () => {
  const { subscriptionRecord } = await import(modulePath)
  const now=Date.parse('2026-10-03T00:00:00Z')
  const record=subscriptionRecord({
    productId:'com.receiptgo.pro.monthly',bundleId:'au.com.receiptbox.app',
    appAccountToken:'11111111-1111-4111-8111-111111111111',originalTransactionId:'100',transactionId:'101',
    environment:'Sandbox',expiresDate:now-1,signedDate:now-2000,
  },{isInBillingRetryPeriod:true,signedDate:now-1000},'DID_FAIL_TO_RENEW',now)
  assert.equal(record.status,'billing_retry')
  assert.equal(record.last_signed_at,new Date(now-1000).toISOString())
})

test('Apple verification rejects another ReceiptGo account and unsupported products', async () => {
  const { subscriptionRecord, assertTransactionOwner } = await import(modulePath)
  const now=Date.now(),transaction={productId:'com.receiptgo.pro.monthly',bundleId:'au.com.receiptbox.app',appAccountToken:'11111111-1111-4111-8111-111111111111',originalTransactionId:'100',transactionId:'101',environment:'Sandbox',expiresDate:now+10000}
  const record=subscriptionRecord(transaction,{},null,now)
  assert.throws(()=>assertTransactionOwner(record,'22222222-2222-4222-8222-222222222222'),/transaction_account_mismatch/)
  assert.throws(()=>subscriptionRecord({...transaction,productId:'other.product'}, {}, null, now),/unsupported_product/)
})

test('native StoreKit bridge and server endpoints contain required security boundaries', () => {
  const root=path.join(__dirname,'..')
  const swift=fs.readFileSync(path.join(root,'ios','App','App','ReceiptGoStoreKitPlugin.swift'),'utf8')
  const verify=fs.readFileSync(path.join(root,'supabase','functions','verify-apple-subscription','index.ts'),'utf8')
  const notifications=fs.readFileSync(path.join(root,'supabase','functions','apple-subscription-notifications','index.ts'),'utf8')
  assert.match(swift,/Product\.products\(for: supportedProductIds\)/)
  assert.match(swift,/\.appAccountToken\(token\)/)
  assert.match(swift,/Transaction\.currentEntitlements/)
  assert.match(swift,/AppStore\.sync\(\)/)
  assert.match(swift,/AppStore\.showManageSubscriptions/)
  assert.match(verify,/authenticated\.auth\.getUser\(\)/)
  assert.match(verify,/assertTransactionOwner/)
  assert.match(notifications,/verifyNotification/)
  assert.doesNotMatch(verify+notifications,/PRIVATE KEY|BEGIN PRIVATE|service_role[^\n]*['"][A-Za-z0-9]/i)
})
