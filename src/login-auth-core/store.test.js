// The blueprint §7 matrix: every anon-free behavior of the old machine.test.js
// re-asserted against the new 4-state core, plus the new-world rules (guest =
// pure local, onUpgrade only toward an account entered FROM the guest scope).
// The engine takes an injected client + clock, so no module mocks are needed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createAuthCore,
  OTP_TTL_MS,
  WATCHDOG_MS,
  UPGRADE_TIMEOUT_MS,
  OAUTH_CONCLUDE_TIMEOUT_MS,
  ACCOUNT_CREATED_WINDOW_MS,
} from './store.js'
import { saveSnapshot, SNAPSHOT_KEY } from './snapshot.js'

const NOW = 1_000_000
const realSession = (id = 'real1', email = null) => ({ user: { id, is_anonymous: false, email } })
const anonSession = (id = 'anon1') => ({ user: { id, is_anonymous: true } })

function fakeLS() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()],
  }
}

// controllable supabase.auth fake
function fakeClient() {
  const calls = { signInWithOtp: [], verifyOtp: [], signInWithOAuth: [], signOut: 0, getSession: 0 }
  let authCb = null
  let getSessionImpl = async () => ({ data: { session: null } })
  let otpResult = { error: null }
  let verifyResult = { data: { session: realSession('u9') }, error: null }
  let oauthResult = { error: null }
  const client = {
    auth: {
      getSession: () => {
        calls.getSession++
        return getSessionImpl()
      },
      onAuthStateChange: (cb) => {
        authCb = cb
        return { data: { subscription: { unsubscribe() {} } } }
      },
      signInWithOtp: async (args) => {
        calls.signInWithOtp.push(args)
        return otpResult
      },
      verifyOtp: async (args) => {
        calls.verifyOtp.push(args)
        return verifyResult
      },
      signInWithOAuth: async (args) => {
        calls.signInWithOAuth.push(args)
        return oauthResult
      },
      signOut: async () => {
        calls.signOut++
        return { error: null }
      },
    },
  }
  return {
    client,
    calls,
    fire: (event, session = null) => authCb?.(event, session),
    setSession: (s) => { getSessionImpl = async () => ({ data: { session: s } }) },
    failSession: () => { getSessionImpl = async () => { throw new Error('net') } },
    // supabase-js's weak-net shape: an expired access token whose refresh call
    // couldn't reach the server resolves (not rejects) with session:null + error
    errorSession: () => { getSessionImpl = async () => ({ data: { session: null }, error: new Error('fetch failed') }) },
    hangSession: () => { getSessionImpl = () => new Promise(() => {}) },
    setOtpResult: (r) => { otpResult = r },
    setVerifyResult: (r) => { verifyResult = r },
  }
}

// drain the microtask queue (getSession .then chains, enterAccount awaits)
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

const snapshotOnDisk = () => JSON.parse(globalThis.localStorage.getItem(SNAPSHOT_KEY))

let clock
const now = () => clock

const makeCore = (fc, { onUpgrade } = {}) =>
  createAuthCore({ client: fc.client, onUpgrade, now })

beforeEach(() => {
  globalThis.localStorage = fakeLS()
  clock = NOW
})
afterEach(() => {
  vi.useRealTimers()
  // stubbed browser globals (see the browser-environment suite) must never
  // leak into the node-env tests
  delete globalThis.window
  delete globalThis.document
})

// minimal window/document stubs — vitest runs in node (no jsdom), so the boot
// paths that read the URL, listen for pageshow (bfcache) or visibilitychange
// are exercised through these instead of a full DOM.
function stubBrowser({ search = '', hash = '' } = {}) {
  const winListeners = {}
  const docListeners = {}
  const replaceStateCalls = []
  globalThis.window = {
    location: { search, hash, origin: 'https://app.test', pathname: '/' },
    history: { replaceState: (...a) => replaceStateCalls.push(a) },
    addEventListener: (t, cb) => { (winListeners[t] ??= []).push(cb) },
  }
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener: (t, cb) => { (docListeners[t] ??= []).push(cb) },
  }
  return {
    replaceStateCalls,
    fireWindow: (t, e = {}) => winListeners[t]?.forEach((cb) => cb(e)),
    fireDoc: (t) => docListeners[t]?.forEach((cb) => cb()),
  }
}

/* ------------------------------------------------------------------ boot */
describe('boot × session × snapshot matrix', () => {
  it('boot renders optimistically from lastUserScope while loading (铁律8)', () => {
    saveSnapshot({ lastUserScope: 'u_prev' }, NOW)
    const fc = fakeClient()
    fc.hangSession()
    const core = makeCore(fc)
    core.boot()
    const s = core.getState()
    expect(s.status).toBe('loading')
    expect(s.scope).toBe('u_prev')
  })

  it('real session → account, scope u_<uid>, snapshot updated', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('abc'))
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('account')
    expect(s.scope).toBe('u_abc')
    expect(s.atWelcome).toBe(false)
    const disk = snapshotOnDisk()
    expect(disk.hadAccount).toBe(true)
    expect(disk.explicitLogout).toBe(false)
    expect(disk.lastUserScope).toBe('u_abc')
  })

  it('no session + fresh device → playing guest, ZERO server identity (no mint, no signOut)', async () => {
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(false)
    expect(s.scope).toBe('guest')
    expect(snapshotOnDisk().lastUserScope).toBe('guest')
    expect(fc.calls.signOut).toBe(0) // nothing server-side happened at all
  })

  it('no session + explicitLogout → welcome gate (not a guest game)', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.scope).toBe('u_old') // account cache renders behind the gate
  })

  it('returning REAL account whose token fails to resolve → welcome gate, cache scope intact, NO notice (iOS PWA silent-logout bug, 2026-07-15)', async () => {
    saveSnapshot({ hadAccount: true, lastUserScope: 'u_me' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.scope).toBe('u_me') // u_me cache untouched, one re-login restores it
    expect(s.notice).toBeNull()
    expect(snapshotOnDisk().lastUserScope).toBe('u_me') // NOT demoted to guest
  })

  it('returning GUEST boots straight into its sandbox (hadAccount false)', async () => {
    saveSnapshot({ hadAccount: false, lastUserScope: 'guest' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(false)
    expect(s.scope).toBe('guest')
  })

  it('watchdog: getSession hangs → renderable guest under the optimistic scope ≤4s; a late real session still lands (铁律2)', async () => {
    vi.useFakeTimers()
    saveSnapshot({ lastUserScope: 'u_abc', hadAccount: true }, NOW)
    const fc = fakeClient()
    fc.hangSession()
    const core = makeCore(fc)
    core.boot()
    expect(core.getState().status).toBe('loading')
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS)
    let s = core.getState()
    expect(s.status).toBe('guest') // ready, degraded
    expect(s.scope).toBe('u_abc') // still optimistic, no reshuffle
    expect(s.atWelcome).toBe(false) // still resolving — don't flash the gate
    // useAuth.isAccountScope is derived from exactly this. The app MUST read it
    // (not isRealAccount) for anything that follows the data: this degraded
    // guest is playing out of the ACCOUNT's drawer, so it must be labelled with
    // the account's name and its mutations must still be logged for the server.
    // (2026-07-20 — both were wrong here: "Guest" over the account's coins, and
    // a check-in claimed in this window never reached the server. See
    // identity.test.js and data/economy.js's serverAuthoritative.)
    expect(s.scope.startsWith('u_')).toBe(true)
    fc.fire('SIGNED_IN', realSession('abc'))
    await vi.runAllTimersAsync()
    s = core.getState()
    expect(s.status).toBe('account')
    expect(s.scope).toBe('u_abc')
  })

  it('getSession NETWORK failure with an account snapshot → degraded play under the optimistic scope, NOT the welcome gate', async () => {
    // 2026-08 弱网 bug: a network-failed check is an UNDECIDED verdict — the
    // refresh token is still on disk. Dumping to the gate made the user (or
    // WeChat's auto-chooseGuest) flip into the guest sandbox mid-session and
    // see foreign progress; the account came back only on a later relaunch.
    saveSnapshot({ hadAccount: true, lastUserScope: 'u_me' }, NOW)
    const fc = fakeClient()
    fc.failSession()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest') // renderable (铁律3), degraded
    expect(s.atWelcome).toBe(false) // NOT the gate — nothing was decided
    expect(s.scope).toBe('u_me') // still the account's drawer
  })

  it('network-failed verdict retries in the background and a late success enters the account (same scope, no remount)', async () => {
    vi.useFakeTimers()
    saveSnapshot({ hadAccount: true, lastUserScope: 'u_me' }, NOW)
    const fc = fakeClient()
    fc.errorSession() // resolve-with-error shape (expired token, refresh unreachable)
    const core = makeCore(fc)
    core.boot()
    await vi.runOnlyPendingTimersAsync()
    expect(core.getState().status).toBe('guest')
    expect(core.getState().scope).toBe('u_me')
    const asksBefore = fc.calls.getSession
    // network recovers before the next retry fires
    fc.setSession(realSession('me'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fc.calls.getSession).toBeGreaterThan(asksBefore) // it re-asked on its own
    const s = core.getState()
    expect(s.status).toBe('account')
    expect(s.scope).toBe('u_me')
  })

  it('network failure after an explicit logout still lands on the welcome gate', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    fc.failSession()
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('guest')
    expect(core.getState().atWelcome).toBe(true) // the user chose to be logged out
  })

  it('an anonymous residue session (pre-rewrite build) is discarded: guest + server signOut', async () => {
    const fc = fakeClient()
    fc.setSession(anonSession('g1'))
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.scope).toBe('guest')
    expect(fc.calls.signOut).toBe(1) // residue dropped
  })

  it('a null late-resolution never demotes a live account UI', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('abc'))
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('account')
    fc.fire('SIGNED_IN', null) // event without a session is ignored
    await tick()
    expect(core.getState().status).toBe('account')
  })
})

/* ------------------------------------------------------------------- OTP */
describe('email OTP flow (sign-up and log-in are ONE path)', () => {
  const bootAsGuest = async (fc, opts) => {
    const core = makeCore(fc, opts)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('guest')
    return core
  }

  it('startEmail → authenticating, flow + lastEmail persisted, shouldCreateUser:true', async () => {
    const fc = fakeClient()
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    const s = core.getState()
    expect(s.status).toBe('authenticating')
    expect(s.flow).toEqual({ kind: 'otp', email: 'a@b.c', surface: 'gate', expiresAt: NOW + OTP_TTL_MS })
    const disk = snapshotOnDisk()
    expect(disk.flow.email).toBe('a@b.c')
    expect(disk.lastEmail).toBe('a@b.c')
    expect(fc.calls.signInWithOtp[0].email).toBe('a@b.c')
    expect(fc.calls.signInWithOtp[0].options.shouldCreateUser).toBe(true)
  })

  it('send failure → throws, returns to where it came from, flow cleared', async () => {
    const fc = fakeClient()
    fc.setOtpResult({ error: new Error('rate limited') })
    const core = await bootAsGuest(fc)
    await expect(core.startEmail('a@b.c', { surface: 'gate' })).rejects.toThrow('rate limited')
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(false) // gate surface → back to the playing guest
    expect(s.flow).toBeNull()
    expect(snapshotOnDisk().flow).toBeNull()
  })

  it('a THROWN send failure (transport layer) also returns the flow to its origin — no phantom marker', async () => {
    const fc = fakeClient()
    fc.client.auth.signInWithOtp = async () => { throw new Error('fetch failed') }
    const core = await bootAsGuest(fc)
    await expect(core.startEmail('a@b.c', { surface: 'gate' })).rejects.toThrow('fetch failed')
    expect(core.getState().status).toBe('guest')
    expect(core.getState().flow).toBeNull()
    expect(snapshotOnDisk().flow).toBeNull() // no resurrected verify pane for an unsent code
  })

  it('verifyEmail → account; verifyOtp uses type "email"; flow cleared; hadAccount + lastEmail persisted', async () => {
    const fc = fakeClient()
    fc.setVerifyResult({ data: { session: realSession('u9') }, error: null })
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    await core.verifyEmail('123456')
    const s = core.getState()
    expect(s.status).toBe('account')
    expect(s.scope).toBe('u_u9')
    expect(s.flow).toBeNull()
    expect(fc.calls.verifyOtp[0]).toEqual({ email: 'a@b.c', token: '123456', type: 'email' })
    const disk = snapshotOnDisk()
    expect(disk).toMatchObject({ hadAccount: true, flow: null, lastEmail: 'a@b.c', lastUserScope: 'u_u9' })
  })

  it('a wrong code throws and the pane stays up', async () => {
    const fc = fakeClient()
    fc.setVerifyResult({ data: null, error: new Error('invalid') })
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    await expect(core.verifyEmail('000000')).rejects.toThrow('invalid')
    expect(core.getState().status).toBe('authenticating')
    expect(core.getState().flow?.email).toBe('a@b.c')
  })

  it('exitFlow: back/close returns a gate-surface flow to the playing guest', async () => {
    const fc = fakeClient()
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    core.exitFlow()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(false)
    expect(s.flow).toBeNull()
    expect(snapshotOnDisk().flow).toBeNull()
  })

  it('exitFlow: a welcome-surface flow returns to the welcome gate', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().atWelcome).toBe(true)
    await core.startEmail('a@b.c', { surface: 'welcome' })
    core.exitFlow()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.scope).toBe('u_old') // the gate still fronts the account cache
  })

  it('exitFlow outside a live flow is a no-op (welcome gate never dumped into guest mode)', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const before = core.getState()
    core.exitFlow()
    expect(core.getState()).toBe(before)
  })

  it('resendEmail restarts the local TTL to match the fresh server code', async () => {
    const fc = fakeClient()
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    clock = NOW + 5 * 60_000
    await core.resendEmail()
    expect(core.getState().flow.expiresAt).toBe(NOW + 5 * 60_000 + OTP_TTL_MS)
    expect(snapshotOnDisk().flow.expiresAt).toBe(NOW + 5 * 60_000 + OTP_TTL_MS)
    expect(fc.calls.signInWithOtp).toHaveLength(2) // a REAL resend, not a silent 200
  })

  /* --------------------------------------------- the merged door's signal */
  // ONE door by design (蓝图 §11): a registered address signs in, a new one
  // gets an account, and NO up-front error can say "you already have / don't
  // have an account". The honest signal moved to ARRIVAL: entering a
  // brand-new account (created_at inside the window) raises
  // notice:'account-created' — the mistyped-email rescue.

  it('verifying into a BRAND-NEW account raises the account-created notice', async () => {
    const fc = fakeClient()
    fc.setVerifyResult({
      data: { session: { user: { id: 'u9', is_anonymous: false, created_at: new Date(NOW - 60_000).toISOString() } } },
      error: null,
    })
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    await core.verifyEmail('123456')
    const s = core.getState()
    expect(s.status).toBe('account')
    expect(s.notice).toBe('account-created')
  })

  it('verifying into an EXISTING account (old created_at) raises the welcome-back notice', async () => {
    const fc = fakeClient()
    fc.setVerifyResult({
      data: { session: { user: { id: 'u9', is_anonymous: false, created_at: new Date(NOW - ACCOUNT_CREATED_WINDOW_MS - 1000).toISOString() } } },
      error: null,
    })
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    await core.verifyEmail('123456')
    const s = core.getState()
    expect(s.status).toBe('account')
    expect(s.notice).toBe('welcome-back') // returning to an existing account greets, not "created"
  })

  it('a session without created_at fails safe: welcome-back (a flow arrival is never a false "account-created")', async () => {
    const fc = fakeClient()
    const core = await bootAsGuest(fc) // default verifyResult: realSession('u9'), no created_at
    await core.startEmail('a@b.c', { surface: 'gate' })
    await core.verifyEmail('123456')
    expect(core.getState().status).toBe('account')
    expect(core.getState().notice).toBe('welcome-back') // not confidently brand-new → friendly default
  })

  it('a plain reload of a young account (no login flow) does not re-raise the notice', async () => {
    saveSnapshot({ hadAccount: true, lastUserScope: 'u_u9' }, NOW)
    const fc = fakeClient()
    fc.setSession({ user: { id: 'u9', is_anonymous: false, created_at: new Date(NOW - 60_000).toISOString() } })
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('account')
    expect(core.getState().notice).toBeNull() // created 1min ago, but this is a reload, not an arrival
  })

  it('a plain reload of an EXISTING account (no login flow) does NOT greet welcome-back', async () => {
    saveSnapshot({ hadAccount: true, lastUserScope: 'u_u9' }, NOW)
    const fc = fakeClient()
    fc.setSession({ user: { id: 'u9', is_anonymous: false, created_at: new Date(NOW - ACCOUNT_CREATED_WINDOW_MS - 1000).toISOString() } })
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('account')
    expect(core.getState().notice).toBeNull() // a reload/relaunch is not an arrival — welcome-back only greets an actual login
  })

  it('logout → relogin of the SAME fresh account → welcome-back, not a second account-created', async () => {
    const fc = fakeClient()
    fc.setVerifyResult({
      data: { session: { user: { id: 'u9', is_anonymous: false, created_at: new Date(NOW - 60_000).toISOString() } } },
      error: null,
    })
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    await core.verifyEmail('123456')
    expect(core.getState().notice).toBe('account-created') // first arrival announces creation
    core.clearNotice()
    core.signOut()
    await core.startEmail('a@b.c', { surface: 'welcome' })
    await core.verifyEmail('123456')
    await tick()
    expect(core.getState().status).toBe('account')
    expect(core.getState().notice).toBe('welcome-back') // u_u9 already committed → not "created" again, but a return still greets
  })

  it('a mistyped relogin from the welcome gate (new uid) still announces (the rescue signal)', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    fc.setVerifyResult({
      data: { session: { user: { id: 'ghost', is_anonymous: false, created_at: new Date(NOW - 30_000).toISOString() } } },
      error: null,
    })
    const core = makeCore(fc)
    core.boot()
    await tick()
    await core.startEmail('typo@b.c', { surface: 'welcome' })
    await core.verifyEmail('123456')
    expect(core.getState().status).toBe('account')
    expect(core.getState().notice).toBe('account-created') // the player sees WHY it looks empty
  })

  it('boot with a LIVE flow marker restores the verify pane (铁律1)', async () => {
    saveSnapshot({ flow: { kind: 'otp', email: 'a@b.c', surface: 'gate', expiresAt: NOW + 1000 } }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('authenticating')
    expect(s.flow.email).toBe('a@b.c')
  })

  it('boot with an EXPIRED flow marker = plain boot (铁律1 regression)', async () => {
    saveSnapshot({ flow: { kind: 'otp', email: 'a@b.c', surface: 'gate', expiresAt: NOW - 1 } }, NOW - 10)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.flow).toBeNull()
  })

  it('kill mid-OTP, reopen, verify: the restored pane still verifies with the in-flight email', async () => {
    saveSnapshot({ flow: { kind: 'otp', email: 'a@b.c', surface: 'gate', expiresAt: NOW + 1000 } }, NOW)
    const fc = fakeClient()
    fc.setVerifyResult({ data: { session: realSession('acc1') }, error: null })
    const core = makeCore(fc)
    core.boot()
    await tick()
    await core.verifyEmail('123456')
    expect(fc.calls.verifyOtp[0].email).toBe('a@b.c') // recovered from the flow, not blank
    expect(core.getState().status).toBe('account')
    expect(core.getState().scope).toBe('u_acc1')
  })

  it('verified in another tab: a real session event upgrades the pending flow', async () => {
    const fc = fakeClient()
    const core = await bootAsGuest(fc)
    await core.startEmail('a@b.c', { surface: 'gate' })
    fc.fire('SIGNED_IN', realSession('u7'))
    await tick()
    expect(core.getState().status).toBe('account')
    expect(core.getState().scope).toBe('u_u7')
  })
})

/* --------------------------------------------- onUpgrade (the ONE bridge) */
describe('onUpgrade — fired only toward an account entered FROM the guest scope', () => {
  it('guest signs up/logs in → onUpgrade({fromScope:"guest", toScope}) awaited BEFORE status flips', async () => {
    const fc = fakeClient()
    fc.setVerifyResult({ data: { session: realSession('new1') }, error: null })
    const seen = []
    let statusWhenUpgrading = null
    const core = makeCore(fc, {
      onUpgrade: async (arg) => {
        seen.push(arg)
        statusWhenUpgrading = core.getState().status
      },
    })
    core.boot()
    await tick()
    await core.startEmail('a@b.c', { surface: 'gate' })
    await core.verifyEmail('123456')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ fromScope: 'guest', toScope: 'u_new1' })
    expect(statusWhenUpgrading).not.toBe('account') // seed lands before the remount
    expect(core.getState().status).toBe('account')
  })

  it('fresh device (lastUserScope null) counts as guest — onUpgrade fires', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('n2'))
    const seen = []
    const core = makeCore(fc, { onUpgrade: (arg) => { seen.push(arg) } })
    core.boot()
    await tick()
    expect(seen).toHaveLength(1)
    expect(seen[0].toScope).toBe('u_n2')
  })

  it('login from the welcome gate after logout (lastUserScope u_old) → onUpgrade NOT fired (guest sandbox untouched)', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    fc.setVerifyResult({ data: { session: realSession('u_back') }, error: null })
    const seen = []
    const core = makeCore(fc, { onUpgrade: (arg) => { seen.push(arg) } })
    core.boot()
    await tick()
    await core.startEmail('a@b.c', { surface: 'welcome' })
    await core.verifyEmail('123456')
    expect(core.getState().status).toBe('account')
    expect(seen).toHaveLength(0)
  })

  it('another-tab switch between two REAL accounts never fires onUpgrade', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('A'))
    const seen = []
    const core = makeCore(fc, { onUpgrade: (arg) => { seen.push(arg) } })
    core.boot()
    await tick()
    seen.length = 0 // drop the boot-from-fresh-device upgrade
    fc.fire('SIGNED_IN', realSession('B'))
    await tick()
    expect(core.getState().scope).toBe('u_B')
    expect(seen).toHaveLength(0) // lastUserScope was u_A
  })

  it('a rejecting onUpgrade never blocks login (best-effort seed)', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('x1'))
    const core = makeCore(fc, { onUpgrade: async () => { throw new Error('rpc down') } })
    core.boot()
    await tick()
    expect(core.getState().status).toBe('account')
  })

  it('duplicate session events do not double-fire onUpgrade', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('d1'))
    const seen = []
    const core = makeCore(fc, { onUpgrade: async (arg) => { seen.push(arg); await tick() } })
    core.boot()
    fc.fire('SIGNED_IN', realSession('d1')) // INITIAL_SESSION-style duplicate
    await tick(30)
    expect(core.getState().status).toBe('account')
    expect(seen).toHaveLength(1)
  })
})

/* ---------------------------------------------------------------- OAuth */
describe('Google OAuth round trip', () => {
  it('loginWithGoogle persists the flow marker and calls signInWithOAuth (select_account)', async () => {
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    await core.loginWithGoogle({ surface: 'gate' })
    const s = core.getState()
    expect(s.status).toBe('authenticating')
    expect(s.flow).toMatchObject({ kind: 'oauth', provider: 'google', surface: 'gate' })
    expect(snapshotOnDisk().flow).toMatchObject({ kind: 'oauth', surface: 'gate' })
    expect(fc.calls.signInWithOAuth[0].provider).toBe('google')
    expect(fc.calls.signInWithOAuth[0].options.queryParams).toEqual({ prompt: 'select_account' })
  })

  it('coming home with a real session → account (the pending pane concluded)', async () => {
    saveSnapshot({ flow: { kind: 'oauth', provider: 'google', surface: 'gate', expiresAt: NOW + 1000 }, lastUserScope: 'guest' }, NOW)
    const fc = fakeClient()
    fc.setSession(realSession('g7'))
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('account')
    expect(s.scope).toBe('u_g7')
    expect(s.flow).toBeNull()
    expect(snapshotOnDisk().flow).toBeNull()
  })

  it('coming home with NO session and no auth params → silent cancel back to the surface', async () => {
    saveSnapshot({ flow: { kind: 'oauth', provider: 'google', surface: 'welcome', expiresAt: NOW + 1000 }, explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true) // welcome-launched → back to welcome, not a guest game
    expect(s.error).toBeNull() // silent
    expect(s.flow).toBeNull()
  })

  it('welcome-page OAuth rejected with a reason → welcome gate with the error pane armed', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    fc.client.auth.signInWithOAuth = async () => ({ error: new Error('nope') })
    const core = makeCore(fc)
    core.boot()
    await tick()
    await core.loginWithGoogle({ surface: 'welcome' })
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.error).toBe('nope')
  })

  it('clearError wipes the error pane and nothing else', async () => {
    const fc = fakeClient()
    fc.client.auth.signInWithOAuth = async () => ({ error: new Error('identity_already_exists') })
    const core = makeCore(fc)
    core.boot()
    await tick()
    await core.loginWithGoogle({ surface: 'gate' })
    expect(core.getState().error).toBe('identity_already_exists')
    const status = core.getState().status
    core.clearError()
    expect(core.getState().error).toBeNull()
    expect(core.getState().status).toBe(status)
  })

  it('boot with an EXPIRED oauth marker = plain boot (铁律1)', async () => {
    saveSnapshot({ flow: { kind: 'oauth', provider: 'google', surface: 'gate', expiresAt: NOW - 1 } }, NOW - 10)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('guest')
    expect(core.getState().flow).toBeNull()
  })
})

/* ----------------------------------------------------------- sign out */
describe('sign out & session death', () => {
  const bootAuthed = async (uid = 'u1') => {
    const fc = fakeClient()
    fc.setSession(realSession(uid))
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('account')
    return { fc, core }
  }

  it('intentional signOut → welcome gate, explicitLogout persisted, supabase signed out (铁律6)', async () => {
    const { fc, core } = await bootAuthed()
    core.signOut()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.session).toBeNull()
    expect(s.scope).toBe('u_u1') // cache renders behind the gate, untouched
    expect(snapshotOnDisk().explicitLogout).toBe(true)
    expect(fc.calls.signOut).toBe(1)
  })

  it('our own signOut does not double back through the SIGNED_OUT event as "unintentional"', async () => {
    const { fc, core } = await bootAuthed()
    core.signOut()
    fc.fire('SIGNED_OUT') // supabase echoes the sign-out
    await tick()
    expect(core.getState().notice).toBeNull() // no "session expired" for a chosen logout
    expect(snapshotOnDisk().explicitLogout).toBe(true)
  })

  it('unintentional SIGNED_OUT → welcome gate + "session-expired" notice; u_<uid> cache untouched', async () => {
    const { fc, core } = await bootAuthed('me')
    fc.fire('SIGNED_OUT')
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.notice).toBe('session-expired')
    expect(s.scope).toBe('u_me') // recoverable with one re-login
    expect(snapshotOnDisk().explicitLogout).toBe(false)
    expect(snapshotOnDisk().lastUserScope).toBe('u_me')
  })

  it('defensive TOKEN_REFRESH_FAILED (auth-js 2.x never emits it — the real path is SIGNED_OUT, tested above) → same gate + notice', async () => {
    const { fc, core } = await bootAuthed('me')
    fc.fire('TOKEN_REFRESH_FAILED')
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.notice).toBe('session-expired')
  })

  it('SIGNED_OUT while already a guest is ignored (nothing to die)', async () => {
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const before = core.getState()
    fc.fire('SIGNED_OUT')
    await tick()
    expect(core.getState()).toBe(before)
  })

  it('clearNotice dismisses the banner', async () => {
    const { fc, core } = await bootAuthed('me')
    fc.fire('SIGNED_OUT')
    await tick()
    core.clearNotice()
    expect(core.getState().notice).toBeNull()
  })

  it('re-entering an account moots an unconsumed session-expired notice, replacing it with welcome-back', async () => {
    const { fc, core } = await bootAuthed('me')
    fc.fire('SIGNED_OUT')
    await tick()
    expect(core.getState().notice).toBe('session-expired')
    // re-login of the same old account straight from the gate, notice unconsumed
    fc.setVerifyResult({ data: { session: realSession('me') }, error: null })
    await core.startEmail('a@b.c', { surface: 'welcome' })
    await core.verifyEmail('123456')
    expect(core.getState().status).toBe('account')
    expect(core.getState().notice).toBe('welcome-back') // stale session-expired mooted; the return greeting takes its place
  })
})

/* ------------------------------------------------------- guest chosen */
describe('welcome gate → Guest Mode', () => {
  it('enters the persistent device guest sandbox, clears explicitLogout', async () => {
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().atWelcome).toBe(true)
    core.chooseGuest()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(false)
    expect(s.scope).toBe('guest') // old account scope untouched, guest sandbox on
    const disk = snapshotOnDisk()
    expect(disk.explicitLogout).toBe(false)
    expect(disk.lastUserScope).toBe('guest')
  })

  it('chooseGuest outside the welcome gate is a no-op', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('u1'))
    const core = makeCore(fc)
    core.boot()
    await tick()
    const before = core.getState()
    core.chooseGuest()
    expect(core.getState()).toBe(before)
  })

  it('logout → Guest Mode → the same guest sandbox (never wiped by an account trip)', async () => {
    // the guest drawer holds data; log in (no merge), log out, choose guest —
    // the drawer must be exactly where it was (Plan B: data never moves on login)
    globalThis.localStorage.setItem('guest.miraclezz.coins.v5', '77')
    saveSnapshot({ explicitLogout: true, hadAccount: true, lastUserScope: 'u_acc' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    core.chooseGuest()
    expect(core.getState().scope).toBe('guest')
    expect(globalThis.localStorage.getItem('guest.miraclezz.coins.v5')).toBe('77')
  })
})

/* --------------------------------------------- upgrade retry semantics */
describe('onUpgrade failure → retried on the next entry, never silently forfeited', () => {
  it('rejecting onUpgrade: login proceeds but lastUserScope stays guest; re-entry re-fires the upgrade', async () => {
    const fc = fakeClient()
    fc.setSession(realSession('n1'))
    const calls = []
    const core = makeCore(fc, {
      onUpgrade: async ({ toScope }) => {
        calls.push(toScope)
        if (calls.length === 1) throw new Error('server down')
      },
    })
    core.boot()
    await tick()
    expect(core.getState().status).toBe('account') // login itself never blocked
    expect(calls).toEqual(['u_n1'])
    // NOT advanced to u_n1 — retry armed (a fresh device's snapshot holds null,
    // which the cameFromGuest judgment treats as guest)
    expect(snapshotOnDisk().lastUserScope).not.toBe('u_n1')
    // sign out, log back into the same account → the seed gets its second chance
    core.signOut()
    fc.fire('SIGNED_IN', realSession('n1'))
    await tick(30)
    expect(core.getState().status).toBe('account')
    expect(calls).toEqual(['u_n1', 'u_n1']) // re-fired
    expect(snapshotOnDisk().lastUserScope).toBe('u_n1') // success finally advances it
  })

  it('hung onUpgrade: the 8s timeout unblocks login and still leaves the retry armed', async () => {
    vi.useFakeTimers()
    const fc = fakeClient()
    const calls = []
    const core = makeCore(fc, {
      onUpgrade: () => {
        calls.push(1)
        return new Promise(() => {}) // never settles
      },
    })
    core.boot()
    await vi.advanceTimersByTimeAsync(0)
    expect(core.getState().status).toBe('guest')
    fc.fire('SIGNED_IN', realSession('s1'))
    await vi.advanceTimersByTimeAsync(UPGRADE_TIMEOUT_MS)
    expect(core.getState().status).toBe('account')
    expect(snapshotOnDisk().lastUserScope).toBe('guest') // hung seed ≠ done seed
    expect(calls).toHaveLength(1)
  })
})

/* ---------------------------------------- serialized account entries */
describe('account entries are serialized (last event wins, one upgrade total)', () => {
  it('a different-uid entry waits for the in-flight one; onUpgrade never double-fires', async () => {
    const fc = fakeClient()
    const seen = []
    let releaseA
    const gate = new Promise((r) => { releaseA = r })
    const core = makeCore(fc, {
      onUpgrade: async ({ toScope }) => {
        seen.push(toScope)
        if (toScope === 'u_A') await gate // A's seed is slow
      },
    })
    core.boot()
    await tick()
    fc.fire('SIGNED_IN', realSession('A'))
    await tick()
    expect(seen).toEqual(['u_A']) // A in flight
    fc.fire('SIGNED_IN', realSession('B')) // another tab switched accounts mid-upgrade
    await tick()
    expect(seen).toEqual(['u_A']) // B is QUEUED, not interleaved
    expect(core.getState().status).toBe('guest') // nothing committed yet
    releaseA()
    await tick(40)
    const s = core.getState()
    expect(s.status).toBe('account')
    expect(s.scope).toBe('u_B') // last event wins — matches the client's live session
    expect(s.session.user.id).toBe('B')
    expect(snapshotOnDisk().lastUserScope).toBe('u_B')
    // B entered from u_A (A's entry persisted first), NOT from guest:
    // the guest sandbox was offered to exactly ONE account (防串号铁律)
    expect(seen).toEqual(['u_A'])
  })

  it('duplicate same-uid bursts still collapse into one entry', async () => {
    const fc = fakeClient()
    const seen = []
    const core = makeCore(fc, { onUpgrade: async (a) => { seen.push(a); await tick() } })
    core.boot()
    await tick()
    fc.fire('SIGNED_IN', realSession('d2'))
    fc.fire('SIGNED_IN', realSession('d2'))
    fc.fire('SIGNED_IN', realSession('d2'))
    await tick(30)
    expect(core.getState().status).toBe('account')
    expect(seen).toHaveLength(1)
  })
})

/* -------------------------------------------------------- action gates */
describe('action gates — stray calls cannot corrupt a live state', () => {
  const bootAuthed = async (uid = 'acc') => {
    const fc = fakeClient()
    fc.setSession(realSession(uid))
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('account')
    return { fc, core }
  }

  it('startEmail from a live account is a no-op (no state change, no send)', async () => {
    const { fc, core } = await bootAuthed()
    await core.startEmail('x@y.z', { surface: 'account' })
    expect(core.getState().status).toBe('account')
    expect(core.getState().flow).toBeNull()
    expect(fc.calls.signInWithOtp).toHaveLength(0)
  })

  it('loginWithGoogle from a live account is a no-op', async () => {
    const { fc, core } = await bootAuthed()
    await core.loginWithGoogle({ surface: 'account' })
    expect(core.getState().status).toBe('account')
    expect(fc.calls.signInWithOAuth).toHaveLength(0)
  })

  it('startEmail during a pending OAuth round trip is a no-op (the verdict owns the pane)', async () => {
    saveSnapshot({ flow: { kind: 'oauth', provider: 'google', surface: 'gate', expiresAt: NOW + 60_000 } }, NOW)
    const fc = fakeClient()
    fc.hangSession()
    const core = makeCore(fc)
    core.boot()
    expect(core.getState().flow?.kind).toBe('oauth')
    await core.startEmail('x@y.z', { surface: 'gate' })
    expect(core.getState().flow?.kind).toBe('oauth') // not clobbered
    expect(fc.calls.signInWithOtp).toHaveLength(0)
  })

  it('verifyEmail with no live OTP flow rejects cleanly and never calls supabase', async () => {
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    await expect(core.verifyEmail('123456')).rejects.toThrow('No email verification in progress')
    expect(fc.calls.verifyOtp).toHaveLength(0)
  })

  it('resendEmail with no live OTP flow rejects cleanly and never calls supabase', async () => {
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    await expect(core.resendEmail()).rejects.toThrow('No email verification in progress')
    expect(fc.calls.signInWithOtp).toHaveLength(0)
  })

  it('signOut during an in-flight upgrade sticks — the entry cannot resurrect the login', async () => {
    const fc = fakeClient()
    let release
    const gate = new Promise((r) => { release = r })
    const core = makeCore(fc, { onUpgrade: () => gate })
    core.boot()
    await tick()
    fc.fire('SIGNED_IN', realSession('Z'))
    await tick()
    expect(core.getState().status).toBe('guest') // entry still awaiting the seed
    core.signOut() // user backs out
    release()
    await tick(30)
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(snapshotOnDisk().explicitLogout).toBe(true) // the logout was not overwritten
  })

  it('signOut during an in-flight entry does not poison a same-uid re-login (epoch-scoped dedupe)', async () => {
    const fc = fakeClient()
    let release
    const gate = new Promise((r) => { release = r })
    let calls = 0
    const core = makeCore(fc, { onUpgrade: () => { calls += 1; return calls === 1 ? gate : undefined } })
    core.boot()
    await tick()
    fc.fire('SIGNED_IN', realSession('Z'))
    await tick()
    core.signOut() // voids the in-flight entry…
    fc.fire('SIGNED_IN', realSession('Z')) // …but the user logs straight back in
    release()
    await tick(40)
    const s = core.getState()
    expect(s.status).toBe('account') // the fresh entry must land, not adopt the doomed one
    expect(s.scope).toBe('u_Z')
    expect(snapshotOnDisk().explicitLogout).toBe(false)
  })

  it('public exitFlow cannot dismiss a pending OAuth round trip (判决必须有落点)', async () => {
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    await core.loginWithGoogle({ surface: 'gate' })
    expect(core.getState().status).toBe('authenticating')
    core.exitFlow()
    expect(core.getState().status).toBe('authenticating') // still pending
    expect(core.getState().flow?.kind).toBe('oauth')
  })
})

/* ------------------------- browser-environment boot paths (via stubs) */
describe('boot with window/document — URL verdicts, bfcache, resume retry', () => {
  it('?error_description on the boot URL → error pane on the launching surface, URL scrubbed', async () => {
    saveSnapshot(
      { flow: { kind: 'oauth', provider: 'google', surface: 'welcome', expiresAt: NOW + 60_000 }, explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' },
      NOW,
    )
    const b = stubBrowser({ search: '?error_description=Access+denied' })
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true) // welcome-launched → error lands on the gate
    expect(s.error).toBe('Access denied')
    expect(s.urlAuthError).toBeNull() // consumed
    expect(b.replaceStateCalls).toHaveLength(1) // address bar scrubbed
  })

  it('auth params in the URL but no session → the conclude timeout exits the pane', async () => {
    vi.useFakeTimers()
    saveSnapshot({ flow: { kind: 'oauth', provider: 'google', surface: 'gate', expiresAt: NOW + 600_000 } }, NOW)
    stubBrowser({ search: '?code=abc123' })
    const fc = fakeClient() // getSession resolves null; the code exchange never lands
    const core = makeCore(fc)
    core.boot()
    await vi.advanceTimersByTimeAsync(0)
    expect(core.getState().status).toBe('authenticating') // waiting on SIGNED_IN
    await vi.advanceTimersByTimeAsync(OAUTH_CONCLUDE_TIMEOUT_MS)
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.error).toMatch(/timed out/i)
    expect(snapshotOnDisk().flow).toBeNull()
  })

  it('the conclude timeout stands down while a slow onUpgrade is landing (no spurious "timed out" over a successful login)', async () => {
    vi.useFakeTimers()
    saveSnapshot({ flow: { kind: 'oauth', provider: 'google', surface: 'gate', expiresAt: NOW + 600_000 }, lastUserScope: 'guest' }, NOW)
    stubBrowser({ search: '?code=abc123' })
    const fc = fakeClient()
    let release
    const gate = new Promise((r) => { release = r })
    const core = makeCore(fc, { onUpgrade: () => gate })
    core.boot()
    await vi.advanceTimersByTimeAsync(0) // null verdict → timer armed
    await vi.advanceTimersByTimeAsync(9_000) // 9s: exchange finally lands…
    fc.fire('SIGNED_IN', realSession('g1')) // …entry starts, upgrade is slow
    await vi.advanceTimersByTimeAsync(2_000) // past the original 10s mark
    expect(core.getState().error).toBeNull() // no spurious timeout
    expect(core.getState().status).toBe('authenticating') // still pending honestly
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(core.getState().status).toBe('account')
    expect(core.getState().error).toBeNull()
  })

  it('a restored OAuth pane cannot hang forever even if getSession never settles', async () => {
    vi.useFakeTimers()
    saveSnapshot(
      { flow: { kind: 'oauth', provider: 'google', surface: 'welcome', expiresAt: NOW + 600_000 }, explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' },
      NOW,
    )
    const fc = fakeClient()
    fc.hangSession()
    const core = makeCore(fc)
    core.boot()
    expect(core.getState().status).toBe('authenticating')
    await vi.advanceTimersByTimeAsync(OAUTH_CONCLUDE_TIMEOUT_MS)
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.atWelcome).toBe(true)
    expect(s.error).toMatch(/timed out/i)
  })

  it('bfcache pageshow during an OAuth flow → silent cancel; an OTP flow is untouched', async () => {
    const b = stubBrowser()
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    await core.loginWithGoogle({ surface: 'gate' })
    expect(core.getState().status).toBe('authenticating')
    b.fireWindow('pageshow', { persisted: true })
    expect(core.getState().status).toBe('guest') // user pressed back at the provider
    expect(core.getState().error).toBeNull() // silent
    // an OTP flow is not a redirect — bfcache restores must leave it alone
    await core.startEmail('a@b.c', { surface: 'gate' })
    b.fireWindow('pageshow', { persisted: true })
    expect(core.getState().status).toBe('authenticating')
    expect(core.getState().flow?.kind).toBe('otp')
  })

  it('a failed getSession retries when the app becomes visible; a settled ACCOUNT does not re-query', async () => {
    const b = stubBrowser()
    saveSnapshot({ hadAccount: true, lastUserScope: 'u_me' }, NOW)
    const fc = fakeClient()
    fc.failSession()
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('guest')
    expect(core.getState().atWelcome).toBe(false) // degraded play, not the gate
    expect(core.getState().scope).toBe('u_me') // still the account's drawer
    fc.setSession(realSession('me')) // network is back
    b.fireDoc('visibilitychange')
    await tick()
    expect(core.getState().status).toBe('account') // retry landed the account
    const queries = fc.calls.getSession
    b.fireDoc('visibilitychange') // a live account owns the screen — no polling
    await tick()
    expect(fc.calls.getSession).toBe(queries)
  })

  it('a session that landed while the page was frozen is adopted on the next wake — a settled GUEST re-asks (iOS 速冻 mid-handoff)', async () => {
    const b = stubBrowser()
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('guest') // clean first verdict: plain guest
    // iOS froze the page during the Add-to-Home-Screen handoff's ~1s exchange:
    // supabase-js persisted the redeemed session, but the SIGNED_IN event
    // thawed into a page whose verdict had already settled as guest. The wake
    // re-ask is what adopts the parked login (2026-08-01 sticky-guest icon).
    fc.setSession(realSession('meo'))
    b.fireDoc('visibilitychange')
    await tick()
    expect(core.getState().status).toBe('account')
    expect(core.getState().scope).toBe('u_meo')
  })

  it('a settled guest with still no session re-asks harmlessly on wake (welcome gate stays put)', async () => {
    const b = stubBrowser()
    saveSnapshot({ hadAccount: true, explicitLogout: true, lastUserScope: 'u_old' }, NOW)
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    expect(core.getState().status).toBe('guest')
    expect(core.getState().atWelcome).toBe(true)
    const queries = fc.calls.getSession
    b.fireDoc('visibilitychange')
    await tick()
    expect(fc.calls.getSession).toBe(queries + 1) // it DOES ask again now
    expect(core.getState().status).toBe('guest') // and nothing moves
    expect(core.getState().atWelcome).toBe(true)
  })
})

/* --------------------------------------------- restored-flow presentation */
describe('restored flow presentation', () => {
  it('boot restoring a welcome-surface flow keeps atWelcome true (pane shows over the gate, like the live path)', async () => {
    saveSnapshot(
      { flow: { kind: 'otp', email: 'a@b.c', surface: 'welcome', expiresAt: NOW + 1000 }, explicitLogout: true, hadAccount: true, lastUserScope: 'u_old' },
      NOW,
    )
    const fc = fakeClient()
    const core = makeCore(fc)
    core.boot()
    await tick()
    const s = core.getState()
    expect(s.status).toBe('authenticating')
    expect(s.atWelcome).toBe(true)
    expect(s.scope).toBe('u_old') // gate still fronts the account cache
  })

  it('exitFlow never reshuffles the scope (a watchdog-degraded guest keeps its optimistic drawer)', async () => {
    vi.useFakeTimers()
    saveSnapshot({ lastUserScope: 'u_abc', hadAccount: true }, NOW)
    const fc = fakeClient()
    fc.hangSession()
    const core = makeCore(fc)
    core.boot()
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS)
    expect(core.getState().scope).toBe('u_abc') // degraded but optimistic
    await core.startEmail('a@b.c', { surface: 'gate' })
    core.exitFlow()
    const s = core.getState()
    expect(s.status).toBe('guest')
    expect(s.scope).toBe('u_abc') // back-press must not remount onto 'guest'
    expect(s.atWelcome).toBe(false)
  })
})
