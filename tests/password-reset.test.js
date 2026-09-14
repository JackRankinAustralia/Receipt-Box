const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

function authBackend() {
  const calls = { resets: [], sessions: [], exchanges: [], updates: [] }
  const recoveredUser = { id: 'recovered-user', email: 'owner@example.com' }
  let currentSession = null
  return {
    calls,
    auth: {
      async resetPasswordForEmail(email, options) { calls.resets.push({ email, options }); return { error: null } },
      async setSession(session) { calls.sessions.push(session); currentSession = { ...session, user: recoveredUser }; return { data: { session: currentSession }, error: null } },
      async exchangeCodeForSession(code) { calls.exchanges.push(code); currentSession = { user: recoveredUser, access_token: 'exchanged-access', refresh_token: 'exchanged-refresh' }; return { data: { session: currentSession }, error: null } },
      async getSession() { return { data: { session: currentSession }, error: null } },
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

test('native password reset uses the ReceiptGo recovery scheme', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, { id: 'test-user', email: 'owner@example.com' })
  app.setNativePlugins({ App: {} })

  assert.equal(await app.call('sendPasswordReset'), true)
  assert.equal(db.calls.resets[0].options.redirectTo, 'receiptgo://reset-password')
})

test('native recovery URL establishes its Supabase session and enters reset mode', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  const url = 'receiptgo://reset-password#access_token=private-access&refresh_token=private-refresh&type=recovery'

  assert.equal(app.call('isNativeRecoveryUrl', url), true)
  assert.equal(await app.call('handleNativeRecoveryUrl', url), true)
  assert.equal(JSON.stringify(db.calls.sessions), JSON.stringify([{ access_token: 'private-access', refresh_token: 'private-refresh' }]))
  assert.equal(app.element('loginForm').classList.contains('hidden'), true)
  assert.equal(app.element('passwordRecoveryForm').classList.contains('hidden'), false)
  assert.doesNotMatch(app.element('gate').innerHTML + app.element('loginMsg').innerHTML, /private-access|private-refresh/)
})

test('legacy Receipt Box recovery links remain accepted', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  const url = 'receiptbox://reset-password#access_token=legacy-access&refresh_token=legacy-refresh&type=recovery'
  assert.equal(app.call('isNativeRecoveryUrl', url), true)
  assert.equal(await app.call('handleNativeRecoveryUrl', url), true)
  assert.equal(db.calls.sessions.length, 1)
  assert.equal(app.call('isNativeRecoveryUrl', 'receiptgo://other-path'), false)
})

test('Supabase PASSWORD_RECOVERY event enters the new-password form', () => {
  const app = loadApp()
  app.call('handleAuthStateChange', 'PASSWORD_RECOVERY', { user: { id: 'recovered-user' }, access_token: 'event-access', refresh_token: 'event-refresh' })
  assert.equal(app.element('loginForm').classList.contains('hidden'), true)
  assert.equal(app.element('passwordRecoveryForm').classList.contains('hidden'), false)
  assert.match(app.element('loginMsg').textContent, /Enter and confirm/)
})

test('a recovery event without a session cannot expose a usable reset form', () => {
  const app = loadApp()
  app.call('handleAuthStateChange', 'PASSWORD_RECOVERY', { user: { id: 'recovered-user' } })
  assert.equal(app.run('passwordRecoveryMode'), false)
  assert.equal(app.run('recoverySessionReady'), false)
})

test('native code-style recovery links exchange before exposing the reset form', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  assert.equal(await app.call('handleNativeRecoveryUrl', 'receiptgo://reset-password?code=private-code'), true)
  assert.deepEqual(db.calls.exchanges, ['private-code'])
  assert.equal(app.run('recoverySessionReady'), true)
  assert.equal(app.element('passwordRecoveryForm').classList.contains('hidden'), false)
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

test('Capacitor App handles cold-launch recovery and ignores a second link while the reset form is active', async () => {
  const app = loadApp(), db = authBackend()
  let listener
  const coldUrl = 'receiptgo://reset-password#access_token=cold-access&refresh_token=cold-refresh&type=recovery'
  app.setBackend(db, null)
  app.setNativePlugins({ App: {
    async addListener(name, callback) { assert.equal(name, 'appUrlOpen'); listener = callback },
    async getLaunchUrl() { return { url: coldUrl } }
  } })

  assert.equal(await app.call('setupNativeRecoveryLinks'), true)
  assert.equal(db.calls.sessions.length, 1)
  await listener({ url: 'receiptbox://reset-password#access_token=warm-access&refresh_token=warm-refresh&type=recovery' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(db.calls.sessions.length, 1)
})

test('Capacitor App handles a running-app legacy recovery link', async () => {
  const app = loadApp(), db = authBackend()
  let listener
  app.setBackend(db, null)
  app.setNativePlugins({ App: {
    async addListener(name, callback) { assert.equal(name, 'appUrlOpen'); listener = callback },
    async getLaunchUrl() { return null }
  } })
  assert.equal(await app.call('setupNativeRecoveryLinks'), true)
  await listener({ url: 'receiptbox://reset-password#access_token=warm-access&refresh_token=warm-refresh&type=recovery' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(db.calls.sessions.length, 1)
  assert.equal(app.run('recoverySessionReady'), true)
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
  assert.equal(app.run('recoveryDiagnostic'), 'expired_token')
})

test('password update is not attempted if the recovery session disappears', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  await app.call('handleNativeRecoveryUrl', 'receiptgo://reset-password#access_token=private-access&refresh_token=private-refresh&type=recovery')
  db.auth.getSession = async () => ({ data: { session: null }, error: null })
  app.element('recoveryPassword').value = 'new-password-123'
  app.element('recoveryPasswordConfirm').value = 'new-password-123'
  assert.equal(await app.call('submitRecoveryPassword'), false)
  assert.equal(db.calls.updates.length, 0)
  assert.equal(app.run('recoveryDiagnostic'), 'no_session')
  assert.match(app.element('loginMsg').innerHTML, /could not be updated/)
})

test('a rejected password update keeps friendly copy and records only a safe error category', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  await app.call('handleNativeRecoveryUrl', 'receiptgo://reset-password#access_token=private-access&refresh_token=private-refresh&type=recovery')
  db.auth.updateUser = async () => ({ data: null, error: { code: 'unexpected_auth_failure', message: 'private provider detail' } })
  app.element('recoveryPassword').value = 'new-password-123'
  app.element('recoveryPasswordConfirm').value = 'new-password-123'
  assert.equal(await app.call('submitRecoveryPassword'), false)
  assert.equal(app.run('recoveryDiagnostic'), 'update_user_error')
  assert.match(app.element('loginMsg').innerHTML, /could not be updated/)
  assert.doesNotMatch(app.element('loginMsg').innerHTML, /private provider detail|private-access|private-refresh/)
})

test('code exchange errors never open the recovery form or expose the code', async () => {
  const app = loadApp(), db = authBackend()
  app.setBackend(db, null)
  db.auth.exchangeCodeForSession = async () => ({ data: { session: null }, error: { code: 'invalid_grant' } })
  assert.equal(await app.call('handleNativeRecoveryUrl', 'receiptgo://reset-password?code=private-code'), false)
  assert.equal(app.run('recoveryDiagnostic'), 'invalid_recovery_token')
  assert.equal(app.run('passwordRecoveryMode'), false)
  assert.doesNotMatch(app.element('loginMsg').innerHTML, /private-code/)
})

test('recovery implementation never logs or renders token parameters', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\([^\n]*(?:accessToken|refreshToken|access_token|refresh_token)/)
  assert.doesNotMatch(source, /innerHTML\s*=\s*[^\n]*(?:accessToken|refreshToken|access_token|refresh_token)/)
})
