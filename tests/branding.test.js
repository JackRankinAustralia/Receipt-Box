const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

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

test('app and shared auth header place a decorative green tick after live ReceiptGo text', () => {
  const mark = '<svg class="brand-tick" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" focusable="false"><circle cx="13" cy="13" r="13" fill="#047857"/><path d="m7 13 4 4 8-8" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  assert.equal(html.split(mark).length - 1, 2)
  assert.ok(html.includes('<div class="login"><div class="brand-heading"><h1>ReceiptGo</h1>' + mark))
  assert.ok(html.includes('<div class="brand-heading"><h1 style="margin-bottom:2px">ReceiptGo</h1>' + mark + '</div><div class="muted" style="font-size:12px">Snap. Store. Go.</div>'))
  assert.match(html, /\.brand-tick\{[^}]*width:26px;height:26px;flex-shrink:0/)
  assert.match(html, /#appShell>\.top\{flex-wrap:wrap\}/)
})

test('native web build needs no external asset for the inline brand tick', () => {
  const copies = []
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-web.js'), 'utf8'), {
    __dirname: path.join(root, 'scripts'),
    console: { log() {} },
    require(name) {
      name = name.replace(/^node:/, '')
      if (name === 'path') return path
      assert.equal(name, 'fs')
      return { mkdirSync() {}, copyFileSync(from, to) { copies.push([from, to]) } }
    }
  })
  assert.deepEqual(copies, [
    [path.join(root, 'index.html'), path.join(root, 'www/index.html')]
  ])
  assert.doesNotMatch(html, /receiptgo-mark\.png|brand-mark/)
  assert.equal(fs.existsSync(path.join(root, 'assets/receiptgo-mark.png')), false)
})

test('iOS display name and permission prompts use ReceiptGo while retaining both reset schemes', () => {
  assert.equal(capacitor.appName, 'ReceiptGo')
  assert.match(info, /<key>CFBundleDisplayName<\/key>\s*<string>ReceiptGo<\/string>/)
  assert.match(info, /ReceiptGo uses your camera to photograph receipts\./)
  assert.match(info, /ReceiptGo lets you choose receipt images from your photo library\./)
  assert.match(info, /<string>receiptgo<\/string>/)
  assert.match(info, /<string>receiptbox<\/string>/)
})
