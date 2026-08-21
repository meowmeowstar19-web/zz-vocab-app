// login-auth-core — headless auth engine (Plan B rewrite, see
// docs/login-auth-refactor-blueprint.md).
//
// One idea: identity and data are fully divorced. This module only knows
// "who are you" — guest or account, the Supabase session, login/logout, the
// upgrade event, and the current storage scope name. It knows NOTHING about
// the host app's data. Zero app imports, zero React, zero styling.
//
// A guest is a PURE LOCAL sandbox: no server identity at all. There is no
// anonymous sign-in, no minting, no session keep-alive — the whole
// GUEST_ANON/GUEST_LEGACY machinery of the previous stack is gone. Only a
// real account touches the server, and its data follows the account.
//
// Four states (half of the old seven):
//   loading         boot is checking the persisted session
//   guest           no account session — play from the local 'guest' scope.
//                   `atWelcome` distinguishes the welcome/logged-out gate
//                   (explicit logout, or a returning account whose token
//                   failed to resolve) from an actively playing guest.
//   account         a real account session is live (scope u_<uid>)
//   authenticating  a login flow is in flight (OTP verify pane up, or an
//                   OAuth round trip out/back) — `flow` carries the details
//
// Sign-up and log-in are ONE code path (signInWithOtp shouldCreateUser /
// signInWithOAuth) — BY PRODUCT DECISION (2026-07-16 用户拍板, 蓝图 §11): every
// entry, email or Google, is "account exists → enter it, else create it",
// product-wide, and the UI SAYS so ("Log in or sign up" — no split doors, so
// the label never lies). No intent survives the OAuth redirect because none
// exists: data movement is decided by the EMPTY-ACCOUNT check in the app's
// onUpgrade (蓝图 §3.1 — the whole bind.mode machinery is deleted). The one
// guard the merge needs: entering a freshly-CREATED account raises
// notice:'account-created', so a player who mistyped the email of the account
// they meant to re-enter sees WHY their stuff looks gone.
//
// Injected config (portable to the next app):
//   client     — a Supabase client
//   onUpgrade  — async ({ fromScope, toScope, user, session }) => void
//                the ONE data bridge. Fired whenever an account is entered
//                while this device's last identity was the guest sandbox.
//                The app decides whether to move data (only into an account
//                that is EMPTY on the server) — the core never judges.
import { loadSnapshot, saveSnapshot } from './snapshot.js'

export const OTP_TTL_MS = 10 * 60 * 1000 // matches Supabase OTP expiry (600s)
export const OAUTH_TTL_MS = 10 * 60 * 1000 // OAuth round-trip marker lifetime
export const WATCHDOG_MS = 4000 // 铁律2: `loading` may hold the app ≤4s
export const SESSION_RETRY_BASE_MS = 5000 // 1st retry after a network-failed getSession
export const SESSION_RETRY_MAX_MS = 60_000 // retry backoff cap
export const UPGRADE_TIMEOUT_MS = 8000 // onUpgrade is best-effort, never blocks login forever
export const OAUTH_CONCLUDE_TIMEOUT_MS = 10_000 // dropped code exchange can't hang the pane
// an account whose created_at is this recent announces itself as brand-new on
// entry (notice:'account-created') — wide enough to cover the OTP send→verify
// gap (≤10min), narrow enough that re-entering a real account never trips it
export const ACCOUNT_CREATED_WINDOW_MS = 15 * 60 * 1000

const isRealSession = (s) => !!s?.user?.id && !s.user.is_anonymous

export function createAuthCore({ client, onUpgrade, now = () => Date.now() }) {
  /* ------------------------------------------------------------- state */
  let state = {
    status: 'loading', // 'loading' | 'guest' | 'account' | 'authenticating'
    session: null,
    scope: 'guest', // 'guest' | `u_<uid>` — the drawer the game stores under
    atWelcome: false, // guest presentation: welcome/logged-out gate vs playing
    flow: null, // { kind:'otp'|'oauth', email?, provider?, surface, expiresAt }
    error: null, // login-flow error shown by the modal/welcome error pane
    notice: null, // 'session-expired' | 'account-created' | 'welcome-back' | null — transient banner for the app
    urlAuthError: null, // ?error_description=… parsed off the boot URL
    snapshot: null,
  }
  const listeners = new Set()
  const emit = () => listeners.forEach((l) => l())
  const setState = (patch) => {
    state = { ...state, ...patch }
    emit()
  }
  const persist = (patch) => saveSnapshot(patch, now())

  let booted = false
  let sessionSettled = false // getSession reached a verdict (vs failed/hung)
  let watchdogTimer = null
  let oauthTimer = null
  let retryTimer = null // re-asks getSession after a NETWORK-failed verdict
  let retryDelayMs = SESSION_RETRY_BASE_MS
  let hasAuthParamsInUrl = false
  // Account entries are SERIALIZED. The old stack's enterAuthed was synchronous,
  // so "last session event wins" was atomic; the async onUpgrade await opened a
  // window where two different-uid entries could interleave (double onUpgrade,
  // state committed for A while the client actually holds B). The queue restores
  // that atomicity. authEpoch is bumped by signOut/accountSessionDied so an
  // entry captured before the bump aborts instead of resurrecting the login.
  let authEpoch = 0
  let entryTail = Promise.resolve()
  let entriesPending = 0
  let lastQueued = null // { uid, promise } — dedupes bursts of same-uid events

  /* ----------------------------------------------------------- helpers */
  const withTimeout = (p, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms)
      p.then(
        (v) => { clearTimeout(t); resolve(v) },
        (e) => { clearTimeout(t); reject(e) },
      )
    })

  // Enter a real account. The ONLY writer of status:'account'. Entries queue
  // through entryTail (see above); a burst of events for the same uid collapses
  // into one queued entry.
  function enterAccount(session) {
    const uid = session.user.id
    if (state.status === 'account' && state.session?.user?.id === uid && entriesPending === 0) {
      setState({ session }) // token refresh / metadata update — same live account
      return Promise.resolve()
    }
    const epoch = authEpoch // captured at EVENT time — a later signOut voids the entry
    // dedupe is EPOCH-scoped: a same-uid event arriving after a signOut voided
    // the queued entry is a fresh login, not an echo — it must start its own
    // entry instead of adopting the doomed promise (which aborts on commit)
    if (lastQueued?.uid === uid && lastQueued.epoch === epoch) return lastQueued.promise
    entriesPending++
    const promise = entryTail
      .then(() => doEnterAccount(session, epoch))
      .finally(() => {
        entriesPending--
        if (lastQueued?.promise === promise) lastQueued = null
      })
    entryTail = promise.catch(() => {}) // one failed entry must never wedge the queue
    lastQueued = { uid, epoch, promise }
    return promise
  }

  // If this device's last identity was the guest sandbox, fire onUpgrade FIRST
  // and wait for it — the app may fold guest data into the (empty) account's
  // drawer, and the game tree must not remount under the new scope until that
  // write has landed. lastUserScope advances ONLY when onUpgrade succeeds: on a
  // failure/timeout the snapshot still says 'guest', so the NEXT entry of an
  // account re-fires onUpgrade instead of forfeiting the seed forever (the
  // app's empty-account check makes retries harmless — 蓝图 §3.1 幂等). A page
  // kill mid-upgrade re-runs the same way.
  async function doEnterAccount(session, epoch) {
    const uid = session.user.id
    if (epoch !== authEpoch) return // signed out while queued — do not resurrect
    if (state.status === 'account' && state.session?.user?.id === uid) {
      setState({ session })
      return
    }
    clearTimeout(oauthTimer) // a verdict is landing — the conclude timeout is moot
    clearTimeout(retryTimer) // ditto for the weak-net session retry
    // "came from guest" is judged on the PERSISTED scope: until an account
    // entry completes, the snapshot still says 'guest' (or null on a fresh
    // device) — this survives the OAuth full-page redirect with no extra
    // marker. After an explicit logout the snapshot says u_<old>, so logging
    // in from the welcome page never fires an upgrade (the guest sandbox
    // belongs to the guest and stays untouched).
    const priorScope = state.snapshot?.lastUserScope ?? 'guest'
    const cameFromGuest = priorScope === 'guest'
    // notice gating also reads the pre-entry world (captured before persist):
    // only an arrival THROUGH a login flow, into a uid this device has never
    // committed, may announce "account created" — a plain reload of a young
    // account (no flow) or a logout→relogin of the same fresh account (scope
    // already u_<uid>) must not re-toast.
    const viaLoginFlow = state.flow != null
    let upgraded = true
    if (cameFromGuest && typeof onUpgrade === 'function') {
      try {
        await withTimeout(
          Promise.resolve(onUpgrade({ fromScope: 'guest', toScope: `u_${uid}`, user: session.user, session })),
          UPGRADE_TIMEOUT_MS,
        )
      } catch {
        // best-effort: a failed/hung seed must never block login. The guest
        // sandbox is intact on disk, and lastUserScope stays 'guest' below so
        // the next entry retries the upgrade.
        upgraded = false
      }
    }
    if (epoch !== authEpoch) return // signOut/session death raced the upgrade — stay out
    const snap = persist({
      hadAccount: true,
      explicitLogout: false,
      ...(upgraded ? { lastUserScope: `u_${uid}` } : null),
      flow: null,
      ...(state.flow?.email ? { lastEmail: state.flow.email } : null),
    })
    clearTimeout(oauthTimer)
    // the merged door never says "this email had no account" up front — the
    // one honest signal left is on ARRIVAL: a just-created account announces
    // itself, so a player who mistyped the email of the account they meant to
    // re-enter learns why it looks empty (instead of panicking). Gated on
    // viaLoginFlow + first-commit-of-this-uid so token refreshes, reloads and
    // relogins of a young account never re-toast. created_at missing/
    // unparseable (old test fakes, odd providers) fails safe: no notice.
    const createdMs = Date.parse(session.user?.created_at ?? '')
    const isBrandNew =
      viaLoginFlow &&
      priorScope !== `u_${uid}` &&
      Number.isFinite(createdMs) &&
      now() - createdMs < ACCOUNT_CREATED_WINDOW_MS
    // arriving THROUGH a login flow is either a just-made account or a return
    // to an existing one — announce whichever it is. A brand-new account says
    // 'account-created' (the mistyped-email rescue above); every other flow
    // arrival greets 'welcome-back'. A plain reload / boot / session-restore
    // (viaLoginFlow false) stays silent, so refreshing the page never re-toasts.
    // created_at absent → not confidently brand-new → the friendly default
    // (welcome-back), never a false 'account-created'.
    const notice = isBrandNew ? 'account-created' : viaLoginFlow ? 'welcome-back' : null
    setState({
      status: 'account',
      session,
      scope: `u_${uid}`,
      atWelcome: false,
      flow: null,
      error: null,
      notice, // entering an account also moots a pending 'session-expired'
      snapshot: snap,
    })
  }

  // Leave the in-flight login flow and fall back to wherever it was launched
  // from (the ONE exit for back/close/cancel/error — inherits 铁律5's shape):
  // a flow from the welcome page returns to the welcome page, everything else
  // returns to the playing guest. `error` arms the modal/welcome error pane.
  // INTERNAL — verdicts (OAuth conclusion, bfcache back-out, send failures)
  // land here directly; the public exitFlow below adds the user-exit gate.
  function leaveFlow({ error = null } = {}) {
    // only a live flow can be exited (the old OTP_EXIT was likewise a no-op
    // outside pending states) — a stray back-press from the welcome page's
    // email form must not dump the gate into guest mode, and a verdict that
    // already landed (status 'account') has nothing to exit.
    if (state.status !== 'authenticating') return
    const toWelcome = state.flow?.surface === 'welcome'
    const snap = persist({ flow: null })
    clearTimeout(oauthTimer)
    // scope is deliberately NOT touched: welcome keeps fronting whatever cache
    // sits behind the gate, and a flow launched mid-game keeps the scope it was
    // playing under (the old exitPending likewise never reshuffled the scope).
    setState({
      status: 'guest',
      atWelcome: toWelcome,
      flow: null,
      error,
      snapshot: snap,
    })
  }

  // Public exit (back/close from the UI). An OAuth round trip is NOT user-
  // dismissable — its verdict must land (success, URL error, silent cancel or
  // conclude-timeout all route through concludeOAuth/pageshow). The old
  // machine likewise had no user exit out of an OAuth BINDING.
  function exitFlow() {
    if (state.flow?.kind === 'oauth') return
    leaveFlow()
  }

  // Unintentional death of a REAL account's session (expired token / server
  // revoke). NEVER becomes a guest: land on the welcome/logged-out gate with a
  // notice; the u_<uid> cache is untouched and one re-login restores everything
  // (inherits the 2026-07-14/15 fixes by construction — there is no mint to
  // strand the account behind).
  function accountSessionDied() {
    authEpoch++ // any in-flight entry must not resurrect the dead session
    const snap = persist({ explicitLogout: false })
    setState({
      status: 'guest',
      atWelcome: true,
      session: null,
      flow: null,
      error: null,
      notice: 'session-expired',
      snapshot: snap,
    })
  }

  // Ask the client for the persisted session and route the verdict. A response
  // that carries an ERROR with no session is a NETWORK failure (e.g. the access
  // token expired and the refresh call couldn't reach the server on a weak
  // connection) — that is an UNDECIDED verdict, not "no session": the refresh
  // token is still on disk and a later attempt will succeed. Only a clean null
  // (nothing persisted at all) means "definitely signed out".
  function askSession() {
    client.auth
      .getSession()
      .then(({ data, error }) => {
        const s = data?.session ?? null
        if (!s && error) return resolveSession(null, { failed: true })
        resolveSession(s)
      })
      .catch(() => resolveSession(null, { failed: true })) // 铁律3: failures land renderable
  }

  // After a network-failed verdict, keep re-asking with capped backoff until a
  // real verdict lands (weak-net boot must eventually recover the account
  // WITHOUT the user having to kill and reopen the app).
  function armSessionRetry() {
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      if (sessionSettled || state.status === 'account' || state.status === 'authenticating') return
      askSession()
    }, retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, SESSION_RETRY_MAX_MS)
  }

  // getSession's verdict (or a later resolution while still unsettled)
  function resolveSession(session, { failed = false } = {}) {
    sessionSettled = !failed
    clearTimeout(watchdogTimer)
    if (!failed) {
      clearTimeout(retryTimer)
      retryDelayMs = SESSION_RETRY_BASE_MS
    }
    if (isRealSession(session)) {
      enterAccount(session)
      return
    }
    if (session) {
      // an anonymous session is residue from the pre-rewrite build — guests
      // have no server identity anymore. Drop it and proceed as a plain guest.
      client.auth.signOut().catch(() => {})
    }
    if (state.status === 'authenticating') {
      if (state.flow?.kind === 'oauth') concludeOAuth()
      return // otp: the verify pane stays up, waiting for the code
    }
    if (state.status === 'account') return // a null late-resolution never demotes a live UI
    const snap = state.snapshot
    // NETWORK failure (weak net / offline) while this device's last identity
    // was an account: the token didn't fail — the CHECK failed. Keep playing
    // under the optimistic u_<uid> scope in the degraded-guest presentation
    // (exactly what the 4s watchdog produces) and keep retrying in the
    // background; a later success enters the account with the SAME scope, so
    // nothing remounts. Dumping to the welcome gate here was the 2026-08 弱网
    // bug: the user tapped 游客模式 (or WeChat auto-entered it), flipped into
    // the guest sandbox mid-session, and saw foreign progress ("已学完"),
    // then flipped back once the network recovered. explicitLogout still wins:
    // a logged-out device belongs at the gate regardless of connectivity.
    if (failed && !snap?.explicitLogout && snap?.hadAccount && snap?.lastUserScope?.startsWith('u_')) {
      if (state.status === 'loading') setState({ status: 'guest' })
      armSessionRetry()
      return
    }
    if (snap?.explicitLogout) {
      setState({ status: 'guest', atWelcome: true, session: null })
      return
    }
    // No session, no explicit logout — but this device's LAST identity was a
    // REAL account. Its token merely failed to resolve on this cold start (the
    // iOS home-screen PWA case). Land on the welcome/logged-out gate: the
    // account cache under u_<uid> stays intact and a re-login restores it.
    // There is no mint to overwrite the still-usable refresh token with.
    if (snap?.hadAccount && snap?.lastUserScope?.startsWith('u_')) {
      setState({ status: 'guest', atWelcome: true, session: null })
      return
    }
    // plain guest: local sandbox, zero server involvement
    const next = persist({ lastUserScope: 'guest' })
    setState({ status: 'guest', atWelcome: false, session: null, scope: 'guest', snapshot: next })
  }

  /* ------------------------------------------ OAuth round-trip conclusion */
  // After signInWithOAuth the page fully navigates away; the persisted flow
  // marker lets the next boot restore the pending pane. Verdict rules:
  //  - a real session         → enterAccount (handled by resolveSession/events)
  //  - URL carried an error   → error pane on the launching surface
  //  - no session AND the URL carries no auth params → the user backed out of
  //    the provider page → silent cancel
  //  - URL HAS auth params but no session yet → the code exchange is in
  //    flight; wait for SIGNED_IN (with a timeout so a dropped exchange can't
  //    hang the non-dismissable pending pane forever)
  // the conclude timeout: a dropped code exchange (or a getSession that never
  // settles on an OAuth boot) must not hang the non-dismissable pending pane.
  // The callback stands down while an account entry is in flight — the entry
  // IS the verdict landing (it clears this timer itself on commit).
  function armOAuthConcludeTimer() {
    clearTimeout(oauthTimer)
    oauthTimer = setTimeout(() => {
      if (entriesPending > 0) return
      if (state.status === 'authenticating' && state.flow?.kind === 'oauth') {
        leaveFlow({ error: 'Sign-in timed out. Please try again.' })
      }
    }, OAUTH_CONCLUDE_TIMEOUT_MS)
  }

  function concludeOAuth() {
    if (!(state.status === 'authenticating' && state.flow?.kind === 'oauth')) return
    if (state.urlAuthError) {
      const reason = state.urlAuthError
      setState({ urlAuthError: null })
      leaveFlow({ error: reason })
      return
    }
    if (!hasAuthParamsInUrl) {
      leaveFlow() // silent back-out
      return
    }
    armOAuthConcludeTimer()
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    if (booted) return
    booted = true

    // parse ?error_description / #error_description off the boot URL (OAuth
    // failures come home this way), then scrub it from the address bar
    let urlAuthError = null
    if (typeof window !== 'undefined') {
      try {
        const q = new URLSearchParams(window.location.search)
        const h = new URLSearchParams(window.location.hash.slice(1))
        const err = q.get('error_description') || q.get('error') || h.get('error_description') || h.get('error')
        if (err) {
          urlAuthError = decodeURIComponent(err.replace(/\+/g, ' '))
          window.history.replaceState({}, '', window.location.pathname)
        }
        hasAuthParamsInUrl = /[?#&](code|access_token)=/.test(window.location.search + window.location.hash)
      } catch {}
    }

    // 0ms sync snapshot read → optimistic render scope (铁律8): reuse the last
    // scope until the session says otherwise, so the common path (boot resolves
    // to the same scope as last time) never remounts and nothing flickers.
    const snap = loadSnapshot(now()) // expired flow already cleared on read (铁律1)
    const flow = snap.flow
    setState({
      status: flow ? 'authenticating' : 'loading',
      scope: snap.lastUserScope || 'guest',
      // a restored flow keeps its origin: a welcome-launched flow renders its
      // pending pane over the gate, exactly like the live (un-killed) path
      atWelcome: !!flow && flow.surface === 'welcome',
      flow,
      urlAuthError,
      snapshot: snap,
    })

    // a restored OAuth pane must have a verdict even if getSession never
    // settles — arm the conclude timeout now; every real verdict clears it
    if (flow?.kind === 'oauth') armOAuthConcludeTimer()

    // 铁律2: never hold the first paint hostage — after 4s render as a guest
    // under the optimistic scope and keep resolving in the background. A HUNG
    // getSession (weak-net black hole) never reaches resolveSession, so the
    // watchdog also arms the background retry — otherwise recovery would wait
    // for an app backgrounding/foregrounding cycle. (Harmless if the original
    // call later resolves: a settled verdict stands the retry down.)
    watchdogTimer = setTimeout(() => {
      if (state.status === 'loading') {
        setState({ status: 'guest' })
        armSessionRetry()
      }
    }, WATCHDOG_MS)

    askSession()

    client.auth.onAuthStateChange((event, session) => {
      // handlers read the LATEST state (module-level), never a closure capture.
      // (TOKEN_REFRESH_FAILED is defensive only: @supabase/auth-js 2.x does not
      // emit it — a terminal refresh failure arrives as SIGNED_OUT — but the
      // extra string costs nothing if a future SDK adds the event.)
      if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESH_FAILED') {
        // our own signOut() has already left 'account' by the time this fires —
        // only a death that hits a LIVE account UI is "unintentional"
        if (state.status === 'account') accountSessionDied()
        return
      }
      if (isRealSession(session)) {
        // covers: OAuth coming home, OTP verified in another tab, INITIAL_SESSION
        enterAccount(session)
      }
    })

    if (typeof document !== 'undefined') {
      // Re-ask "am I signed in" on every app wake unless a live account or an
      // in-flight login flow already owns the screen. Two duties:
      //  - a boot whose getSession failed/hung retries (the original duty);
      //  - a NON-account presentation adopts a session that landed in storage
      //    while the page was FROZEN. iOS deep-freezes a just-added home-screen
      //    app mid-handoff (user opens it, glances at the 1s exchange window,
      //    switches away): the clone completes and supabase-js persists the
      //    session, but the SIGNED_IN event thaws into a page that already
      //    settled its verdict as 'guest' — and a settled verdict used to mean
      //    "never ask again", so the icon sat on the guest frame forever
      //    (2026-08-01, reported as "无论怎么等都是 guest"). getSession here is
      //    a local read — re-asking on wake costs nothing.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        if (sessionSettled && (state.status === 'account' || state.status === 'authenticating')) return
        askSession()
      })
    }

    if (typeof window !== 'undefined') {
      // Backing out of the provider page (browser "back") can restore this page
      // from the bfcache: no reload, so boot() never re-runs and the pending
      // pane would hang forever. A bfcache restore while still in an OAuth flow
      // is UNAMBIGUOUS — the user pressed "back" (a success always comes home
      // as a fresh forward navigation carrying a code). Silent cancel.
      window.addEventListener('pageshow', (e) => {
        if (!e.persisted) return
        if (state.status === 'authenticating' && state.flow?.kind === 'oauth') leaveFlow()
      })
    }

    // OAuth coming home with a live flow but no session event yet (or an error
    // in the URL): run the conclusion rules once the session verdict lands —
    // resolveSession calls concludeOAuth. Nothing to do here.
  }

  /* ---------------------------------------------------------------- actions */
  // Every UI entry point goes through these — no component touches supabase.

  // Email code — one call for everyone (shouldCreateUser:true): a registered
  // address gets a login code, a new one gets an account. That is the DESIGNED
  // behavior (蓝图 §11 — the UI's single "Log in or sign up" door says exactly
  // this), not a leftover: the mistyped-email risk it carries is answered by
  // the account-created notice on entry, and data safety never depended on
  // intent in the first place (§3.1 empty-account rule).
  async function startEmail(email, { surface } = {}) {
    // status gate (the old machine whitelisted OTP_REQUESTED the same way): a
    // live account, the boot loading phase, or a pending OAuth round trip must
    // never be clobbered by a stray flow start. Re-requests from a live OTP
    // pane ("Use a different email") are the one authenticating case allowed.
    const ok = state.status === 'guest' || (state.status === 'authenticating' && state.flow?.kind === 'otp')
    if (!ok) return
    const flowSurface = surface ?? state.flow?.surface ?? 'welcome'
    const flow = { kind: 'otp', email, surface: flowSurface, expiresAt: now() + OTP_TTL_MS }
    const snap = persist({ flow, lastEmail: email })
    setState({ status: 'authenticating', flow, error: null, snapshot: snap })
    let sendError = null
    try {
      const { error } = await client.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
        },
      })
      sendError = error
    } catch (err) {
      sendError = err // a thrown rejection (transport layer) is the same verdict
    }
    if (sendError) {
      // state returns to where it came from; the pane shows the error inline.
      // Without this, a THROWN failure would leave a phantom persisted flow
      // that resurrects a verify pane for a code that was never sent.
      leaveFlow()
      throw sendError
    }
  }

  async function verifyEmail(code) {
    // flow-guard: without a live OTP flow there is no email to verify against —
    // never send `email: undefined` to the server (a clean throw for the pane)
    const email = state.flow?.kind === 'otp' ? state.flow.email : null
    if (!email) throw new Error('No email verification in progress.')
    const { data, error } = await client.auth.verifyOtp({ email, token: code, type: 'email' })
    if (error) throw error
    const session = data?.session ?? null
    if (isRealSession(session)) await enterAccount(session)
    // no session in the response → the SIGNED_IN event will carry it
  }

  async function resendEmail() {
    const email = state.flow?.kind === 'otp' ? state.flow.email : null
    if (!email) throw new Error('No email verification in progress.')
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    })
    if (error) throw error
    // the server minted a fresh code — restart the local pane TTL to match
    if (state.flow?.kind === 'otp') {
      const flow = { ...state.flow, expiresAt: now() + OTP_TTL_MS }
      const snap = persist({ flow })
      setState({ flow, snapshot: snap })
    }
  }

  // Google — full-page round trip. The flow marker is persisted BEFORE the
  // navigation so whatever happens after it, the next boot restores the
  // pending pane and concludes properly.
  async function loginWithGoogle({ surface = 'welcome' } = {}) {
    if (state.status !== 'guest') return // same whitelist as the old BIND_STARTED
    const flow = { kind: 'oauth', provider: 'google', surface, expiresAt: now() + OAUTH_TTL_MS }
    const snap = persist({ flow })
    setState({ status: 'authenticating', flow, error: null, snapshot: snap })
    try {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: typeof window !== 'undefined' ? window.location.origin : undefined,
          queryParams: { prompt: 'select_account' },
        },
      })
      if (error) leaveFlow({ error: error.message })
    } catch (err) {
      leaveFlow({ error: err?.message || 'network' })
    }
  }

  // Explicit logout (the intent travels as this call, never a storage flag —
  // 铁律6). Back to the welcome gate; the account's server data loses nothing
  // and its local cache stays for the next optimistic boot.
  function signOut() {
    authEpoch++ // voids any in-flight account entry — logout must stick
    const snap = persist({ explicitLogout: true, flow: null })
    clearTimeout(oauthTimer)
    clearTimeout(retryTimer)
    setState({
      status: 'guest',
      atWelcome: true,
      session: null,
      flow: null,
      error: null,
      snapshot: snap,
    })
    client.auth.signOut().catch(() => {})
  }

  // Welcome page "Guest Mode": enter the device's PERSISTENT guest sandbox.
  // Whatever the guest had before is still there — signing into an account and
  // back never wipes it; only a sign-up that consumed it into a new account
  // resets it (the app's onUpgrade cleared the scope).
  function chooseGuest() {
    if (!(state.status === 'guest' && state.atWelcome)) return
    const snap = persist({ explicitLogout: false, lastUserScope: 'guest' })
    setState({ atWelcome: false, scope: 'guest', snapshot: snap })
  }

  const clearError = () => {
    if (state.error) setState({ error: null })
  }
  const clearNotice = () => {
    if (state.notice) setState({ notice: null })
  }

  /* ------------------------------------------------------------------ api */
  return {
    boot,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getState: () => state,
    loginWithGoogle,
    startEmail,
    verifyEmail,
    resendEmail,
    exitFlow,
    signOut,
    chooseGuest,
    clearError,
    clearNotice,
  }
}
