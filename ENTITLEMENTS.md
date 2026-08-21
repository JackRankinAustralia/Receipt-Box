# Receipt Box Free/Pro entitlement foundation

The database is authoritative for plans, feature capabilities, and monthly OCR admission. The browser reads these decisions through `get_my_entitlement()`, starts an OCR reservation with `begin_ocr_scan()`, and reports the outcome with `complete_ocr_scan()`.

## What counts as a Free OCR scan

A newly selected receipt photo creates one opaque OCR session ID. The session consumes one scan only after the OCR pipeline completes and presents at least one meaningful receipt field: Supplier, Date, Total, or GST. A technical failure or a result with none of those fields marks the reservation failed and does not consume quota. Reruns for the same selected receipt reuse the session ID, so a session that has already succeeded is not counted twice.

The monthly boundary is the first day of each calendar month in UTC. `begin_ocr_scan()` serialises admissions per user with a transaction-scoped advisory lock and counts both pending reservations and completed scans. This prevents concurrent tabs from collectively passing the 25-scan Free limit.

## Trust boundary

OCR remains client-side. The server can authenticate the caller and atomically enforce reservations, but it cannot cryptographically prove that the browser genuinely completed OCR or that the reported fields came from the selected receipt. A modified client could falsely report success or failure. This is an accepted limitation for this milestone; stronger attestation would require moving OCR or result verification to a trusted server.

## Feature decisions and testing

The frontend uses one `entitlementService` for capability checks. It has no plan mutation method. Database triggers independently enforce the Free limits for Entities, Projects, and custom Categories, so bypassing the UI does not bypass the plan.

Tests may inject an entitlement fixture through the Node VM harness in `tests/load-app.js`. That hook is not included in `index.html`, is not driven by query parameters or browser storage, and cannot change production database entitlements. Production plan changes are reserved for future trusted billing/server processes; the current Pro screen is informational only.

Existing Entities, Categories, and Projects are marked as grandfathered by the migration. They remain visible and usable even if a Free account is already above a new-plan limit. The restrictions apply to creating new active records or renaming a Category to a non-standard value; the migration does not delete or rewrite historical receipt assignments.
