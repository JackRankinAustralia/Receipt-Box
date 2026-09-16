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

test('ordinary local browser origins retain development behaviour', () => {
  for (const origin of ['http://localhost:8000', 'https://localhost', 'http://127.0.0.1', 'http://[::1]', 'file:///index.html']) {
    const app = loadApp({ origin, capacitor: { isNativePlatform: () => false } })
    assert.equal(app.run('IS_LOCAL_DEV'), true, origin)
    app.run('entitlementState = freeEntitlement(); entitlementState.capabilities.export_csv = false')
    assert.equal(app.run('entitlementService.canExportCSV()'), true)
  }
})

test('production web and native origins never activate local shortcuts', () => {
  const cases = [
    { origin: 'https://receiptgo.com.au' },
    { origin: 'capacitor://localhost', capacitor: { isNativePlatform: () => true } },
    { origin: 'http://localhost', capacitor: { isNativePlatform: () => true } },
    { origin: 'file:///index.html', capacitor: { isNativePlatform: () => true } },
    { origin: 'capacitor://localhost' }
  ]
  for (const options of cases) assert.equal(loadApp(options).run('IS_LOCAL_DEV'), false, options.origin)
})

function nativeFreeApp() {
  const app = loadApp({ origin: 'capacitor://localhost', capacitor: { isNativePlatform: () => true } })
  app.run(`entitlementState = freeEntitlement();
    for (const key of Object.keys(entitlementState.capabilities)) entitlementState.capabilities[key] = false;
    entitlementState.ocr = {used:10,limit:10,allowed:false}; receiptOCRReady = true; renderEntitlement();`)
  return app
}

test('native Free account retains all capability locks, Free label and exhausted Read state', () => {
  const app = nativeFreeApp()
  for (const capability of ['create_entity','create_project','custom_categories','advanced_reports','export_csv','export_pdf','run_ocr']) {
    assert.equal(app.run(`entitlementService.can('${capability}')`), false, capability)
  }
  assert.match(app.run("$('accountMsg').innerHTML"), /Free plan/)
  assert.doesNotMatch(app.run("$('accountMsg').innerHTML"), /Unlimited OCR scans/)
  assert.equal(app.run("$('readBtn').disabled"), true)
  assert.equal(app.run('entitlementService.canRenameCategory("Custom category")'), false)
  app.run('entitlementState = __testEntitlement = {plan:"pro",ocr:{used:10,limit:null,allowed:true},capabilities:{run_ocr:true,export_csv:true,export_pdf:true,advanced_reports:true}}; renderEntitlement()')
  assert.equal(app.run('entitlementService.canExportCSV()'), true)
  assert.equal(app.run("$('readBtn').disabled"), false)
})

function prepareScan(app, allowed, fails = false) {
  app.run(`
    globalThis.scanCalls = []; globalThis.modelCalls = 0;
    selectedReceiptFile = () => ({type:'image/jpeg',lastModified:Date.now()});
    fileToBase64 = async () => 'test-image';
    scanReceiptWithGemini = async () => { modelCalls++; ${fails ? "throw Error('Test failure')" : "return {supplier:'Test Shop',date:'2026-08-18',total:11,gst:1}"} };
    entitlementService.beginOCR = async id => { scanCalls.push(['begin',id]); return {allowed:${allowed}} };
    entitlementService.completeOCR = async (id,meaningful) => { scanCalls.push(['complete',id,meaningful]) };
  `)
}

test('native OCR denial stops before model invocation even when called directly', async () => {
  const app = nativeFreeApp(); prepareScan(app, false)
  await app.call('readReceiptWithGemini')
  assert.equal(app.run('scanCalls.length'), 1)
  assert.equal(app.run('scanCalls[0][0]'), 'begin')
  assert.equal(app.run('modelCalls'), 0)
})

test('native successful and failed OCR retain admission and completion accounting', async () => {
  for (const fails of [false, true]) {
    const app = nativeFreeApp(); prepareScan(app, true, fails)
    await app.call('readReceiptWithGemini')
    assert.equal(app.run('modelCalls'), 1)
    assert.equal(app.run('scanCalls.length'), 2)
    assert.equal(app.run('scanCalls[0][0]'), 'begin')
    assert.equal(app.run('scanCalls[1][0]'), 'complete')
    assert.equal(app.run('scanCalls[0][1] === scanCalls[1][1]'), true)
    assert.equal(app.run('scanCalls[1][2]'), !fails)
  }
})
