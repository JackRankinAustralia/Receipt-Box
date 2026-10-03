# ReceiptGo Free/Pro entitlement foundation

The database is authoritative for plans, feature capabilities, and monthly OCR admission. The browser reads these decisions through `get_my_entitlement()`, starts an OCR reservation with `begin_ocr_scan()`, and reports the outcome with `complete_ocr_scan()`.

## What counts as a Free OCR scan

A newly selected receipt photo creates one opaque OCR session ID. The session consumes one scan only after the OCR pipeline completes and presents at least one meaningful receipt field: Supplier, Date, Total, or GST. A technical failure or a result with none of those fields marks the reservation failed and does not consume quota. Reruns for the same selected receipt reuse the session ID, so a session that has already succeeded is not counted twice.

The monthly boundary is the first day of each calendar month in UTC. `begin_ocr_scan()` serialises admissions per user with a transaction-scoped advisory lock and counts both pending reservations and completed scans. This prevents concurrent tabs from collectively passing the 10-scan Free limit.

## Trust boundary

OCR remains client-side. The server can authenticate the caller and atomically enforce reservations, but it cannot cryptographically prove that the browser genuinely completed OCR or that the reported fields came from the selected receipt. A modified client could falsely report success or failure. This is an accepted limitation for this milestone; stronger attestation would require moving OCR or result verification to a trusted server.

## Feature decisions and testing

The frontend uses one `entitlementService` for capability checks. It has no plan mutation method. Database triggers independently enforce the Free limits for Entities, Projects, and custom Categories, so bypassing the UI does not bypass the plan.

Tests may inject an entitlement fixture through the Node VM harness in `tests/load-app.js`. That hook is not included in `index.html`, is not driven by query parameters or browser storage, and cannot change production database entitlements.

Existing Entities, Categories, and Projects are marked as grandfathered by the migration. They remain visible and usable even if a Free account is already above a new-plan limit. The restrictions apply to creating new active records or renaming a Category to a non-standard value; the migration does not delete or rewrite historical receipt assignments.

## Apple subscriptions

ReceiptGo Pro Monthly uses the permanent App Store product identifier `com.receiptgo.pro.monthly`. StoreKit supplies the localised price and performs purchase, restore, current-entitlement and subscription-management operations in the iOS app.

An Apple transaction does not grant Pro locally. The app assigns the signed-in Supabase user UUID as StoreKit's `appAccountToken` and sends Apple's signed transaction to the authenticated `verify-apple-subscription` Edge Function. That function verifies Apple's certificate chain and signed payload, checks the bundle/product/account identity, and writes `apple_subscriptions` with the service role. The client finishes the StoreKit transaction only after the server accepts it.

App Store Server Notifications V2 call the public `apple-subscription-notifications` Edge Function. The endpoint has no Supabase JWT because Apple cannot provide one; it accepts state only after verifying Apple's signed notification and nested transaction/renewal payloads. Renewal, expiration, billing retry, grace-period and revocation state is therefore maintained without trusting the app.

Effective Pro is the logical OR of:

- an active, unexpired legacy/manual row in `user_entitlements`; and
- an active or grace-period Apple row whose effective expiry is still in the future.

Apple expiration or revocation never removes an independent manual/admin grant.

### Production configuration

Before enabling purchase testing:

1. Apply `20261003120000_add_apple_subscription_entitlements.sql`.
2. Set the Edge Function secret `APPLE_APP_ID` to the app's numeric Apple ID from App Store Connect. `APPLE_BUNDLE_ID` defaults to `au.com.receiptbox.app` and may be set explicitly to the same value.
3. Deploy only `verify-apple-subscription` and `apple-subscription-notifications`.
4. In App Store Connect, set both Production and Sandbox App Store Server Notifications V2 URLs to `https://fvrtmoolruetqjxhrfvq.supabase.co/functions/v1/apple-subscription-notifications` and send Apple's test notification.
5. Complete the subscription's localisation, review screenshot and required agreements/tax/banking setup.

Never store an App Store Connect private key, issuer ID, Apple Account credential or Supabase service-role key in the app or repository. This implementation verifies device transactions and signed notifications and therefore does not require an App Store Server API private key.
