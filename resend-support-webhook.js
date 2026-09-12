const { Resend } = require('resend')

const SUPPORT_ADDRESS = 'support@receiptgo.com.au'
const FORWARD_FROM = 'ReceiptGo Support <support@receiptgo.com.au>'

function asAddressList(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map(String)
}

function mailboxAddress(value) {
  const text = String(value || '').trim()
  const angleAddress = text.match(/<([^<>]+)>\s*$/)?.[1]
  return String(angleAddress || text).trim().toLowerCase()
}

function includesSupportAddress(value) {
  return asAddressList(value).some(address => mailboxAddress(address) === SUPPORT_ADDRESS)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character])
}

function safeSubject(value) {
  return String(value || '(no subject)').replace(/[\r\n]+/g, ' ').trim() || '(no subject)'
}

function attachmentNotice(attachments) {
  const count = Array.isArray(attachments) ? attachments.length : 0
  if (!count) return { text: '', html: '' }
  const label = `${count} attachment${count === 1 ? '' : 's'}`
  return {
    text: `\n\nAttachment notice: The original message contained ${label}. Attachments are not included in this forward; view them in the Resend inbound dashboard.`,
    html: `<p><strong>Attachment notice:</strong> The original message contained ${escapeHtml(label)}. Attachments are not included in this forward; view them in the Resend inbound dashboard.</p>`
  }
}

function forwardedMessage(email) {
  const from = String(email.from || '')
  const to = asAddressList(email.to).join(', ')
  const subject = safeSubject(email.subject)
  const receivedAt = String(email.created_at || '')
  const notice = attachmentNotice(email.attachments)
  const metadataText = [
    `Original From: ${from}`,
    `Original To: ${to}`,
    `Original Subject: ${subject}`,
    `Received: ${receivedAt}`
  ].join('\n')
  const textBody = String(email.text || '')
  const htmlBody = String(email.html || '')

  return {
    subject: `[ReceiptGo Support] ${subject}`,
    text: `${metadataText}\n\n${textBody || '[No plain-text body supplied.]'}${notice.text}`,
    html: `<p><strong>Original From:</strong> ${escapeHtml(from)}<br><strong>Original To:</strong> ${escapeHtml(to)}<br><strong>Original Subject:</strong> ${escapeHtml(subject)}<br><strong>Received:</strong> ${escapeHtml(receivedAt)}</p><hr>${htmlBody || `<pre>${escapeHtml(textBody || '[No message body supplied.]')}</pre>`}${notice.html}`
  }
}

function createResendSupportWebhookHandler({ env = process.env, createClient = apiKey => new Resend(apiKey), logger = console } = {}) {
  return async function resendSupportWebhook(request, response) {
    const webhookSecret = String(env.RESEND_WEBHOOK_SECRET || '').trim()
    if (!webhookSecret) return response.status(503).json({ error: 'Webhook is not configured.' })

    const apiKey = String(env.RESEND_API_KEY || '').trim()
    // Webhook verification itself does not use the API key. A non-secret placeholder
    // lets valid, intentionally ignored events still receive 200 during partial setup.
    const resend = createClient(apiKey || 're_webhook_verification_only')
    let event
    try {
      const payload = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : String(request.body || '')
      event = resend.webhooks.verify({
        payload,
        headers: {
          id: request.get('svix-id'),
          timestamp: request.get('svix-timestamp'),
          signature: request.get('svix-signature')
        },
        webhookSecret
      })
    } catch (_error) {
      return response.status(400).json({ error: 'Invalid webhook signature.' })
    }

    try {
      if (event.type !== 'email.received') return response.status(200).json({ received: true, ignored: true })

      const emailId = String(event.data?.email_id || '').trim()
      if (!emailId) return response.status(500).json({ error: 'Received email identifier is missing.' })
      if (event.data?.to && !includesSupportAddress(event.data.to)) {
        return response.status(200).json({ received: true, ignored: true })
      }
      const forwardTo = String(env.RECEIPTGO_SUPPORT_FORWARD_TO || '').trim()
      if (!apiKey || !forwardTo) return response.status(503).json({ error: 'Email forwarding is not configured.' })

      const { data: email, error: retrieveError } = await resend.emails.receiving.get(emailId)
      if (retrieveError || !email) {
        logger.error('ReceiptGo support forwarding could not retrieve an inbound email.')
        return response.status(502).json({ error: 'Inbound email retrieval failed.' })
      }
      if (!includesSupportAddress(email.to)) return response.status(200).json({ received: true, ignored: true })

      const message = forwardedMessage(email)
      const { error: sendError } = await resend.emails.send({
        from: FORWARD_FROM,
        to: [forwardTo],
        replyTo: email.from,
        subject: message.subject,
        text: message.text,
        html: message.html
      }, { idempotencyKey: `receiptgo-support-forward/${emailId}` })
      if (sendError) {
        logger.error('ReceiptGo support forwarding could not send an email.')
        return response.status(502).json({ error: 'Email forwarding failed.' })
      }

      return response.status(200).json({ received: true, forwarded: true })
    } catch (_error) {
      logger.error('ReceiptGo support forwarding encountered a temporary processing failure.')
      return response.status(502).json({ error: 'Email forwarding temporarily failed.' })
    }
  }
}

module.exports = {
  FORWARD_FROM,
  SUPPORT_ADDRESS,
  createResendSupportWebhookHandler,
  forwardedMessage,
  includesSupportAddress
}
