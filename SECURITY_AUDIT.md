# Receipt Box Supabase security audit

Audit date: 18 August 2026  
Remediation verification: 18 August 2026
Supabase project: `fvrtmoolruetqjxhrfvq` (`Receipt Box Project`)

## Outcome

Receipt records and receipt files are currently isolated by authenticated owner.

- Row Level Security is enabled on `public.receipts`.
- Anonymous users have no table privileges on `public.receipts`.
- Authenticated users have exactly `SELECT`, `INSERT`, `UPDATE`, and `DELETE` privileges.
- All four receipt policies explicitly target `authenticated` and compare `(select auth.uid())` with `receipts.user_id`.
- The `UPDATE` policy has explicit ownership checks for both the existing and resulting row, so an owner cannot transfer a row to another user.
- `receipts.user_id` is `NOT NULL` and retains its foreign key to `auth.users(id)`.
- The `receipts` Storage bucket is private.
- Storage `SELECT`, `INSERT`, and `DELETE` policies explicitly target `authenticated`, restrict access to the `receipts` bucket, and require the first object-path segment to equal `auth.uid()`. Reads and deletes also require the Storage object owner to match.
- Receipt uploads are restricted to `image/*` and `application/pdf`, with a 10 MB maximum file size.
- The browser contains a Supabase publishable key, not a service-role or secret key.
- There are no public-schema views that could bypass the table's RLS policies.
- CSV exports neutralize formula-like values beginning with `=`, `+`, `-`, or `@`.
- All four CDN dependencies are pinned to exact versions and protected with SHA-384 Subresource Integrity plus anonymous CORS mode.

Live aggregate verification found:

- 4 receipt rows; 0 rows without `user_id`.
- 3 stored receipt objects; 0 objects without an owner.
- 0 receipt paths outside their owner's folder.
- 0 receipt-to-object owner mismatches.
- 0 receipt file references missing from Storage.

## Remediation status

Resolved:

- Removed every `anon` privilege from `public.receipts`, including `TRUNCATE`.
- Reduced `authenticated` privileges to receipt CRUD only.
- Recreated receipt and Storage ownership policies with `TO authenticated`.
- Added an explicit `WITH CHECK` to receipt updates.
- Verified all existing receipt rows had owners, then asserted `user_id NOT NULL` in the applied migration. The column was already non-null in production at preflight and remains so.
- Added private-bucket upload restrictions: images/PDF only, maximum 10 MB.
- Neutralized CSV spreadsheet formulas while retaining the original database values and on-screen text.
- Pinned Tesseract `5.1.1`, Supabase JS `2.112.3`, jsPDF `2.5.2`, and jsPDF-AutoTable `3.8.4`; added SHA-384 integrity and `crossorigin="anonymous"` to each script.

Remaining recommendations:

- **Leaked-password protection:** the project is on Supabase Free, so this setting was not enabled. Treat it as a production-plan upgrade recommendation. See [Supabase password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- **Content Security Policy:** SRI now protects the external scripts, but the single-file application still uses inline CSS, inline JavaScript, and inline event handlers. A strict CSP should be introduced alongside the later asset split/refactor rather than weakening or breaking the current application.
- **Dependency updates:** exact pins intentionally stop automatic upgrades. Review new versions deliberately, recompute SRI hashes, run the full suite, and test the deployed login/OCR/PDF flows before updating.
- **Performance follow-up:** the post-migration performance advisor reports pre-existing unindexed foreign keys and unoptimized `auth.uid()` calls on the separate `entities`, `categories`, and `projects` policies. These do not weaken receipt ownership and were left outside this security remediation.

## Functionality-sensitive notes

- Storage has no `UPDATE` policy. The current frontend uploads unique object names and does not use overwrite/upsert, so this does not break existing behavior and is not an ownership gap.
- The frontend deletes a Storage object before deleting its receipt row. Both operations are owner-scoped, but they are not transactional; a failed second operation can leave an orphaned row or file. This is a consistency concern, not a cross-user access issue.
- Receipt and report HTML interpolations pass user-controlled strings through the existing `esc()` function. Receipt identifiers used by inline handlers are UUID database values, so no direct stored-XSS path was found in the inspected rendering code.
- Signed receipt URLs expire after 300 seconds. Opening them with `noopener` would be a sensible additional browser hardening measure.
- Production changes are recorded in `supabase/migrations/20260818005236_harden_receipt_ownership_and_uploads.sql` and in Supabase migration history as `harden_receipt_ownership_and_uploads`.

## Post-remediation verification

- RLS remains enabled on `public.receipts`.
- `anon` grants: none.
- `authenticated` grants: `SELECT`, `INSERT`, `UPDATE`, `DELETE` only.
- Receipt and Storage policies: `authenticated` only with owner checks.
- `receipts.user_id`: not nullable; 0 ownerless rows.
- Storage bucket: private; 10,485,760-byte limit; `image/*` and `application/pdf` only.
- Existing data: 4 receipts, 0 missing objects, 0 path mismatches, 0 owner mismatches.
- Supabase security advisor: only leaked-password protection disabled, retained as a Free-plan upgrade recommendation.
- Automated tests: 10 passed, 0 failed.

## Authoritative references

- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase Storage ownership](https://supabase.com/docs/guides/storage/security/ownership)
- [Supabase product security](https://supabase.com/docs/guides/security/product-security)
