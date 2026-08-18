const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('pins every CDN script with SHA-384 integrity and anonymous CORS', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const scripts = [...html.matchAll(/<script src="([^"]+)" integrity="([^"]+)" crossorigin="([^"]+)"><\/script>/g)]
    .map(match => ({ src: match[1], integrity: match[2], crossorigin: match[3] }))

  assert.deepEqual(scripts.map(script => script.src), [
    'https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.4/heic2any.min.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.3',
    'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
    'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js'
  ])
  assert.ok(scripts.every(script => /^sha384-[A-Za-z0-9+/]{64}$/.test(script.integrity)))
  assert.ok(scripts.every(script => script.crossorigin === 'anonymous'))
})

test('records least-privilege grants, authenticated policies, and upload limits', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260818005236_harden_receipt_ownership_and_uploads.sql'), 'utf8')

  assert.match(sql, /revoke all privileges on table public\.receipts from anon;/i)
  assert.match(sql, /grant select, insert, update, delete on table public\.receipts to authenticated;/i)
  assert.match(sql, /alter table public\.receipts alter column user_id set not null;/i)
  assert.equal((sql.match(/\nto authenticated\n/g) || []).length, 7)
  assert.match(sql, /with check \(\(select auth\.uid\(\)\) = user_id\);/i)
  assert.match(sql, /file_size_limit = 10485760/i)
  assert.match(sql, /allowed_mime_types = array\['image\/\*', 'application\/pdf'\]/i)
})

test('keeps the original selected receipt file for storage', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.match(html, /async function save\(\).*?const id=crypto\.randomUUID\(\),f=originalReceiptFile\(\)/s)
})
