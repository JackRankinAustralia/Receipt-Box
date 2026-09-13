const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
const info = fs.readFileSync(path.join(root, 'ios/App/App/Info.plist'), 'utf8')
const capacitor = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'))

test('customer-facing app title, identity and copy use ReceiptGo', () => {
  assert.match(html, /<title>ReceiptGo<\/title>/)
  assert.match(html, /<h1>ReceiptGo<\/h1>/)
  assert.match(html, /Snap\. Store\. Go\./)
  assert.match(html, /ReceiptGo Pro/)
  assert.doesNotMatch(html.replace('https://receipt-box.onrender.com', '').replaceAll('receiptbox:', ''), /Receipt Box|Receipt-Box|receipt-box/i)
})

test('Settings links point to the live ReceiptGo public pages', () => {
  for (const page of ['privacy', 'terms', 'support', 'delete-account']) {
    assert.match(html, new RegExp('href="https://receiptgo\\.com\\.au/' + page + '"'))
  }
})

test('iOS display name and permission prompts use ReceiptGo while retaining both reset schemes', () => {
  assert.equal(capacitor.appName, 'ReceiptGo')
  assert.match(info, /<key>CFBundleDisplayName<\/key>\s*<string>ReceiptGo<\/string>/)
  assert.match(info, /ReceiptGo uses your camera to photograph receipts\./)
  assert.match(info, /ReceiptGo lets you choose receipt images from your photo library\./)
  assert.match(info, /<string>receiptgo<\/string>/)
  assert.match(info, /<string>receiptbox<\/string>/)
})
