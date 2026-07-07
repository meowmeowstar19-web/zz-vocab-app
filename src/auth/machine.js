// Pure auth state machine — ZERO imports (no react, no supabase, no Date).
// transition(state, event) → { state, effects[] }. The hook layer (useAuth.js)
// executes effects (supabase calls, timers, snapshot writes) and feeds their
// results back in as events. Every design decision traces to auth-design.md;
// the numbered "铁律" comments below reference its section 二.
//
// Time never comes from inside the machine: events that need a clock carry a
// `now` (ms) payload supplied by the caller — that's what keeps this module a
// pure function that the test matrix can drive deterministically.

export const OTP_TTL_MS = 10 * 60 * 1000 // matches Supabase OTP expiry (600s)
export const BIND_TTL_MS = 10 * 60 * 1000 // OAuth round-trip marker lifetime
export const WATCHDOG_MS = 4000 // 铁律2: INITIALIZING may hold the app ≤4s
export const ANON_MAX_ATTEMPTS = 3 // 铁律7: mint retries before degrading

export const STATUS = {
  INITIALIZING: 'INITIALIZING',
  AUTHED: 'AUTHED',
  GUEST_ANON: 'GUEST_ANON',
  GUEST_LEGACY: 'GUEST_LEGACY',
  OTP_PENDING: 'OTP_PENDING',
  BINDING: 'BINDING',
  LOGGED_OUT: 'LOGGED_OUT',
}

const isAnon = (session) => !!session?.user?.is_anonymous
const scopeOf = (session) => (session?.user?.id ? `u_${session.user.id}` : 'guest')

export function initialState() {
  return {
    status: STATUS.INITIALIZING,
    session: null,
    userScope: 'guest', // overwritten by BOOT with snapshot.lastUserScope (铁律8)
    snapshot: null, // the machine's view of the persisted snapshot
    otp: null, // { email, expiresAt } while OTP_PENDING
    otpReturn: null, // status OTP_EXIT falls back to (铁律5: one exit for all)
    bind: null, // { provider, surface, mode:'bind'|'login', email?, expiresAt }
    bindError: null, // reason shown by the modal's error pane
    anonAttempt: 0,
    legacyReason: null, // 'minting'|'mint-failed'|'session-failed'|'watchdog'
  }
}

// --- tiny effect constructors (descriptors only — the hook interprets them) --
const fx = {
  getSession: () => ({ type: 'getSession' }),
  startWatchdog: () => ({ type: 'startWatchdog', ms: WATCHDOG_MS }),
  stopWatchdog: () => ({ type: 'stopWatchdog' }),
  mintAnon: (attempt) => ({ type: 'mintAnon', attempt }),
  saveSnapshot: (patch) => ({ type: 'saveSnapshot', patch }),
  sendOtp: (email) => ({ type: 'sendOtp', email }),
  sendBindEmail: (email) => ({ type: 'sendBindEmail', email }),
  ensureAnon: () => ({ type: 'ensureAnon' }), // mint only if no live session (铁律5)
  supabaseSignOut: () => ({ type: 'supabaseSignOut' }),
  oauthRedirect: (provider, mode, surface) => ({ type: 'oauthRedirect', provider, mode, surface }),
  notify: (kind) => ({ type: 'notify', kind }),
}

const patchSnap = (state, patch) => ({ ...state, snapshot: { ...state.snapshot, ...patch } })

// entering a state that owns a session scope also persists it (铁律8: next boot
// renders from lastUserScope without waiting on the network)
function enterAuthed(state, session, extra = {}) {
  const patch = {
    hadAccount: true,
    explicitLogout: false,
    lastUserScope: scopeOf(session),
    otp: null,
    bind: null,
    ...extra,
  }
  const effects = [fx.saveSnapshot(patch)]
  // guest logged into an EXISTING account (uid changed): fold the guest
  // wardrobe into the account scope (auth-design.md §七.3). The bind path
  // keeps the uid, so it never gets here with a different id — zero-merge by
  // construction. The pre-flow identity comes from state.session when it is a
  // (possibly already signed-out) anon session the OTP flow held onto, and
  // falls back to state.userScope otherwise — an OAuth round trip records the
  // NEW session before BIND_OK fires, and a page kill mid-OTP loses the object
  // entirely, but userScope survives both (BOOT seeds it from the snapshot).
  // Never fold when the flow started from the welcome page (explicitLogout: a
  // logged-out account's scope must not leak into the next login) or when the
  // prior session is a DIFFERENT live real account (another-tab switch).
  const newScope = scopeOf(session)
  const prior = state.session
  const priorIsOtherRealAccount = !!prior && !isAnon(prior) && scopeOf(prior) !== newScope
  const from = isAnon(prior) ? scopeOf(prior) : state.userScope
  if (
    session?.user?.id &&
    from && from.startsWith('u_') && from !== newScope &&
    !state.snapshot?.explicitLogout &&
    !priorIsOtherRealAccount
  ) {
    effects.push({ type: 'mergeScopes', from, to: newScope })
  }
  return {
    state: {
      ...patchSnap(state, patch),
      status: STATUS.AUTHED,
      session,
      userScope: scopeOf(session),
      otp: null,
      otpReturn: null,
      bind: null,
      bindError: null,
      anonAttempt: 0,
      legacyReason: null,
    },
    effects,
  }
}

function enterGuestAnon(state, session) {
  const patch = { lastUserScope: scopeOf(session), otp: null, bind: null }
  const effects = [fx.saveSnapshot(patch)]
  // a fresh anon identity replacing a LOST one inherits the previous scope's
  // wardrobe — without this, a consumed (login-OTP) or expired session looks
  // like a wiped game after the re-mint even though the data is still on
  // disk. state.userScope carries the previous scope on both legs: live
  // transitions keep it in state, and after a reload BOOT seeds it from
  // snapshot.lastUserScope. 'guest' is excluded: the legacy scope is
  // inherited exactly once via the migration marker, and GUEST_CHOSEN resets
  // to 'guest' precisely because a fresh game was requested.
  const prior = state.userScope
  const next = scopeOf(session)
  if (prior && prior.startsWith('u_') && prior !== next) {
    effects.push({ type: 'mergeScopes', from: prior, to: next })
  }
  return {
    state: {
      ...patchSnap(state, patch),
      status: STATUS.GUEST_ANON,
      session,
      userScope: scopeOf(session),
      otp: null,
      otpReturn: null,
      bind: null,
      anonAttempt: 0,
      legacyReason: null,
    },
    effects,
  }
}

// degraded-but-renderable guest (铁律2: render first, keep resolving after)
function enterLegacy(state, reason, effects = []) {
  return {
    state: { ...state, status: STATUS.GUEST_LEGACY, legacyReason: reason },
    effects,
  }
}

// start minting an anonymous session (with retry budget, 铁律7). Rendered as
// GUEST_LEGACY('minting') until ANON_MINTED lands.
function startMint(state, effects = []) {
  return {
    state: {
      ...state,
      status: STATUS.GUEST_LEGACY,
      session: null,
      legacyReason: 'minting',
      anonAttempt: 1,
    },
    effects: [...effects, fx.mintAnon(1)],
  }
}

// the ONE exit shared by OTP back/close/timeout and email-bind back (铁律5):
// fall back to wherever we came from, re-minting the anon session if the flow
// consumed it.
function exitPending(state, fallback, { error = null } = {}) {
  const patch = { otp: null, bind: null }
  const base = {
    ...patchSnap(state, patch),
    otp: null,
    otpReturn: null,
    bind: null,
    bindError: error,
  }
  const effects = [fx.saveSnapshot(patch)]
  if (fallback === STATUS.LOGGED_OUT) {
    return { state: { ...base, status: STATUS.LOGGED_OUT, session: null }, effects }
  }
  if (base.session && !isAnon(base.session)) {
    return { state: { ...base, status: STATUS.AUTHED }, effects }
  }
  // An anon session held during OTP_PENDING is not blindly trusted: the flow
  // no longer signs it out (2026-07-06 fix), but the machine's copy can still
  // be a corpse (token death mid-flow, or a state restored after a page
  // kill), so exiting re-verifies. ensureAnon getSession()s first — the
  // normal live session resolves in place, same uid, without an extra mint.
  // (BINDING exits keep the fast path: email-bind and OAuth never touch it.)
  if (base.session && state.status !== STATUS.OTP_PENDING) {
    return { state: { ...base, status: STATUS.GUEST_ANON }, effects }
  }
  // session cleared (or unverifiable) — restore it before the user notices
  return {
    state: { ...base, status: STATUS.GUEST_LEGACY, legacyReason: 'minting', anonAttempt: 1 },
    effects: [...effects, fx.ensureAnon()],
  }
}

// SESSION_RESOLVED mapping shared by INITIALIZING / GUEST_LEGACY
function resolveSession(state, session) {
  if (session && !isAnon(session)) return enterAuthed(state, session)
  if (session) return enterGuestAnon(state, session)
  if (state.snapshot?.explicitLogout) {
    return {
      state: { ...state, status: STATUS.LOGGED_OUT, session: null },
      effects: [],
    }
  }
  return startMint(state)
}

// unintentional session death (expired token / server revoke): real accounts
// get a notice (铁律4's fixed branch), guests just re-mint quietly.
function sessionDied(state, wasRealAccount) {
  const patch = { explicitLogout: false }
  const { state: s, effects } = startMint(patchSnap(state, patch), [fx.saveSnapshot(patch)])
  if (wasRealAccount) effects.push(fx.notify('session-expired'))
  return { state: s, effects }
}

export function transition(state, event) {
  const t = event.type
  const { status } = state

  /* ---------------------------------------------------------------- BOOT */
  if (t === 'BOOT') {
    const snap = event.snapshot
    const now = event.now
    const effects = [fx.getSession(), fx.startWatchdog()]
    let next = {
      ...state,
      snapshot: snap,
      // 铁律8: optimistic render — reuse last scope until the session says otherwise
      userScope: snap.lastUserScope || 'guest',
    }
    // 铁律1: any in-flight marker read back from disk is validated against its
    // expiresAt before being trusted; expired ones are treated as exited.
    const otp = snap.otp && snap.otp.expiresAt > now ? snap.otp : null
    const bind = snap.bind && snap.bind.expiresAt > now ? snap.bind : null
    const stale = (snap.otp && !otp) || (snap.bind && !bind)
    if (stale) {
      const patch = { otp: null, bind: null }
      next = patchSnap(next, patch)
      effects.push(fx.saveSnapshot(patch))
    }
    if (bind) {
      // OAuth round-trip coming home: show the surface's pending pane until the
      // resolved session lets the hook call BIND_OK / BIND_REJECTED.
      return { state: { ...next, status: STATUS.BINDING, bind }, effects }
    }
    if (otp) {
      return {
        state: {
          ...next,
          status: STATUS.OTP_PENDING,
          otp,
          otpReturn: snap.explicitLogout ? STATUS.LOGGED_OUT : STATUS.GUEST_ANON,
        },
        effects,
      }
    }
    return { state: { ...next, status: STATUS.INITIALIZING }, effects }
  }

  /* ------------------------------------------------- session resolution */
  if (t === 'SESSION_RESOLVED') {
    const session = event.session
    if (status === STATUS.INITIALIZING) {
      const r = resolveSession(state, session)
      return { state: r.state, effects: [fx.stopWatchdog(), ...r.effects] }
    }
    if (status === STATUS.GUEST_LEGACY) {
      const r = resolveSession(state, session)
      return { state: r.state, effects: [fx.stopWatchdog(), ...r.effects] }
    }
    if (status === STATUS.BINDING) {
      // just record it — the hook inspects identities/URL and concludes with
      // BIND_OK or BIND_REJECTED. Keeping the pending pane up is intentional.
      return { state: { ...state, session }, effects: [fx.stopWatchdog()] }
    }
    if (status === STATUS.OTP_PENDING) {
      // verified in another tab → upgrade; otherwise keep waiting for the code
      if (session && !isAnon(session)) return enterAuthed(state, session)
      return { state: { ...state, session }, effects: [fx.stopWatchdog()] }
    }
    if (status === STATUS.GUEST_ANON || status === STATUS.AUTHED) {
      if (session && !isAnon(session)) return enterAuthed(state, session)
      if (session) return enterGuestAnon(state, session)
      return { state, effects: [] } // null resolution never demotes a live UI
    }
    // LOGGED_OUT: a real session appearing (another tab logged in) wins
    if (session && !isAnon(session)) return enterAuthed(state, session)
    return { state, effects: [] }
  }

  if (t === 'SESSION_FAILED') {
    // 铁律3: every network failure lands in a renderable state
    if (status === STATUS.INITIALIZING) {
      return enterLegacy(state, 'session-failed', [fx.stopWatchdog()])
    }
    if (status === STATUS.BINDING) {
      // can't conclude the round trip — fall back to guest with the error pane
      return exitPending(state, null, { error: 'network' })
    }
    return { state, effects: [] }
  }

  if (t === 'WATCHDOG_FIRED') {
    // 铁律2: never hold the first paint hostage. Only INITIALIZING cares.
    if (status === STATUS.INITIALIZING) return enterLegacy(state, 'watchdog')
    return { state, effects: [] }
  }

  /* ------------------------------------------------------ anonymous mint */
  if (t === 'ANON_MINTED') {
    if (status === STATUS.GUEST_LEGACY) return enterGuestAnon(state, event.session)
    return { state, effects: [] }
  }
  if (t === 'ANON_FAILED') {
    if (status !== STATUS.GUEST_LEGACY) return { state, effects: [] }
    if (state.anonAttempt < ANON_MAX_ATTEMPTS) {
      const attempt = state.anonAttempt + 1
      return {
        state: { ...state, anonAttempt: attempt },
        effects: [fx.mintAnon(attempt)], // hook applies exponential backoff
      }
    }
    // 铁律7: budget exhausted → stay legacy, retry on next app wake
    return { state: { ...state, legacyReason: 'mint-failed' }, effects: [] }
  }
  if (t === 'APP_RESUMED') {
    if (status !== STATUS.GUEST_LEGACY) return { state, effects: [] }
    if (state.legacyReason === 'mint-failed' || state.legacyReason === 'minting') {
      return { state: { ...state, anonAttempt: 1 }, effects: [fx.mintAnon(1)] }
    }
    return { state, effects: [fx.getSession()] } // session-failed / watchdog
  }

  /* ---------------------------------------------------------- OTP login */
  if (t === 'OTP_REQUESTED') {
    const ok =
      status === STATUS.GUEST_ANON ||
      status === STATUS.GUEST_LEGACY ||
      status === STATUS.LOGGED_OUT ||
      status === STATUS.OTP_PENDING // resend / change-email re-requests
    if (!ok) return { state, effects: [] }
    const otp = { email: event.email, expiresAt: event.now + OTP_TTL_MS }
    const patch = { otp, lastEmail: event.email }
    return {
      state: {
        ...patchSnap(state, patch),
        status: STATUS.OTP_PENDING,
        otp,
        otpReturn: status === STATUS.OTP_PENDING ? state.otpReturn : status,
      },
      effects: [fx.saveSnapshot(patch), fx.sendOtp(event.email)],
    }
  }
  if (t === 'RESENT') {
    // a successful resend restarts the SERVER-side code TTL — mirror it in the
    // local marker, or the pane times out while the fresh code is still valid
    if (status === STATUS.OTP_PENDING && state.otp) {
      const otp = { ...state.otp, expiresAt: event.now + OTP_TTL_MS }
      const patch = { otp }
      return { state: { ...patchSnap(state, patch), otp }, effects: [fx.saveSnapshot(patch)] }
    }
    if (status === STATUS.BINDING && state.bind) {
      const bind = { ...state.bind, expiresAt: event.now + BIND_TTL_MS }
      const patch = { bind }
      return { state: { ...patchSnap(state, patch), bind }, effects: [fx.saveSnapshot(patch)] }
    }
    return { state, effects: [] }
  }
  if (t === 'OTP_VERIFIED') {
    if (status !== STATUS.OTP_PENDING) return { state, effects: [] }
    return enterAuthed(state, event.session, { lastEmail: state.otp?.email ?? null })
  }
  if (t === 'OTP_EXIT') {
    // back / close / timeout / stale-at-boot all funnel here (铁律5)
    if (status === STATUS.OTP_PENDING) {
      const fallback =
        state.otpReturn === STATUS.LOGGED_OUT ? STATUS.LOGGED_OUT : null
      return exitPending(state, fallback)
    }
    if (status === STATUS.BINDING && state.bind?.provider === 'email') {
      return exitPending(state, null)
    }
    return { state, effects: [] }
  }

  /* ------------------------------------------------- bind / OAuth login */
  if (t === 'BIND_STARTED') {
    const ok =
      status === STATUS.GUEST_ANON ||
      status === STATUS.GUEST_LEGACY ||
      status === STATUS.LOGGED_OUT
    if (!ok) return { state, effects: [] }
    const bind = {
      provider: event.provider,
      surface: event.surface, // 'gate' | 'account' | 'welcome'
      mode: event.mode, // 'bind' (keep uid) | 'login' (switch account)
      email: event.email ?? null,
      expiresAt: event.now + BIND_TTL_MS,
    }
    const patch = { bind, ...(event.email ? { lastEmail: event.email } : null) }
    const effects = [fx.saveSnapshot(patch)]
    if (event.provider === 'email') effects.push(fx.sendBindEmail(event.email))
    else effects.push(fx.oauthRedirect(event.provider, event.mode, event.surface))
    return {
      state: { ...patchSnap(state, patch), status: STATUS.BINDING, bind, bindError: null },
      effects,
    }
  }
  if (t === 'BIND_OK') {
    if (status !== STATUS.BINDING) return { state, effects: [] }
    return enterAuthed(state, event.session, {
      lastEmail: state.bind?.email ?? state.snapshot?.lastEmail ?? null,
    })
  }
  if (t === 'BIND_REJECTED') {
    if (status !== STATUS.BINDING) return { state, effects: [] }
    // reason null = silent cancel (user backed out of the provider page);
    // a string reason drives the modal's error pane + confirm button.
    return exitPending(state, null, { error: event.reason ?? null })
  }

  /* ------------------------------------------------------------- signout */
  if (t === 'SIGNED_OUT') {
    if (event.intentional) {
      // 铁律6: intent travels in the event, never via a localStorage flag
      const patch = { explicitLogout: true, otp: null, bind: null }
      return {
        state: {
          ...patchSnap(state, patch),
          status: STATUS.LOGGED_OUT,
          session: null,
          otp: null,
          otpReturn: null,
          bind: null,
          bindError: null,
        },
        effects: [fx.saveSnapshot(patch), fx.supabaseSignOut()],
      }
    }
    // unintentional (server-side revoke / refresh death)
    if (status === STATUS.AUTHED) return sessionDied(state, true)
    if (status === STATUS.GUEST_ANON) return sessionDied(state, false)
    return { state, effects: [] }
  }
  if (t === 'TOKEN_REFRESH_FAILED') {
    if (status === STATUS.AUTHED) return sessionDied(state, true)
    if (status === STATUS.GUEST_ANON) return sessionDied(state, false)
    return { state, effects: [] }
  }

  if (t === 'BIND_ERROR_CLEARED') {
    // the modal's error pane was dismissed — pure state, no effects
    if (!state.bindError) return { state, effects: [] }
    return { state: { ...state, bindError: null }, effects: [] }
  }

  /* -------------------------------------------- welcome page: guest mode */
  if (t === 'GUEST_CHOSEN') {
    if (status !== STATUS.LOGGED_OUT) return { state, effects: [] }
    // fresh anon uid = fresh game; the old account's scope is left untouched
    const patch = { explicitLogout: false, lastUserScope: 'guest' }
    return startMint(
      { ...patchSnap(state, patch), userScope: 'guest' },
      [fx.saveSnapshot(patch)],
    )
  }

  return { state, effects: [] }
}

// derived helpers the hook/UI share
export const isReady = (state) => state.status !== STATUS.INITIALIZING
export const isRealAccount = (state) => state.status === STATUS.AUTHED
