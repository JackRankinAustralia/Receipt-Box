const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Webhook } = require('standardwebhooks')
const {
  createResendSupportWebhookHandler,
  includesSupportAddress
} = require('../resend-support-webhook')

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this }
  }
}

function requestFor(event) {
  const headers = { 'svix-id': 'msg_webhook_1', 'svix-timestamp': '1789185600', 'svix-signature': 'v1,valid' }
  return {
    body: Buffer.from(JSON.stringify(event)),
    get(name) { return headers[String(name).toLowerCase()] }
  }
}

function harness({ event, receivedEmail, verifyError, retrieveError, sendError } = {}) {
  const calls = { verify: [], retrieve: [], send: [], logs: [] }
  const resend = {
    webhooks: {
      verify(input) {
        calls.verify.push(input)
        if (verifyError) throw verifyError
        return event
      }
    },
    emails: {
      receiving: {
        async get(id) { calls.retrieve.push(id); return { data: receivedEmail, error: retrieveError || null } }
      },
      async send(message, options) { calls.send.push({ message, options }); return { data: sendError ? null : { id: 'sent_1' }, error: sendError || null } }
    }
  }
  const handler = createResendSupportWebhookHandler({
    env: {
      RESEND_API_KEY: 're_test_value',
      RESEND_WEBHOOK_SECRET: 'whsec_test_value',
      RECEIPTGO_SUPPORT_FORWARD_TO: 'private-inbox@example.test'
    },
    createClient: () => resend,
    logger: { error(message) { calls.logs.push(message) } }
  })
  return { calls, handler }
}

const supportEvent = {
  type: 'email.received',
  data: { email_id: 'received_123', to: ['ReceiptGo Support <support@receiptgo.com.au>'] }
}
const inboundEmail = {
  id: 'received_123',
  from: 'Customer Name <customer@example.test>',
  to: ['support@receiptgo.com.au'],
  subject: 'Please help',
  created_at: '2026-09-12T01:00:00.000Z',
  text: 'Original plain-text body.',
  html: '<p>Original HTML body.</p>',
  attachments: []
}

test('valid support email is verified from raw bytes, retrieved and forwarded', async () => {
  const { calls, handler } = harness({ event: supportEvent, receivedEmail: inboundEmail })
  const request = requestFor(supportEvent), response = responseRecorder()

  await handler(request, response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { received: true, forwarded: true })
  assert.equal(calls.verify[0].payload, request.body.toString('utf8'))
  assert.deepEqual(calls.verify[0].headers, { id: 'msg_webhook_1', timestamp: '1789185600', signature: 'v1,valid' })
  assert.deepEqual(calls.retrieve, ['received_123'])
  assert.equal(calls.send.length, 1)
  assert.equal(calls.send[0].message.to[0], 'private-inbox@example.test')
  assert.equal(calls.send[0].message.replyTo, inboundEmail.from)
  assert.equal(calls.send[0].message.subject, '[ReceiptGo Support] Please help')
  assert.match(calls.send[0].message.text, /Original plain-text body\./)
  assert.match(calls.send[0].message.html, /Original HTML body\./)
})

test('invalid signature returns 400 and never retrieves or forwards', async () => {
  const { calls, handler } = harness({ event: supportEvent, receivedEmail: inboundEmail, verifyError: Error('bad signature') })
  const response = responseRecorder()
  await handler(requestFor(supportEvent), response)
  assert.equal(response.statusCode, 400)
  assert.deepEqual(calls.retrieve, [])
  assert.deepEqual(calls.send, [])
})

test('official Resend verifier accepts a correctly signed raw webhook body', async () => {
  const secret = `whsec_${Buffer.from('receiptgo-test-webhook-secret-32').toString('base64')}`
  const event = { type: 'email.delivered', data: { email_id: 'sent_123' } }
  const body = Buffer.from(JSON.stringify(event))
  const id = 'msg_cryptographic_test'
  const timestamp = new Date()
  const signature = new Webhook(secret).sign(id, timestamp, body)
  const request = {
    body,
    get(name) {
      return { 'svix-id': id, 'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'svix-signature': signature }[String(name).toLowerCase()]
    }
  }
  const response = responseRecorder()
  const handler = createResendSupportWebhookHandler({ env: { RESEND_WEBHOOK_SECRET: secret } })

  await handler(request, response)

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.body, { received: true, ignored: true })
})

test('unrelated valid Resend event returns 200 without forwarding', async () => {
  const event = { type: 'email.delivered', data: { email_id: 'sent_123' } }
  const { calls, handler } = harness({ event })
  const response = responseRecorder()
  await handler(requestFor(event), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.ignored, true)
  assert.deepEqual(calls.retrieve, [])
  assert.deepEqual(calls.send, [])
})

test('inbound email to another address returns 200 without retrieval or forwarding', async () => {
  const event = { type: 'email.received', data: { email_id: 'received_other', to: ['sales@receiptgo.com.au'] } }
  const { calls, handler } = harness({ event })
  const response = responseRecorder()
  await handler(requestFor(event), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.ignored, true)
  assert.deepEqual(calls.retrieve, [])
  assert.deepEqual(calls.send, [])
})

test('retrieved recipient is checked again before forwarding', async () => {
  const { calls, handler } = harness({ event: supportEvent, receivedEmail: { ...inboundEmail, to: ['sales@receiptgo.com.au'] } })
  const response = responseRecorder()
  await handler(requestFor(supportEvent), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.ignored, true)
  assert.deepEqual(calls.send, [])
})

test('forwarding failure returns a retryable 5xx without exposing provider details', async () => {
  const { calls, handler } = harness({ event: supportEvent, receivedEmail: inboundEmail, sendError: { message: 'provider secret detail' } })
  const response = responseRecorder()
  await handler(requestFor(supportEvent), response)
  assert.equal(response.statusCode, 502)
  assert.deepEqual(response.body, { error: 'Email forwarding failed.' })
  assert.doesNotMatch(JSON.stringify(response.body), /provider secret detail/)
  assert.deepEqual(calls.logs, ['ReceiptGo support forwarding could not send an email.'])
})

test('inbound body retrieval failure returns a retryable 5xx', async () => {
  const { calls, handler } = harness({ event: supportEvent, retrieveError: { message: 'temporary provider failure' } })
  const response = responseRecorder()
  await handler(requestFor(supportEvent), response)
  assert.equal(response.statusCode, 502)
  assert.deepEqual(response.body, { error: 'Inbound email retrieval failed.' })
  assert.deepEqual(calls.send, [])
})

test('replayed delivery uses the same received-email idempotency key', async () => {
  const { calls, handler } = harness({ event: supportEvent, receivedEmail: inboundEmail })
  await handler(requestFor(supportEvent), responseRecorder())
  await handler(requestFor(supportEvent), responseRecorder())
  assert.equal(calls.send.length, 2)
  assert.equal(calls.send[0].options.idempotencyKey, 'receiptgo-support-forward/received_123')
  assert.equal(calls.send[1].options.idempotencyKey, calls.send[0].options.idempotencyKey)
})

test('attachment presence is explicitly flagged without downloading customer files', async () => {
  const email = { ...inboundEmail, attachments: [{ id: 'attachment_1', filename: 'receipt.pdf' }] }
  const { calls, handler } = harness({ event: supportEvent, receivedEmail: email })
  await handler(requestFor(supportEvent), responseRecorder())
  assert.match(calls.send[0].message.text, /original message contained 1 attachment/i)
  assert.match(calls.send[0].message.html, /Resend inbound dashboard/)
  assert.equal('attachments' in calls.send[0].message, false)
})

test('recipient matching is exact and case-insensitive', () => {
  assert.equal(includesSupportAddress(['SUPPORT@RECEIPTGO.COM.AU']), true)
  assert.equal(includesSupportAddress(['ReceiptGo <support@receiptgo.com.au>']), true)
  assert.equal(includesSupportAddress(['support+tag@receiptgo.com.au']), false)
  assert.equal(includesSupportAddress(['not-support@receiptgo.com.au']), false)
})

test('server registers raw webhook parsing before global JSON parsing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  const webhook = source.indexOf("app.post('/api/webhooks/resend', express.raw")
  const jsonParser = source.indexOf("app.use(express.json({ limit: '12mb' }))")
  assert.ok(webhook >= 0)
  assert.ok(jsonParser > webhook)
})
