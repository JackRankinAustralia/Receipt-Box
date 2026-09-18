const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadApp } = require('./load-app')

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')

function signupBackend(result) {
  const calls = { signups: [], signins: [], resets: [] }
  return {
    calls,
    auth: {
      async signUp(attributes) {
        calls.signups.push(attributes)
        return typeof result === 'function' ? result(attributes) : result
      },
      async signInWithPassword(attributes) {
        calls.signins.push(attributes)
        return { data: { session: { user: { id: 'signed-in-user', email: attributes.email } } }, error: null }
      },
      async resetPasswordForEmail(email, options) {
        calls.resets.push({ email, options })
        return { error: null }
      }
    }
  }
}

function enterValidSignup(app) {
  app.element('signupEmail').value = '  new.user@example.com  '
  app.element('signupPassword').value = 'safe-password-123'
  app.element('signupPasswordConfirm').value = 'safe-password-123'
}

test('signed-out authentication offers a Create Account form and return to Sign In', () => {
  assert.match(html, /id="createAccountBtn"[^>]*>Create account</)
  assert.match(html, /id="createAccountForm" class="hidden"/)
  assert.match(html, /id="signupEmail"[^>]*type="email"/)
  assert.match(html, /id="signupPassword"[^>]*minlength="8"/)
  assert.match(html, /id="signupPasswordConfirm"[^>]*minlength="8"/)
  assert.match(html, /id="createAccountBackBtn"[^>]*>Back to sign in</)

  const app = loadApp()
  app.element('email').value = 'person@example.com'
  app.call('showCreateAccountForm')
  assert.equal(app.element('loginForm').classList.contains('hidden'), true)
  assert.equal(app.element('createAccountForm').classList.contains('hidden'), false)
  assert.equal(app.element('signupEmail').value, 'person@example.com')
  app.call('showSignInForm')
  assert.equal(app.element('loginForm').classList.contains('hidden'), false)
  assert.equal(app.element('createAccountForm').classList.contains('hidden'), true)
})

test('valid signup trims only the email and passes the password unchanged', async () => {
  const app = loadApp()
  const db = signupBackend({ data: { user: { id: 'pending-user' }, session: null }, error: null })
  app.setBackend(db, null)
  enterValidSignup(app)

  assert.equal(await app.call('createAccount'), true)
  assert.equal(JSON.stringify(db.calls.signups), JSON.stringify([{ email: 'new.user@example.com', password: 'safe-password-123' }]))
})

test('signup rejects blank or invalid email, short password, and password mismatch locally', async () => {
  const app = loadApp()
  const db = signupBackend({ data: {}, error: null })
  app.setBackend(db, null)

  app.element('signupEmail').value = 'not-an-email'
  app.element('signupPassword').value = 'safe-password-123'
  app.element('signupPasswordConfirm').value = 'safe-password-123'
  assert.equal(await app.call('createAccount'), false)
  assert.match(app.element('loginMsg').innerHTML, /valid email/i)

  app.element('signupEmail').value = 'person@example.com'
  app.element('signupPassword').value = 'short'
  app.element('signupPasswordConfirm').value = 'short'
  assert.equal(await app.call('createAccount'), false)
  assert.match(app.element('loginMsg').innerHTML, /at least 8/i)

  app.element('signupPassword').value = 'safe-password-123'
  app.element('signupPasswordConfirm').value = 'different-password'
  assert.equal(await app.call('createAccount'), false)
  assert.match(app.element('loginMsg').innerHTML, /do not match/i)
  assert.equal(db.calls.signups.length, 0)
})

test('duplicate signup submissions are blocked while the first request is in progress', async () => {
  let resolveSignup
  const pending = new Promise(resolve => { resolveSignup = resolve })
  const app = loadApp()
  const db = signupBackend(() => pending)
  app.setBackend(db, null)
  enterValidSignup(app)

  const first = app.call('createAccount')
  assert.equal(app.element('createAccountSubmitBtn').disabled, true)
  assert.equal(await app.call('createAccount'), false)
  assert.equal(db.calls.signups.length, 1)

  resolveSignup({ data: { user: { id: 'pending-user' }, session: null }, error: null })
  assert.equal(await first, true)
  assert.equal(app.element('createAccountSubmitBtn').disabled, false)
})

test('an immediate-session signup enters the normal authenticated app', async () => {
  const signedUpUser = { id: 'new-user', email: 'new.user@example.com' }
  const app = loadApp()
  const db = signupBackend({ data: { user: signedUpUser, session: { user: signedUpUser } }, error: null })
  let authenticatedUser = null
  app.setBackend(db, null)
  app.setFunction('startAuthenticatedSession', async user => { authenticatedUser = user })
  enterValidSignup(app)

  assert.equal(await app.call('createAccount'), true)
  assert.deepEqual(authenticatedUser, signedUpUser)
})

test('confirmation-required signup returns to Sign In with an accurate confirmation message', async () => {
  const app = loadApp()
  const db = signupBackend({ data: { user: { id: 'pending-user' }, session: null }, error: null })
  app.setBackend(db, null)
  app.call('showCreateAccountForm')
  enterValidSignup(app)

  assert.equal(await app.call('createAccount'), true)
  assert.equal(app.element('loginForm').classList.contains('hidden'), false)
  assert.equal(app.element('createAccountForm').classList.contains('hidden'), true)
  assert.equal(app.element('email').value, 'new.user@example.com')
  assert.match(app.element('loginMsg').innerHTML, /check your email to confirm/i)
  assert.equal(app.state().user, null)
})

test('Supabase signup errors are friendly and never log the submitted password', async () => {
  const app = loadApp()
  const db = signupBackend({ data: null, error: { code: 'over_email_send_rate_limit', message: 'Internal provider detail' } })
  app.setBackend(db, null)
  enterValidSignup(app)
  app.run('globalThis.signupLogs = []; console = { log: (...args) => signupLogs.push(args), warn: (...args) => signupLogs.push(args), error: (...args) => signupLogs.push(args) }')

  assert.equal(await app.call('createAccount'), false)
  assert.match(app.element('loginMsg').innerHTML, /wait a little while/i)
  assert.doesNotMatch(app.element('loginMsg').innerHTML, /Internal provider detail/)
  assert.doesNotMatch(app.run('JSON.stringify(signupLogs)'), /safe-password-123/)
})

test('existing Sign In and Forgot Password flows remain available', async () => {
  const app = loadApp()
  const db = signupBackend({ data: {}, error: null })
  let authenticatedUser = null
  app.setBackend(db, null)
  app.setFunction('startAuthenticatedSession', async user => { authenticatedUser = user })
  app.element('email').value = '  existing@example.com  '
  app.element('password').value = 'existing-password'

  await app.call('login')
  assert.equal(JSON.stringify(db.calls.signins), JSON.stringify([{ email: 'existing@example.com', password: 'existing-password' }]))
  assert.equal(authenticatedUser.id, 'signed-in-user')

  assert.equal(await app.call('sendSignedOutPasswordReset'), true)
  assert.equal(db.calls.resets.length, 1)
  assert.equal(db.calls.resets[0].email, 'existing@example.com')
})

test('new Auth users are database-seeded with the authoritative Free entitlement', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260821150000_add_free_pro_entitlements.sql'), 'utf8')
  assert.match(migration, /create trigger seed_receipt_box_user after insert on auth\.users/i)
  assert.match(migration, /insert into public\.user_entitlements[\s\S]*values \(new\.id, 'free', 'active', 'system'\)/i)
})
