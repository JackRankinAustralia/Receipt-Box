const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const realDate = Date

class FixedDate extends realDate {
  constructor(...args) {
    super(...(args.length ? args : ['2026-08-18T12:00:00+10:00']))
  }

  static now() {
    return new realDate('2026-08-18T12:00:00+10:00').getTime()
  }
}

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(Boolean)
  const appScript = scripts.at(-1)
  const eventBindings = appScript.indexOf("$('loginBtn').onclick=login;")
  if (eventBindings < 0) throw new Error('Could not locate Receipt Box event bindings')

  const elements = {
    reportPeriod: {
      value: 'fy',
      selectedIndex: 1,
      options: [
        { text: 'This month' },
        { text: 'This financial year' },
        { text: 'Last financial year' },
        { text: 'Custom date range' },
        { text: 'All time' }
      ]
    }
  }
  const makeElement = () => {
    const classes = new Set()
    return {
      value: '', files: [], style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
      classList: { add(...names) { names.forEach(name => classes.add(name)) }, remove(...names) { names.forEach(name => classes.delete(name)) }, toggle(name, force) { const add = force === undefined ? !classes.has(name) : force; if (add) classes.add(name); else classes.delete(name); return add }, contains(name) { return classes.has(name) } },
      children: [],
      appendChild(child) { this.children.push(child); return child },
      insertBefore(child, reference) { const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child); return child },
      prepend(child) { this.children.unshift(child); return child },
      removeAttribute(name) { delete this[name] },
      setAttribute(name, value) { this[name] = value },
      scrollIntoView(options) { this.scrollIntoViewCalls = (this.scrollIntoViewCalls || []); this.scrollIntoViewCalls.push(options) },
      click() { this.clickCount = (this.clickCount || 0) + 1 }
    }
  }
  elements.mainArea = makeElement()
  elements.mainArea.children = [makeElement(), makeElement(), makeElement(), makeElement()]
  const document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = makeElement()
      return elements[id]
    },
    createElement() { return makeElement() },
    querySelectorAll() { return [] }
  }
  let confirmResult = true
  const revokedObjectUrls = []
  let timeoutCounter = 0
  const scheduledTimeouts = new Map()
  class TestURL extends URL {
    static createObjectURL() { return 'blob:test-receipt-preview' }
    static revokeObjectURL(value) { revokedObjectUrls.push(value) }
  }
  const context = vm.createContext({
    console,
    document,
    window: { location: {}, scrollTo() {}, open() {} },
    Intl,
    Date: FixedDate,
    Map,
    URL: TestURL,
    Blob,
    File: globalThis.File,
    crypto: { randomUUID: (() => { let n = 0; return () => n++ === 0 ? 'new-receipt-id' : `new-receipt-id-${n}` })() },
    setTimeout(fn, ms) {
      const id = ++timeoutCounter
      scheduledTimeouts.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      scheduledTimeouts.delete(id)
    },
    confirm() { return confirmResult },
    prompt() { return null },
    location: { origin: 'https://example.test', pathname: '/' },
    alert() {}
  })
  vm.runInContext(appScript.slice(0, eventBindings), context, { filename: 'index.html' })
  context.__testEntitlement = { plan: 'pro', ocr: { used: 0, limit: null, allowed: true }, capabilities: { run_ocr: true, create_entity: true, create_project: true, custom_categories: true, advanced_reports: true, export_csv: true, export_pdf: true } }
  vm.runInContext('entitlementState = __testEntitlement', context)

  return {
    call(name, ...args) {
      return context[name](...args)
    },
    run(source) {
      return vm.runInContext(source, context)
    },
    setRows(rows) {
      context.__testRows = rows
      vm.runInContext('allRows = __testRows; receiptRows = __testRows', context)
    },
    setSettings(settings) {
      context.__testSettings = settings
      vm.runInContext('settingsData = __testSettings', context)
    },
    setEntitlementFixture(entitlement) {
      context.__testEntitlement = entitlement
      vm.runInContext('entitlementState = __testEntitlement; renderEntitlement()', context)
    },
    beginOCR(id) {
      context.__testScanId = id
      return vm.runInContext('entitlementService.beginOCR(__testScanId)', context)
    },
    completeOCR(id, meaningful) {
      context.__testScanId = id
      context.__testMeaningful = meaningful
      return vm.runInContext('entitlementService.completeOCR(__testScanId,__testMeaningful)', context)
    },
    setPreviewUrl(value) {
      context.__testPreviewUrl = value
      vm.runInContext('previewUrl = __testPreviewUrl', context)
    },
    state() {
      return vm.runInContext('({ user, allRows, receiptRows, settingsData, previewUrl, authGeneration, entitlementState, ocrScanSessionId, receiptMode, editingExistingReceipt, saveInProgress, receiptSelectionGeneration, ocrReading, reviewMode })', context)
    },
    revokedObjectUrls,
    setBackend(backend, testUser = { id: 'test-user' }) {
      context.__testBackend = backend
      context.__testUser = testUser
      vm.runInContext('sb = __testBackend; user = __testUser', context)
    },
    setConfirm(value) {
      confirmResult = value
    },
    setPeriod(value) {
      const values = ['month', 'fy', 'lastfy', 'custom', 'all']
      elements.reportPeriod.value = value
      elements.reportPeriod.selectedIndex = values.indexOf(value)
    },
    setPDFConstructor(PDF) {
      context.window.jspdf = { jsPDF: PDF }
    },
    setHeicConverter(converter) {
      context.heic2any = converter
    },
    setFunction(name, fn) {
      context.__testFunction = fn
      vm.runInContext(`${name} = __testFunction`, context)
    },
    element(id) {
      return elements[id] || (elements[id] = makeElement())
    },
    pendingTimeoutCount() {
      return scheduledTimeouts.size
    },
    async flushTimeouts() {
      const entries = [...scheduledTimeouts.entries()]
      scheduledTimeouts.clear()
      for (const [, { fn }] of entries) {
        await fn()
      }
    }
  }
}

module.exports = { loadApp }
