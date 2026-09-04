const test = require('node:test')
const assert = require('node:assert/strict')
const { loadApp } = require('./load-app')

test('apiUrl keeps browser requests same-origin', () => {
  const app = loadApp()
  assert.equal(app.call('apiUrl', '/api/scan-receipt'), '/api/scan-receipt')
})

test('apiUrl prefixes the production backend for native Capacitor requests', () => {
  const app = loadApp()
  app.run("Capacitor = { isNativePlatform: () => true }")
  assert.equal(app.call('apiUrl', '/api/scan-receipt'), 'https://receipt-box.onrender.com/api/scan-receipt')
})
