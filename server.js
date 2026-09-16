require('dotenv').config()
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const { rateLimit } = require('express-rate-limit')
const { join } = require('node:path')
const { createResendSupportWebhookHandler } = require('./resend-support-webhook')

// Never let an unexpected error take the whole process down; log and keep serving.
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error)
})
process.on('unhandledRejection', reason => {
  console.error('Unhandled promise rejection:', reason)
})

const REQUIRED_ENV_VARS = ['NODE_ENV', 'PORT', 'ALLOWED_ORIGIN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
const missingEnvVars = REQUIRED_ENV_VARS.filter(name => !String(process.env[name] || '').trim())
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variable(s): ${missingEnvVars.join(', ')}. See .env.example.`)
}

const root = __dirname
const port = Number(process.env.PORT || 8080)
const app = express()
app.set('trust proxy', 1)

try {
  const allowedOrigins = new Set(String(process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGIN || '').split(',').map(origin => origin.trim()).filter(Boolean))

  app.disable('x-powered-by')
  app.use(helmet({ contentSecurityPolicy: false }))
  app.use(cors({ origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true)
    return callback(new Error('Origin is not allowed by CORS.'))
  } }))
  var apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false })
  app.use('/api', apiLimiter)
  app.post('/api/webhooks/resend', express.raw({ type: 'application/json', limit: '1mb' }), createResendSupportWebhookHandler())
  app.use(express.json({ limit: '12mb' }))
} catch (error) {
  console.error('Failed to initialize middleware:', error)
}

const publicPages = new Map([
  ['/privacy', 'privacy.html'],
  ['/terms', 'terms.html'],
  ['/support', 'support.html'],
  ['/delete-account', 'delete-account.html']
])
for (const [route, filename] of publicPages) {
  app.get(route, (_request, response) => response.sendFile(join(root, 'public-pages', filename)))
}

app.use(express.static(root))
app.use((error, request, response, next) => {
  console.error('Unhandled request error:', error)
  const message = process.env.NODE_ENV === 'production' ? 'Request failed.' : error.message || 'Request failed.'
  if (response.headersSent) return next(error)
  response.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: { message } })
})

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Receipt Box server listening on http://localhost:${port}`)
  }).on('error', error => {
    console.error('Failed to start server:', error)
  })
}

module.exports = { app }
