const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('../server')

test('retired legacy OCR routes are not registered', () => {
  const registeredRoutes = (app.router?.stack || []).map(layer => layer.route?.path).filter(Boolean).flat()
  assert.doesNotMatch(registeredRoutes.join('\n'), /^\/api\/(?:scan-receipt|scan)$/m)
})

test('frontend has no network call to the retired OCR proxy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.doesNotMatch(html, /fetch\(apiUrl\(['"]\/api\/(?:scan-receipt|scan)['"]\)/)
  assert.match(html, /Foreground OCR is retired\. Receipt images are processed through the secure background queue\./)
})

test('supported receipt admission remains on the authenticated durable queue', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const worker = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'process-receipt-queue', 'index.ts'), 'utf8')

  assert.match(html, /\$\('cameraFile'\)\.onchange=\(\)=>handleCameraCapture\(\)/)
  assert.match(html, /\$\('libraryFile'\)\.onchange=async\(\)=>.*handleLibraryFileSelection/s)
  assert.match(html, /async function admitDurableReceipt\(file\).*?workflow_status:'queued'/s)
  assert.match(worker, /isAuthorisedWorkerRequest\(token, workerSecret\)/)
  assert.match(worker, /begin_receipt_ocr_service/)
  assert.match(worker, /complete_receipt_ocr_service/)
})
