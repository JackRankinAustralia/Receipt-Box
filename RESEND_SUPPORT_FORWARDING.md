# ReceiptGo support email forwarding

The Render server exposes `POST /api/webhooks/resend` for Resend's `email.received` webhook. The route verifies the raw request body with Resend's SDK before processing it and forwards only mail addressed exactly to `support@receiptgo.com.au`.

The official Resend SDK used here requires Node.js 20 or newer; `package.json` declares that runtime requirement for Render.

## Required Render environment variables

- `RESEND_API_KEY`: Resend API key with permission to retrieve received mail and send the forward.
- `RESEND_WEBHOOK_SECRET`: signing secret for this specific Resend webhook endpoint.
- `RECEIPTGO_SUPPORT_FORWARD_TO`: private destination mailbox. Never commit its value.

## Delivery behaviour

- The full inbound message is retrieved through Resend's Receiving API because the webhook contains metadata rather than the full body.
- Replies go to the original sender through `Reply-To`.
- Resend's send idempotency key is `receiptgo-support-forward/<received-email-id>`, preventing duplicate sends for retries using the same inbound email ID within Resend's 24-hour idempotency window.
- Attachments are not downloaded or re-uploaded in this small integration. If the received email reports attachments, the forwarded text and HTML both state their count and direct the support recipient to the Resend inbound dashboard. This avoids silently losing them and avoids making the Render endpoint hold untrusted attachment files in memory.

## Manual setup after deployment

1. Add the three environment variables above to the Render service and redeploy it.
2. In Resend, create an `email.received` webhook pointing to `https://<render-host>/api/webhooks/resend`.
3. Copy that webhook's signing secret into `RESEND_WEBHOOK_SECRET` in Render.
4. Send a test message to `support@receiptgo.com.au`, confirm one forward arrives, and verify that Reply uses the original sender.
