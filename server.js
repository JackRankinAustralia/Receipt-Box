require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const { rateLimit } = require('express-rate-limit')
const { join } = require('node:path')

const REQUIRED_ENV_VARS = ['NODE_ENV', 'PORT', 'ALLOWED_ORIGIN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OCR_API_KEY']
const missingEnvVars = REQUIRED_ENV_VARS.filter(name => !String(process.env[name] || '').trim())
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variable(s): ${missingEnvVars.join(', ')}. See .env.example.`)
  process.exit(1)
}

const root = __dirname
const port = Number(process.env.PORT || 8080)
const app = express()
const allowedOrigins = new Set(String(process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGIN || '').split(',').map(origin => origin.trim()).filter(Boolean))

app.disable('x-powered-by')
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({ origin(origin, callback) {
  if (!origin || allowedOrigins.has(origin)) return callback(null, true)
  return callback(new Error('Origin is not allowed by CORS.'))
} }))
app.use(express.json({ limit: '12mb' }))

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false })
const scanLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false })
app.use('/api', apiLimiter)
function sanitizeGeminiApiKey(value) {
  return String(value || '').trim().replace(/^["']+|["']+$/g, '').trim()
}

if (!sanitizeGeminiApiKey(process.env.GEMINI_API_KEY) || sanitizeGeminiApiKey(process.env.GEMINI_API_KEY) === 'your_gemini_api_key_here') {
  console.warn('⚠️ GEMINI_API_KEY is not configured in .env')
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (body.length > 12 * 1024 * 1024) reject(new Error('Request body is too large.'))
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

async function handleScanReceipt(request, response) {
  const contentLength = Number(request.headers['content-length'] || 0)
  const bodyKeys = request.body && typeof request.body === 'object' ? Object.keys(request.body) : []
  console.log(`scan-receipt request: contentLength=${contentLength} bytes, bodyKeys=[${bodyKeys.join(', ')}]`)
  const geminiApiKey = sanitizeGeminiApiKey(process.env.GEMINI_API_KEY)
  if (!geminiApiKey) {
    console.error('scan-receipt 500: GEMINI_API_KEY is not configured on the server.')
    response.status(500).json({ error: { message: 'Server missing GEMINI_API_KEY configuration.' } })
    return
  }
  const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent'

  try {
    const payload = request.body
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.contents)) {
      console.error('scan-receipt 400: request body missing a valid contents array.', { bodyType: typeof payload, hasContents: Array.isArray(payload?.contents) })
      response.status(400).json({ error: { message: 'Request must contain a contents array.' } })
      return
    }

    const upstream = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
      body: JSON.stringify(payload)
    })
    const text = await upstream.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = { error: { message: text || `Gemini API returned HTTP ${upstream.status}.` } }
    }
    if (!upstream.ok) console.error('Google Gemini API error response:', JSON.stringify(body))
    response.status(upstream.status).json(body)
  } catch (error) {
    console.error('Gemini API Error:', error)
    const message = process.env.NODE_ENV === 'production' ? 'Gemini proxy request failed.' : error.message || 'Gemini proxy request failed.'
    response.status(502).json({ error: { message } })
  }
}
app.post(['/api/scan-receipt', '/api/scan'], scanLimiter, handleScanReceipt)
app.use(express.static(root))
app.use((error, request, response, next) => {
  console.error('Unhandled request error:', error)
  const message = process.env.NODE_ENV === 'production' ? 'Request failed.' : error.message || 'Request failed.'
  if (response.headersSent) return next(error)
  response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { message } })
})

app.listen(port, () => {
  console.log(`Receipt Box server listening on http://localhost:${port}`)
})
