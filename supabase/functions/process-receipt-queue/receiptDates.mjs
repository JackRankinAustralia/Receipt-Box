// Focused server-side Australian date normaliser for the background OCR
// worker. This intentionally duplicates the small, well-tested rule set of
// normaliseReceiptDate() in index.html rather than sharing a module with the
// browser, per the Stage 3D-B instruction not to perform a broader
// browser/server refactor in this stage. Both are tested against the same
// known date cases (see tests/receipt-ocr-worker-postgres.test.js and
// tests/parser.test.js) so they cannot silently drift apart.
//
// Ambiguous short-form numeric dates (DD/MM/YYYY vs MM/DD/YYYY) are always
// interpreted the Australian way: DD/MM/YYYY.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
}

function toYear(year) {
  const value = Number(year)
  return value < 100 ? (value <= 69 ? 2000 + value : 1900 + value) : value
}

function toISO(year, month, day) {
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    : null
}

export function normaliseAustralianReceiptDate(value) {
  const text = String(value || '').trim()

  let match = text.match(/\b(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/)
  if (match) return toISO(Number(match[1]), Number(match[2]), Number(match[3]))

  match = text.match(/\b(\d{1,2})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(20\d{2}|\d{2})\b/)
  if (match) {
    const day = Number(match[1]), month = Number(match[2]), year = toYear(match[3])
    return toISO(year, month, day)
  }

  match = text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*,?\s*(20\d{2}|\d{2})\b/i)
  if (match) return toISO(toYear(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1]))

  return null
}
