const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { app } = require('../server')

async function getPage(route) {
  const layer = app.router.stack.find(item => item.route?.path === route && item.route.methods.get)
  assert.ok(layer, `Expected a GET handler for ${route}`)
  const response = {
    status: 200,
    html: '',
    sendFile(filename) {
      this.html = fs.readFileSync(filename, 'utf8')
      return this
    }
  }
  await layer.route.stack[0].handle({}, response)
  return { response, html: response.html }
}

for (const [route, heading] of [
  ['/privacy', 'ReceiptGo Privacy Policy'],
  ['/terms', 'ReceiptGo Terms of Use'],
  ['/support', 'ReceiptGo Support'],
  ['/delete-account', 'Delete your ReceiptGo account']
]) {
  test(`${route} is publicly accessible and contains ReceiptGo legal identity`, async () => {
    const { response, html } = await getPage(route)
    assert.equal(response.status, 200)
    assert.match(html, new RegExp(heading, 'i'))
    assert.match(html, /National Events Pty Ltd/i)
    assert.match(html, /ABN 74 687 975 337/)
    assert.match(html, /Snap\. Store\. Go\./)
    assert.doesNotMatch(html, /Sign in to keep your receipts/)
  })
}

test('support page exposes the operational support email', async () => {
  const { html } = await getPage('/support')
  assert.match(html, /mailto:support@receiptgo\.com\.au/)
  assert.match(html, /support@receiptgo\.com\.au/)
})

test('delete-account page contains external deletion instructions and prefilled subject', async () => {
  const { html } = await getPage('/delete-account')
  assert.match(html, /without reinstalling ReceiptGo/i)
  assert.match(html, /ReceiptGo%20account%20deletion%20request/)
  assert.match(html, /Settings/)
  assert.match(html, /Delete account/)
  assert.match(html, /permanent/i)
})

test('every public page links all four legal and support routes', async () => {
  for (const route of ['/privacy', '/terms', '/support', '/delete-account']) {
    const { html } = await getPage(route)
    for (const destination of ['/privacy', '/terms', '/support', '/delete-account']) {
      assert.match(html, new RegExp(`href="${destination}"`))
    }
  }
})
