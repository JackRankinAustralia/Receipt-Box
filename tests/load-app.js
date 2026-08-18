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
        { text: 'All time' }
      ]
    }
  }
  const document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = { value: '' }
      return elements[id]
    }
  }
  const context = vm.createContext({
    console,
    document,
    window: {},
    Intl,
    Date: FixedDate,
    Map,
    URL,
    Blob,
    File: globalThis.File,
    alert(message) { throw new Error(message) }
  })
  vm.runInContext(appScript.slice(0, eventBindings), context, { filename: 'index.html' })

  return {
    call(name, ...args) {
      return context[name](...args)
    },
    setRows(rows) {
      context.__testRows = rows
      vm.runInContext('allRows = __testRows', context)
    },
    setPeriod(value) {
      const values = ['month', 'fy', 'lastfy', 'all']
      elements.reportPeriod.value = value
      elements.reportPeriod.selectedIndex = values.indexOf(value)
    },
    setPDFConstructor(PDF) {
      context.window.jspdf = { jsPDF: PDF }
    },
    setHeicConverter(converter) {
      context.heic2any = converter
    }
  }
}

module.exports = { loadApp }
