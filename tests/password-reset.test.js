const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

function authBackend() {
  const calls = { resets: [], sessions: [], updates: [] }
  const recoveredUser = { id: 'recovered-user', email: 'owner@example.com' }
  return {
    calls,
    auth: {
      async resetPasswordForEmail(email, options) { calls.resets.push({ email, options }); return { error: null } },
      async setSession(session) { calls.sessions.push(session); return { data: { session: { user: recoveredUser } }, error: null } },
      async updateUser(attributes) { calls.updates.push(attributes); return { data: { user: recoveredUser }, error: null } },
      async signInWithPassword() { return { data: { session: { user: recoveredUser } }, error: null } },
      async signOut() { return { error: null } }
    }
  }
}

test('web password reset preserves the hosted current-path redirect', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  app.setWindowLocation({ origin: 'https://receiptboxapp.vercel.app', pathname: '/account', href: 'https://receiptboxapp.vercel.app/account' })
  app.element('email').value = 'owner@example.com'

  assert.equal(await app.call('sendSignedOutPasswordReset'), true)
  assert.equal(JSON.stringify(db.calls.resets), JSON.stringify([{ email: 'owner@example.com', options: { redirectTo: 'https://receiptboxapp.vercel.app/account' } }]))
  assert.match(app.element('loginMsg').innerHTML, /Check your email for a password reset link/)
})

test('native password reset uses the scoped Receipt Box recovery scheme', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, { id: 'test-user', email: 'owner@example.com' })
  app.setNativePlugins({ App: {} })

  assert.equal(await app.call('sendPasswordReset'), true)
  assert.equal(db.calls.resets[0].options.redirectTo, 'receiptbox://reset-password')
})

test('native recovery URL establishes its Supabase session and enters reset mode', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  const url = 'receiptbox://reset-password#access_token=private-access&refresh_token=private-refresh&type=recovery'

  assert.equal(app.call('isNativeRecoveryUrl', url), true)
  assert.equal(await app.call('handleNativeRecoveryUrl', url), true)
  assert.equal(JSON.stringify(db.calls.sessions), JSON.stringify([{ access_token: 'private-access', refresh_token: 'private-refresh' }]))
  assert.equal(app.element('loginForm').classList.contains('hidden'), true)
  assert.equal(app.element('passwordRecoveryForm').classList.contains('hidden'), false)
  assert.doesNotMatch(app.element('gate').innerHTML + app.element('loginMsg').innerHTML, /private-access|private-refresh/)
})

test('Supabase PASSWORD_RECOVERY event enters the new-password form', () => {
  const app = loadApp()
  app.call('handleAuthStateChange', 'PASSWORD_RECOVERY', { user: { id: 'recovered-user' } })
  assert.equal(app.element('loginForm').classList.contains('hidden'), true)
  assert.equal(app.element('passwordRecoveryForm').classList.contains('hidden'), false)
  assert.match(app.element('loginMsg').textContent, /Enter and confirm/)
})

test('normal Supabase sign-in and sign-out transitions remain unchanged', async () => {
  const app = loadApp()
  let signedInUser = null
  let signedOut = 0
  app.setFunction('startAuthenticatedSession', async user => { signedInUser = user })
  app.setFunction('showSignedOutState', () => { signedOut += 1 })

  app.call('handleAuthStateChange', 'SIGNED_IN', { user: { id: 'normal-user' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(signedInUser.id, 'normal-user')

  app.call('handleAuthStateChange', 'SIGNED_OUT', null)
  assert.equal(signedOut, 1)
})

test('Capacitor App handles both cold-launch and running-app recovery links', async () => {
  const app = loadApp(), db = authBackend()
  let listener
  const coldUrl = 'receiptbox://reset-password#access_token=cold-access&refresh_token=cold-refresh&type=recovery'
  app.setBackend(db, null)
  app.setNativePlugins({ App: {
    async addListener(name, callback) { assert.equal(name, 'appUrlOpen'); listener = callback },
    async getLaunchUrl() { return { url: coldUrl } }
  } })

  assert.equal(await app.call('setupNativeRecoveryLinks'), true)
  assert.equal(db.calls.sessions.length, 1)
  await listener({ url: 'receiptbox://reset-password#access_token=warm-access&refresh_token=warm-refresh&type=recovery' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(db.calls.sessions.length, 2)
})

test('recovery password validates confirmation and updates through Supabase Auth', async () => {
  const app = loadApp(), db = authBackend()
  let resumedUser = null
  app.setBackend(db, null)
  await app.call('handleNativeRecoveryUrl', 'receiptbox://reset-password#access_token=a&refresh_token=b&type=recovery')
  app.setFunction('startAuthenticatedSession', async user => { resumedUser = user })
  app.element('recoveryPassword').value = 'new-password-123'
  app.element('recoveryPasswordConfirm').value = 'different-password'
  assert.equal(await app.call('submitRecoveryPassword'), false)
  assert.match(app.element('loginMsg').innerHTML, /Passwords do not match/)
  assert.equal(db.calls.updates.length, 0)

  app.element('recoveryPasswordConfirm').value = 'new-password-123'
  assert.equal(await app.call('submitRecoveryPassword'), true)
  assert.equal(JSON.stringify(db.calls.updates), JSON.stringify([{ password: 'new-password-123' }]))
  assert.equal(resumedUser.id, 'recovered-user')
  assert.match(app.element('saveMsg').innerHTML, /Password updated/)
})

test('invalid or expired native recovery links show a friendly recoverable error', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  const invalid = 'receiptbox://reset-password#error=access_denied&error_code=otp_expired&error_description=Sensitive+provider+detail&type=recovery'

  assert.equal(await app.call('handleNativeRecoveryUrl', invalid), false)
  assert.match(app.element('loginMsg').innerHTML, /invalid or has expired/)
  assert.doesNotMatch(app.element('loginMsg').innerHTML, /Sensitive|otp_expired|access_denied/)
  assert.equal(app.element('loginForm').classList.contains('hidden'), false)
})

test('recovery implementation never logs or renders token parameters', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*(?:accessToken|refreshToken|access_token|refresh_token)/)
  assert.doesNotMatch(source, /innerHTML\s*=\s*[^\n]*(?:accessToken|refreshToken|access_token|refresh_token)/)
})
