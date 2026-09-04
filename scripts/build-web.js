// Copies the canonical web frontend into www/, the Capacitor webDir.
//
// index.html at the repo root remains the single source of truth for both
// the Render web deployment (served directly by server.js) and the native
// Capacitor app (bundled from this copy). This script performs a plain
// file copy only -- no bundler, no transformation -- to avoid the web and
// native builds ever drifting apart.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const outDir = path.join(root, 'www')

fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(path.join(root, 'index.html'), path.join(outDir, 'index.html'))
console.log('Copied index.html to www/index.html for Capacitor.')
