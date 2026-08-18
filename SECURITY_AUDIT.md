# Receipt Box Supabase security audit

Audit date: 18 August 2026  
Supabase project: `fvrtmoolruetqjxhrfvq` (`Receipt Box Project`)

## Outcome

Receipt records and receipt files are currently isolated by authenticated owner.

- Row Level Security is enabled on `public.receipts`.
- `SELECT`, `INSERT`, `UPDATE`, and `DELETE` policies compare `auth.uid()` with `receipts.user_id`.
- The `UPDATE` policy has a `USING` expression and no separately displayed `WITH CHECK`. PostgreSQL reuses `USING` as `WITH CHECK` when the latter is omitted, so an owner cannot transfer a row to another user.
- The `receipts` Storage bucket is private.
- Storage `SELECT`, `INSERT`, and `DELETE` policies require the first object-path segment to equal `auth.uid()` and restrict access to the `receipts` bucket.
- The browser contains a Supabase publishable key, not a service-role or secret key.
- There are no public-schema views that could bypass the table's RLS policies.

Live aggregate verification found:

- 4 receipt rows; 0 rows without `user_id`.
- 3 stored receipt objects; 0 objects without an owner.
- 0 receipt paths outside their owner's folder.
- 0 receipt-to-object owner mismatches.
- 0 receipt file references missing from Storage.

## Hardening findings

### 1. `anon` has broader table grants than the frontend needs

Severity: medium

`anon` currently has `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, and `TRIGGER` grants on `public.receipts`. RLS prevents anonymous row access because `auth.uid()` is null, and PostgREST does not directly expose `TRUNCATE`, but least-privilege grants should not rely on those surrounding protections. In particular, PostgreSQL row security does not apply to `TRUNCATE`.

Recommended follow-up: revoke unnecessary `anon` privileges and limit `authenticated` to the four operations used by the application. Test the deployed frontend after changing grants.

### 2. Ownership policies target `public` rather than `authenticated`

Severity: low

The policies are secure as written because unauthenticated `auth.uid()` is null and cannot satisfy the ownership expressions. Scoping the policies explicitly to `authenticated` would make intent clearer, avoid unnecessary policy evaluation for anonymous requests, and align with current Supabase guidance.

Recommended follow-up: recreate the receipt and Storage policies with `TO authenticated`, preserving the same ownership expressions.

### 3. `receipts.user_id` is nullable at the schema level

Severity: low

The insert policy prevents browser users from creating an ownerless row, and all existing rows have an owner. A privileged process or future server integration could still create one because the column has no `NOT NULL` constraint.

Recommended follow-up: add `NOT NULL` after confirming every production row has an owner, and retain the foreign key to `auth.users(id)`.

### 4. Leaked-password protection is disabled

Severity: low

The Supabase security advisor reports that compromised-password checking is disabled.

Recommended follow-up: enable leaked-password protection in Auth settings. See [Supabase password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

### 5. Receipt uploads have no bucket-level size or MIME restrictions

Severity: low

The private bucket currently has no `file_size_limit` or `allowed_mime_types`. Ownership remains protected, but authenticated users can upload unexpectedly large or unsupported file types by calling Storage directly.

Recommended follow-up: set limits matching the frontend's supported images and PDFs after choosing an acceptable maximum receipt size.

## Functionality-sensitive notes

- Storage has no `UPDATE` policy. The current frontend uploads unique object names and does not use overwrite/upsert, so this does not break existing behavior and is not an ownership gap.
- The frontend deletes a Storage object before deleting its receipt row. Both operations are owner-scoped, but they are not transactional; a failed second operation can leave an orphaned row or file. This is a consistency concern, not a cross-user access issue.
- No production policies or grants were changed during this audit.

## Authoritative references

- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase Storage ownership](https://supabase.com/docs/guides/storage/security/ownership)
- [Supabase product security](https://supabase.com/docs/guides/security/product-security)
