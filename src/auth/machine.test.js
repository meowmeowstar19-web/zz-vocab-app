// auth-design.md §八 test matrix — the machine is a pure function, so no mocks:
// feed events, assert states + effect descriptors.
import { describe, it, expect } from 'vitest'
import {
  transition,
  initialState,
  STATUS,
  OTP_TTL_MS,
  ANON_MAX_ATTEMPTS,
  isReady,
  isRealAccount,
} from './machine.js'
import { defaultSnapshot } from './storage.js'

const NOW = 1_000_000
const realSession = (id = 'real1') => ({ user: { id, is_anonymous: false } })
const anonSession = (id = 'anon1') => ({ user: { id, is_anonymous: true } })

const snap = (over = {}) => ({ ...defaultSnapshot(), ...over })
const boot = (snapshot = snap(), now = NOW) =>
  transition(initialState(), { type: 'BOOT', snapshot, now })
const types = (effects) => effects.map((e) => e.type)
const find = (effects, type) => effects.find((e) => e.type === type)

// run a chain of events, returning the final {state, effects}
const run = (first, events) =>
  events.reduce((acc, ev) => transition(acc.state, ev), first)

/* ------------------------------------------------------------------ boot */
describe('boot × session × snapshot matrix', () => {
  it('BOOT starts getSession + watchdog and renders from lastUserScope (铁律8)', () => {
    const r = boot(snap({ lastUserScope: 'u_prev' }))
    expect(r.state.status).toBe(STATUS.INITIALIZING)
    expect(r.state.userScope).toBe('u_prev')
    expect(types(r.effects)).toEqual(['getSession', 'startWatchdog'])
    expect(isReady(r.state)).toBe(false)
  })

  it('valid real session → AUTHED, scope u_<uid>, snapshot updated', () => {
    const r = run(boot(), [{ type: 'SESSION_RESOLVED', session: realSession('abc') }])
    expect(r.state.status).toBe(STATUS.AUTHED)
    expect(r.state.userScope).toBe('u_abc')
    expect(isRealAccount(r.state)).toBe(true)
    const patch = find(r.effects, 'saveSnapshot').patch
    expect(patch.hadAccount).toBe(true)
    expect(patch.explicitLogout).toBe(false)
    expect(patch.lastUserScope).toBe('u_abc')
    expect(types(r.effects)).toContain('stopWatchdog')
  })

  it('anonymous session → GUEST_ANON with anon uid scope', () => {
    const r = run(boot(), [{ type: 'SESSION_RESOLVED', session: anonSession('g1') }])
    expect(r.state.status).toBe(STATUS.GUEST_ANON)
    expect(r.state.userScope).toBe('u_g1')
  })

  it('no session + fresh device → mint anon (GUEST_LEGACY minting, renderable)', () => {
    const r = run(boot(), [{ type: 'SESSION_RESOLVED', session: null }])
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(r.state.legacyReason).toBe('minting')
    expect(find(r.effects, 'mintAnon').attempt).toBe(1)
    expect(isReady(r.state)).toBe(true)
  })

  it('no session + explicitLogout → LOGGED_OUT, no anon mint', () => {
    const r = run(boot(snap({ explicitLogout: true, hadAccount: true })), [
      { type: 'SESSION_RESOLVED', session: null },
    ])
    expect(r.state.status).toBe(STATUS.LOGGED_OUT)
    expect(types(r.effects)).not.toContain('mintAnon')
  })

  it('delayed token refresh: watchdog fires first, late SESSION_RESOLVED still lands (铁律2)', () => {
    const mid = run(boot(snap({ lastUserScope: 'u_abc' })), [{ type: 'WATCHDOG_FIRED' }])
    expect(mid.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(isReady(mid.state)).toBe(true)
    expect(mid.state.userScope).toBe('u_abc') // still optimistic, no reshuffle
    const late = transition(mid.state, { type: 'SESSION_RESOLVED', session: realSession('abc') })
    expect(late.state.status).toBe(STATUS.AUTHED)
    expect(late.state.userScope).toBe('u_abc')
  })

  it('getSession rejection → GUEST_LEGACY, never a dead end (铁律3)', () => {
    const r = run(boot(), [{ type: 'SESSION_FAILED', error: new Error('net') }])
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(r.state.legacyReason).toBe('session-failed')
    expect(isReady(r.state)).toBe(true)
  })

  it('APP_RESUMED after session-failed retries getSession; after mint-failed retries mint', () => {
    const failed = run(boot(), [{ type: 'SESSION_FAILED' }])
    expect(types(transition(failed.state, { type: 'APP_RESUMED' }).effects)).toContain('getSession')

    const mintDead = run(boot(), [
      { type: 'SESSION_RESOLVED', session: null },
      { type: 'ANON_FAILED' },
      { type: 'ANON_FAILED' },
      { type: 'ANON_FAILED' },
    ])
    expect(mintDead.state.legacyReason).toBe('mint-failed')
    expect(types(transition(mintDead.state, { type: 'APP_RESUMED' }).effects)).toContain('mintAnon')
  })
})

/* ------------------------------------------------------------------- OTP */
describe('OTP flow', () => {
  const atOtp = () =>
    run(boot(), [
      { type: 'SESSION_RESOLVED', session: anonSession() },
      { type: 'OTP_REQUESTED', email: 'a@b.c', now: NOW },
    ])

  it('request → OTP_PENDING with expiresAt, snapshot carries otp + lastEmail', () => {
    const r = atOtp()
    expect(r.state.status).toBe(STATUS.OTP_PENDING)
    expect(r.state.otp).toEqual({ email: 'a@b.c', expiresAt: NOW + OTP_TTL_MS })
    const patch = find(r.effects, 'saveSnapshot').patch
    expect(patch.otp.email).toBe('a@b.c')
    expect(patch.lastEmail).toBe('a@b.c')
    expect(types(r.effects)).toContain('sendOtp')
  })

  it('verify → AUTHED, otp cleared, hadAccount set', () => {
    const r = transition(atOtp().state, { type: 'OTP_VERIFIED', session: realSession('u9') })
    expect(r.state.status).toBe(STATUS.AUTHED)
    expect(r.state.otp).toBeNull()
    const patch = find(r.effects, 'saveSnapshot').patch
    expect(patch).toMatchObject({ hadAccount: true, otp: null, lastEmail: 'a@b.c' })
  })

  it('OTP_EXIT restores the anon session if the flow consumed it (铁律5)', () => {
    // login-OTP clears the anon session before sending — model that
    const mid = transition(atOtp().state, { type: 'SIGNED_OUT', intentional: false })
    // (unintentional signout of anon during OTP is ignored — still pending)
    expect(mid.state.status).toBe(STATUS.OTP_PENDING)
    const noSession = { ...atOtp().state, session: null }
    const r = transition(noSession, { type: 'OTP_EXIT' })
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(types(r.effects)).toContain('ensureAnon')
    expect(find(r.effects, 'saveSnapshot').patch.otp).toBeNull()
  })

  it('OTP_EXIT never trusts the held anon session — always re-verifies (2026-07-06 bug)', () => {
    // requestOtp signs the supabase session out BEFORE sending; the machine
    // keeps the dead object as the merge identity, so the exit path must not
    // shortcut to GUEST_ANON on session truthiness.
    const r = transition(atOtp().state, { type: 'OTP_EXIT' })
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(types(r.effects)).toContain('ensureAnon')
  })

  it('OTP_EXIT re-mint folds the old anon scope into the new one (no wardrobe reset)', () => {
    const exited = transition(atOtp().state, { type: 'OTP_EXIT' })
    const r = transition(exited.state, { type: 'ANON_MINTED', session: anonSession('fresh9') })
    expect(r.state.status).toBe(STATUS.GUEST_ANON)
    expect(r.state.userScope).toBe('u_fresh9')
    expect(find(r.effects, 'mergeScopes')).toMatchObject({ from: 'u_anon1', to: 'u_fresh9', reason: 'remint' })
  })

  it('reload after a consumed session: boot re-mint inherits lastUserScope (no wardrobe reset)', () => {
    // the login-OTP flow killed the supabase session, then the page reloaded
    const r = run(boot(snap({ lastUserScope: 'u_anon1' })), [
      { type: 'SESSION_RESOLVED', session: null }, // nothing to restore → mint
      { type: 'ANON_MINTED', session: anonSession('fresh9') },
    ])
    expect(r.state.status).toBe(STATUS.GUEST_ANON)
    expect(find(r.effects, 'mergeScopes')).toMatchObject({ from: 'u_anon1', to: 'u_fresh9', reason: 'remint' })
  })

  it('kill mid-OTP, reopen, verify: the account is entered UNTOUCHED (no guest merge)', () => {
    // sign-in enters the account as-is — the guest scope stays where it is,
    // unrelated to the account (user decision 2026-07-07)
    const r = run(
      boot(snap({ lastUserScope: 'u_anon1', otp: { email: 'a@b.c', expiresAt: NOW + 1000 } }), NOW),
      [
        { type: 'SESSION_RESOLVED', session: null },
        { type: 'OTP_VERIFIED', session: realSession('acc1') },
      ],
    )
    expect(r.state.status).toBe(STATUS.AUTHED)
    expect(r.state.userScope).toBe('u_acc1')
    expect(types(r.effects)).not.toContain('mergeScopes')
  })

  it('OTP from the welcome page exits back to LOGGED_OUT', () => {
    const r = run(boot(snap({ explicitLogout: true })), [
      { type: 'SESSION_RESOLVED', session: null },
      { type: 'OTP_REQUESTED', email: 'a@b.c', now: NOW },
      { type: 'OTP_EXIT' },
    ])
    expect(r.state.status).toBe(STATUS.LOGGED_OUT)
  })

  it('boot with an EXPIRED snapshot otp = treated as exited (铁律1 regression)', () => {
    const r = boot(snap({ otp: { email: 'a@b.c', expiresAt: NOW - 1 } }), NOW)
    expect(r.state.status).toBe(STATUS.INITIALIZING) // normal boot, no stuck pane
    expect(r.state.otp).toBeNull()
    expect(find(r.effects, 'saveSnapshot').patch.otp).toBeNull()
  })

  it('boot with a LIVE snapshot otp restores the verify pane', () => {
    const r = boot(snap({ otp: { email: 'a@b.c', expiresAt: NOW + 1000 } }), NOW)
    expect(r.state.status).toBe(STATUS.OTP_PENDING)
    expect(r.state.otp.email).toBe('a@b.c')
    expect(isReady(r.state)).toBe(true)
  })

  it('resend keeps the original return target (guest, not LOGGED_OUT)', () => {
    const r = run(atOtp(), [
      { type: 'OTP_REQUESTED', email: 'a@b.c', now: NOW + 5000 },
      { type: 'OTP_EXIT' },
    ])
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY) // guest side, re-verifying
    expect(types(r.effects)).toContain('ensureAnon')
  })

  it('RESENT restarts the local OTP TTL to match the fresh server code', () => {
    const r = transition(atOtp().state, { type: 'RESENT', now: NOW + 5 * 60_000 })
    expect(r.state.status).toBe(STATUS.OTP_PENDING)
    expect(r.state.otp).toEqual({ email: 'a@b.c', expiresAt: NOW + 5 * 60_000 + OTP_TTL_MS })
    expect(find(r.effects, 'saveSnapshot').patch.otp.expiresAt).toBe(NOW + 5 * 60_000 + OTP_TTL_MS)
  })

  it('RESENT outside a pending flow is a no-op', () => {
    const g = run(boot(), [{ type: 'SESSION_RESOLVED', session: anonSession() }])
    const r = transition(g.state, { type: 'RESENT', now: NOW })
    expect(r.state).toBe(g.state)
    expect(r.effects).toEqual([])
  })

  it('verified in another tab: SESSION_RESOLVED(real) upgrades OTP_PENDING', () => {
    const r = transition(atOtp().state, { type: 'SESSION_RESOLVED', session: realSession() })
    expect(r.state.status).toBe(STATUS.AUTHED)
  })
})

/* -------------------------------------------------------- bind / OAuth */
describe('BINDING (sign-up bind + OAuth login round trip)', () => {
  const guest = () => run(boot(), [{ type: 'SESSION_RESOLVED', session: anonSession('g7') }])

  it('BIND_STARTED(google) writes the bind marker and redirects', () => {
    const r = transition(guest().state, {
      type: 'BIND_STARTED', provider: 'google', mode: 'bind', surface: 'gate', now: NOW,
    })
    expect(r.state.status).toBe(STATUS.BINDING)
    const patch = find(r.effects, 'saveSnapshot').patch
    expect(patch.bind).toMatchObject({ provider: 'google', surface: 'gate', mode: 'bind' })
    expect(patch.bind.expiresAt).toBeGreaterThan(NOW)
    expect(find(r.effects, 'oauthRedirect')).toMatchObject({ provider: 'google', mode: 'bind' })
  })

  it('BIND_STARTED(email) sends the email-change OTP instead of redirecting', () => {
    const r = transition(guest().state, {
      type: 'BIND_STARTED', provider: 'email', mode: 'bind', surface: 'gate', email: 'x@y.z', now: NOW,
    })
    expect(r.state.status).toBe(STATUS.BINDING)
    expect(find(r.effects, 'sendBindEmail').email).toBe('x@y.z')
    expect(types(r.effects)).not.toContain('oauthRedirect')
  })

  it('BIND_OK → AUTHED (same uid — the whole point of the bind path)', () => {
    const mid = transition(guest().state, {
      type: 'BIND_STARTED', provider: 'email', mode: 'bind', surface: 'gate', email: 'x@y.z', now: NOW,
    })
    const bound = { user: { id: 'g7', is_anonymous: false } } // uid unchanged
    const r = transition(mid.state, { type: 'BIND_OK', session: bound })
    expect(r.state.status).toBe(STATUS.AUTHED)
    expect(r.state.userScope).toBe('u_g7')
    expect(find(r.effects, 'saveSnapshot').patch.bind).toBeNull()
  })

  it('BIND_REJECTED(reason) → back to guest with the error pane armed', () => {
    const mid = transition(guest().state, {
      type: 'BIND_STARTED', provider: 'google', mode: 'bind', surface: 'gate', now: NOW,
    })
    const r = transition(mid.state, { type: 'BIND_REJECTED', reason: 'identity_already_exists' })
    expect(r.state.status).toBe(STATUS.GUEST_ANON) // anon session survived the rejection
    expect(r.state.bindError).toBe('identity_already_exists')
    expect(find(r.effects, 'saveSnapshot').patch.bind).toBeNull()
  })

  it('boot with a LIVE bind marker restores the pending pane, then BIND_OK lands', () => {
    const r0 = boot(snap({ bind: { provider: 'google', surface: 'gate', mode: 'bind', expiresAt: NOW + 1000 } }), NOW)
    expect(r0.state.status).toBe(STATUS.BINDING)
    expect(r0.state.bind.surface).toBe('gate')
    expect(isReady(r0.state)).toBe(true)
    const r1 = run(r0, [
      { type: 'SESSION_RESOLVED', session: realSession('g7') }, // recorded, still pending
      { type: 'BIND_OK', session: realSession('g7') },
    ])
    expect(r1.state.status).toBe(STATUS.AUTHED)
  })

  it('boot with an EXPIRED bind marker = plain boot (铁律1)', () => {
    const r = boot(snap({ bind: { provider: 'google', surface: 'gate', mode: 'bind', expiresAt: NOW - 1 } }), NOW)
    expect(r.state.status).toBe(STATUS.INITIALIZING)
    expect(find(r.effects, 'saveSnapshot').patch.bind).toBeNull()
  })

  it('silent cancel (no session upgrade, no error): back to guest quietly', () => {
    const r0 = boot(snap({ bind: { provider: 'google', surface: 'gate', mode: 'bind', expiresAt: NOW + 1000 } }), NOW)
    const r = run(r0, [
      { type: 'SESSION_RESOLVED', session: anonSession('g7') },
      { type: 'BIND_REJECTED', reason: null },
    ])
    expect(r.state.status).toBe(STATUS.GUEST_ANON)
    expect(r.state.bindError).toBeNull()
  })

  it('RESENT during an email bind refreshes the bind marker TTL', () => {
    const mid = transition(guest().state, {
      type: 'BIND_STARTED', provider: 'email', mode: 'bind', surface: 'gate', email: 'x@y.z', now: NOW,
    })
    const r = transition(mid.state, { type: 'RESENT', now: NOW + 5 * 60_000 })
    expect(r.state.status).toBe(STATUS.BINDING)
    expect(r.state.bind.expiresAt).toBe(NOW + 5 * 60_000 + 10 * 60_000)
    expect(find(r.effects, 'saveSnapshot').patch.bind.expiresAt).toBe(r.state.bind.expiresAt)
  })

  it('BIND_ERROR_CLEARED wipes the error pane through the machine (no side-channel)', () => {
    const mid = transition(guest().state, {
      type: 'BIND_STARTED', provider: 'google', mode: 'bind', surface: 'gate', now: NOW,
    })
    const rejected = transition(mid.state, { type: 'BIND_REJECTED', reason: 'identity_already_exists' })
    expect(rejected.state.bindError).toBe('identity_already_exists')
    const r = transition(rejected.state, { type: 'BIND_ERROR_CLEARED' })
    expect(r.state.bindError).toBeNull()
    expect(r.state.status).toBe(rejected.state.status)
    expect(r.effects).toEqual([])
    // and it is a no-op when there is nothing to clear
    const again = transition(r.state, { type: 'BIND_ERROR_CLEARED' })
    expect(again.state).toBe(r.state)
  })

  it('email-bind back button exits via OTP_EXIT (one shared exit, 铁律5)', () => {
    const mid = transition(guest().state, {
      type: 'BIND_STARTED', provider: 'email', mode: 'bind', surface: 'account', email: 'x@y.z', now: NOW,
    })
    const r = transition(mid.state, { type: 'OTP_EXIT' })
    expect(r.state.status).toBe(STATUS.GUEST_ANON)
    expect(r.state.bind).toBeNull()
  })

  it('OAuth LOGIN mode from the welcome page round-trips the same marker', () => {
    const out = run(boot(snap({ explicitLogout: true })), [
      { type: 'SESSION_RESOLVED', session: null },
      { type: 'BIND_STARTED', provider: 'google', mode: 'login', surface: 'welcome', now: NOW },
    ])
    expect(out.state.status).toBe(STATUS.BINDING)
    // …page reloads; new boot reads the marker back
    const marker = find(out.effects, 'saveSnapshot').patch.bind
    const back = run(boot(snap({ explicitLogout: true, bind: marker }), NOW + 60_000), [
      { type: 'SESSION_RESOLVED', session: realSession('new') },
      { type: 'BIND_OK', session: realSession('new') },
    ])
    expect(back.state.status).toBe(STATUS.AUTHED)
    expect(back.state.userScope).toBe('u_new')
    // welcome login = post-logout: the previous account's scope must NOT leak in
    expect(types(back.effects)).not.toContain('mergeScopes')
  })

  it('OAuth LOGIN from a live guest enters the account UNTOUCHED (no guest merge)', () => {
    // sign-in never folds the guest scope in; only the bind path carries
    // guest data into an account, and it keeps the uid (nothing to merge)
    const marker = { provider: 'google', surface: 'gate', mode: 'login', expiresAt: NOW + 1000 }
    const back = run(boot(snap({ lastUserScope: 'u_g7', bind: marker }), NOW), [
      { type: 'SESSION_RESOLVED', session: realSession('acc2') },
      { type: 'BIND_OK', session: realSession('acc2') },
    ])
    expect(back.state.status).toBe(STATUS.AUTHED)
    expect(back.state.userScope).toBe('u_acc2')
    expect(types(back.effects)).not.toContain('mergeScopes')
  })

  it('another-tab switch between two REAL accounts never merges their scopes', () => {
    const authedA = run(boot(), [{ type: 'SESSION_RESOLVED', session: realSession('A') }])
    const r = transition(authedA.state, { type: 'SESSION_RESOLVED', session: realSession('B') })
    expect(r.state.status).toBe(STATUS.AUTHED)
    expect(r.state.userScope).toBe('u_B')
    expect(types(r.effects)).not.toContain('mergeScopes')
  })
})

/* ----------------------------------------------------------- sign out */
describe('sign out & session death', () => {
  const authed = () => run(boot(), [{ type: 'SESSION_RESOLVED', session: realSession('u1') }])

  it('intentional signOut → LOGGED_OUT, explicitLogout persisted, supabase signed out (铁律6)', () => {
    const r = transition(authed().state, { type: 'SIGNED_OUT', intentional: true })
    expect(r.state.status).toBe(STATUS.LOGGED_OUT)
    expect(find(r.effects, 'saveSnapshot').patch.explicitLogout).toBe(true)
    expect(types(r.effects)).toContain('supabaseSignOut')
  })

  it('unintentional signout → re-mint + "session expired" notice (铁律4)', () => {
    const r = transition(authed().state, { type: 'SIGNED_OUT', intentional: false })
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(types(r.effects)).toContain('mintAnon')
    expect(find(r.effects, 'notify').kind).toBe('session-expired')
    expect(find(r.effects, 'saveSnapshot').patch.explicitLogout).toBe(false)
  })

  it('TOKEN_REFRESH_FAILED behaves like unintentional signout', () => {
    const r = transition(authed().state, { type: 'TOKEN_REFRESH_FAILED' })
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(find(r.effects, 'notify').kind).toBe('session-expired')
  })

  it('anon session death re-mints quietly (no notice)', () => {
    const g = run(boot(), [{ type: 'SESSION_RESOLVED', session: anonSession() }])
    const r = transition(g.state, { type: 'SIGNED_OUT', intentional: false })
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(types(r.effects)).not.toContain('notify')
  })

  it('the re-mint after an anon session death inherits the dead scope', () => {
    const r = run(boot(), [
      { type: 'SESSION_RESOLVED', session: anonSession('dead1') },
      { type: 'SIGNED_OUT', intentional: false },
      { type: 'ANON_MINTED', session: anonSession('fresh2') },
    ])
    expect(r.state.status).toBe(STATUS.GUEST_ANON)
    expect(find(r.effects, 'mergeScopes')).toMatchObject({ from: 'u_dead1', to: 'u_fresh2', reason: 'remint' })
  })
})

/* ------------------------------------------------------- anon minting */
describe('anonymous mint retry budget (铁律7)', () => {
  it('fail → retry with incremented attempt; exhausted → GUEST_LEGACY(mint-failed)', () => {
    let r = run(boot(), [{ type: 'SESSION_RESOLVED', session: null }])
    for (let a = 2; a <= ANON_MAX_ATTEMPTS; a++) {
      r = transition(r.state, { type: 'ANON_FAILED' })
      expect(find(r.effects, 'mintAnon').attempt).toBe(a)
    }
    r = transition(r.state, { type: 'ANON_FAILED' })
    expect(r.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(r.state.legacyReason).toBe('mint-failed')
    expect(r.effects).toEqual([])
  })

  it('mint success from legacy → GUEST_ANON + scope persisted (migration hook point)', () => {
    const r = run(boot(), [
      { type: 'SESSION_RESOLVED', session: null },
      { type: 'ANON_FAILED' },
      { type: 'ANON_MINTED', session: anonSession('fresh') },
    ])
    expect(r.state.status).toBe(STATUS.GUEST_ANON)
    expect(r.state.userScope).toBe('u_fresh')
    expect(find(r.effects, 'saveSnapshot').patch.lastUserScope).toBe('u_fresh')
  })
})

/* ------------------------------------------------------- guest chosen */
describe('LOGGED_OUT → GUEST_CHOSEN (welcome page "Guest Mode")', () => {
  it('mints a FRESH anon uid (new game), clears explicitLogout', () => {
    const out = run(boot(snap({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' })), [
      { type: 'SESSION_RESOLVED', session: null },
      { type: 'GUEST_CHOSEN' },
    ])
    expect(out.state.status).toBe(STATUS.GUEST_LEGACY)
    expect(out.state.userScope).toBe('guest') // old account scope untouched
    expect(types(out.effects)).toContain('mintAnon')
    expect(find(out.effects, 'saveSnapshot').patch.explicitLogout).toBe(false)
    const done = transition(out.state, { type: 'ANON_MINTED', session: anonSession('n2') })
    expect(done.state.status).toBe(STATUS.GUEST_ANON)
    expect(done.state.userScope).toBe('u_n2')
    // a fresh game was explicitly requested — nothing may be inherited
    expect(types(done.effects)).not.toContain('mergeScopes')
  })

  it('GUEST_CHOSEN outside LOGGED_OUT is a no-op', () => {
    const g = run(boot(), [{ type: 'SESSION_RESOLVED', session: anonSession() }])
    const r = transition(g.state, { type: 'GUEST_CHOSEN' })
    expect(r.state).toBe(g.state)
    expect(r.effects).toEqual([])
  })
})
