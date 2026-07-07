// Bridge layer: supabase events → machine events; machine effects → supabase
// calls. One module-level store shared by every useAuth() caller — event
// callbacks always read the LATEST state from here, never from a React
// closure (铁律4).
import { useSyncExternalStore } from 'react'
import { supabase } from './supabase.js'
import { transition, initialState, STATUS } from './machine.js'
import { loadSnapshot, saveSnapshot } from './storage.js'
import { mergeScopes } from './scopedStorage.js'

/* ------------------------------------------------------------------ store */
const store = {
  state: initialState(),
  notice: null, // 'session-expired' | null — transient banner for the app
  urlAuthError: null, // ?error_description=… parsed off the boot URL
  listeners: new Set(),
  booted: false,
}
const emit = () => store.listeners.forEach((l) => l())

let watchdogTimer = null
let bindConcludeTimer = null

function dispatch(event) {
  const { state, effects } = transition(store.state, event)
  store.state = state
  emit()
  effects.forEach(runEffect)
  // the hook-side bind conclusion can only be judged AFTER the machine has
  // recorded the resolved session (see concludeBindIfPossible)
  if (event.type === 'SESSION_RESOLVED') concludeBindIfPossible()
}

/* -------------------------------------------------------------- effects */
function runEffect(fx) {
  switch (fx.type) {
    case 'getSession':
      // 铁律3: the failure path MUST land in a renderable state
      supabase.auth
        .getSession()
        .then(({ data }) => dispatch({ type: 'SESSION_RESOLVED', session: data?.session ?? null }))
        .catch((error) => dispatch({ type: 'SESSION_FAILED', error }))
      break
    case 'startWatchdog':
      clearTimeout(watchdogTimer)
      watchdogTimer = setTimeout(() => dispatch({ type: 'WATCHDOG_FIRED' }), fx.ms)
      break
    case 'stopWatchdog':
      clearTimeout(watchdogTimer)
      break
    case 'mintAnon': {
      // exponential backoff: 0s, 1s, 2s (铁律7)
      const delay = fx.attempt === 1 ? 0 : 500 * 2 ** (fx.attempt - 1)
      setTimeout(() => {
        supabase.auth
          .signInAnonymously()
          .then(({ data, error }) => {
            if (error || !data?.session) dispatch({ type: 'ANON_FAILED', error })
            else dispatch({ type: 'ANON_MINTED', session: data.session })
          })
          .catch((error) => dispatch({ type: 'ANON_FAILED', error }))
      }, delay)
      break
    }
    case 'ensureAnon':
      // 铁律5: a pending-flow exit restores the anon session if the flow ate it
      supabase.auth
        .getSession()
        .then(({ data }) => {
          if (data?.session) dispatch({ type: 'SESSION_RESOLVED', session: data.session })
          else runEffect({ type: 'mintAnon', attempt: 1 })
        })
        .catch(() => runEffect({ type: 'mintAnon', attempt: 1 }))
      break
    case 'saveSnapshot':
      saveSnapshot(fx.patch, Date.now())
      break
    case 'mergeScopes':
      // synchronous on purpose: runs before React re-renders for the new
      // scope, so the remounted tree reads the already-merged wardrobe
      mergeScopes(fx.from, fx.to)
      break
    case 'supabaseSignOut':
      supabase.auth.signOut().catch(() => {})
      break
    case 'notify':
      store.notice = fx.kind
      emit()
      break
    case 'oauthRedirect':
      runOAuthRedirect(fx.provider, fx.mode)
      break
    // sendOtp / sendBindEmail are executed by the api functions below so the
    // form can await them and show inline errors; nothing to do here.
    case 'sendOtp':
    case 'sendBindEmail':
      break
    default:
      break
  }
}

// full-page OAuth round trip. The snapshot bind marker is already persisted
// (machine wrote it before emitting this effect), so whatever happens after
// the navigation, the next BOOT can restore the pending pane.
async function runOAuthRedirect(provider, mode) {
  const options = {
    redirectTo: window.location.origin,
    queryParams: provider === 'google' ? { prompt: 'select_account' } : undefined,
  }
  try {
    if (mode === 'bind') {
      // linkIdentity needs a live session — mint one if the background anon
      // sign-in hasn't landed yet (PW's safety net, moved into the effect)
      const { data } = await supabase.auth.getSession()
      if (!data?.session) {
        const { error: anonErr } = await supabase.auth.signInAnonymously()
        if (anonErr) return dispatch({ type: 'BIND_REJECTED', reason: anonErr.message })
      }
      const { error } = await supabase.auth.linkIdentity({ provider, options })
      if (error) dispatch({ type: 'BIND_REJECTED', reason: error.message })
    } else {
      const { error } = await supabase.auth.signInWithOAuth({ provider, options })
      if (error) dispatch({ type: 'BIND_REJECTED', reason: error.message })
    }
  } catch (err) {
    dispatch({ type: 'BIND_REJECTED', reason: err?.message || 'network' })
  }
}

/* ----------------------------------------------- OAuth return conclusion */
// After an OAuth round trip BOOT restores BINDING; the machine records the
// resolved session and waits for the hook to call the verdict. Rules:
//  - non-anon session      → BIND_OK (works for both bind & login modes)
//  - URL carried an error  → BIND_REJECTED(reason) → modal error pane
//  - plain anon session and the URL carried no auth params → the user backed
//    out of the provider page → silent cancel
//  - URL HAS auth params but no session yet → the code exchange is in flight;
//    wait for SIGNED_IN (with a timeout so a dropped exchange can't hang the
//    non-dismissable pending pane forever)
let hasAuthParamsInUrl = false
function concludeBindIfPossible() {
  const s = store.state
  if (s.status !== STATUS.BINDING) return
  if (s.bind?.provider === 'email') return // email bind concludes via verifyBind
  const session = s.session
  if (session && !session.user?.is_anonymous) {
    clearTimeout(bindConcludeTimer)
    dispatch({ type: 'BIND_OK', session })
  } else if (store.urlAuthError) {
    const reason = store.urlAuthError
    store.urlAuthError = null
    clearTimeout(bindConcludeTimer)
    dispatch({ type: 'BIND_REJECTED', reason })
  } else if (!hasAuthParamsInUrl) {
    clearTimeout(bindConcludeTimer)
    dispatch({ type: 'BIND_REJECTED', reason: null }) // silent back-out
  } else {
    clearTimeout(bindConcludeTimer)
    bindConcludeTimer = setTimeout(() => {
      if (store.state.status === STATUS.BINDING) {
        dispatch({ type: 'BIND_REJECTED', reason: 'Sign-in timed out. Please try again.' })
      }
    }, 10_000)
  }
}

/* ------------------------------------------------------------------ boot */
function boot() {
  if (store.booted) return
  store.booted = true

  // parse ?error_description / #error_description off the boot URL (OAuth
  // failures come home this way), then scrub it from the address bar
  try {
    const q = new URLSearchParams(window.location.search)
    const h = new URLSearchParams(window.location.hash.slice(1))
    const err = q.get('error_description') || q.get('error') || h.get('error_description') || h.get('error')
    if (err) {
      store.urlAuthError = decodeURIComponent(err.replace(/\+/g, ' '))
      window.history.replaceState({}, '', window.location.pathname)
    }
    hasAuthParamsInUrl = /[?#&](code|access_token)=/.test(window.location.search + window.location.hash)
  } catch {}

  // 0ms sync snapshot read → optimistic render scope (铁律8); the machine
  // fires getSession + the 4s watchdog from this one event.
  dispatch({ type: 'BOOT', snapshot: loadSnapshot(Date.now()), now: Date.now() })

  supabase.auth.onAuthStateChange((event, session) => {
    const st = store.state // latest, not a closure capture (铁律4)
    if (event === 'SIGNED_OUT') {
      // our own machinery signs out on purpose in these states — only a
      // signout that hits a LIVE authed/guest UI is "unintentional"
      if (st.status === STATUS.AUTHED || st.status === STATUS.GUEST_ANON) {
        dispatch({ type: 'SIGNED_OUT', intentional: false })
      }
      return
    }
    if (event === 'TOKEN_REFRESH_FAILED') {
      dispatch({ type: 'TOKEN_REFRESH_FAILED' })
      return
    }
    if (session) dispatch({ type: 'SESSION_RESOLVED', session })
  })

  // 铁律7: a failed mint retries on the next app wake
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') dispatch({ type: 'APP_RESUMED' })
  })
}

/* -------------------------------------------------------------- actions */
// Every UI entry point goes through these — no component touches supabase.

async function requestOtp(email) {
  dispatch({ type: 'OTP_REQUESTED', email, now: Date.now() })
  // The guest's anon session stays LIVE through the whole flow. PW's lesson
  // ("signInWithOtp silently no-ops when a session is live") does not hold on
  // current SDKs — verified against @supabase/auth-js 2.x: /otp is a plain
  // apikey request that never looks at the stored session, and /verify
  // unconditionally overwrites it on success. Signing out here is what used
  // to orphan the guest's wardrobe (2026-07-06 bug); a session that
  // genuinely dies mid-flow is covered by exitPending's ensureAnon + the
  // scope merge on re-mint. NOTE: signOut(scope:'local') + setSession-restore
  // is NOT a viable alternative — /logout revokes the current session
  // server-side even with scope 'local' (it only spares OTHER devices).
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: window.location.origin },
  })
  if (error) {
    dispatch({ type: 'OTP_EXIT' }) // session untouched — the pane shows the error in place
    throw error
  }
}

async function verifyOtp(email, code) {
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' })
  if (error) throw error
  dispatch({ type: 'OTP_VERIFIED', session: data?.session ?? null })
}

function exitOtp() {
  dispatch({ type: 'OTP_EXIT' })
}

async function bindEmail(email, surface) {
  dispatch({ type: 'BIND_STARTED', provider: 'email', mode: 'bind', surface, email, now: Date.now() })
  // updateUser({email}) keeps the anon uid — zero migration (the whole point)
  const { data } = await supabase.auth.getSession()
  if (!data?.session) {
    const { error: anonErr } = await supabase.auth.signInAnonymously()
    if (anonErr) {
      dispatch({ type: 'OTP_EXIT' })
      throw anonErr
    }
  }
  const { error } = await supabase.auth.updateUser({ email })
  if (error) {
    dispatch({ type: 'OTP_EXIT' })
    throw error
  }
}

async function verifyBind(email, code) {
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email_change' })
  if (error) throw error
  dispatch({ type: 'BIND_OK', session: data?.session ?? null })
}

async function resendOtp(email, isBind) {
  // Bind resend must NOT use auth.resend({type:'email_change'}): GoTrue's
  // /resend looks the user up by their CURRENT email, and the bind flow's
  // user is anonymous (current email empty, the address is only pending in
  // new_email) — so it never finds them and silently 200s WITHOUT sending
  // (anti-enumeration). Verified live 2026-07-07: 200 {} and
  // email_change_sent_at untouched. Re-calling updateUser({email}) on the
  // live anon session regenerates the code and actually resends.
  const { error } = isBind
    ? await supabase.auth.updateUser({ email })
    : await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
  if (error) throw error
  // the server minted a fresh code — restart the local pane TTL to match
  dispatch({ type: 'RESENT', now: Date.now() })
}

function signInOAuth(provider, surface) {
  dispatch({ type: 'BIND_STARTED', provider, mode: 'login', surface, now: Date.now() })
}

function bindOAuth(provider, surface) {
  dispatch({ type: 'BIND_STARTED', provider, mode: 'bind', surface, now: Date.now() })
}

function signOut() {
  dispatch({ type: 'SIGNED_OUT', intentional: true }) // 铁律6: intent as payload
}

function chooseGuest() {
  dispatch({ type: 'GUEST_CHOSEN' })
}

function clearBindError() {
  dispatch({ type: 'BIND_ERROR_CLEARED' }) // through the machine — no side-channel mutations
}

function clearNotice() {
  store.notice = null
  emit()
}

/* ------------------------------------------------------------------ hook */
const subscribe = (cb) => {
  store.listeners.add(cb)
  return () => store.listeners.delete(cb)
}
const getSnapshotState = () => store.state
const getNotice = () => store.notice

export function useAuth() {
  boot()
  const state = useSyncExternalStore(subscribe, getSnapshotState)
  const notice = useSyncExternalStore(subscribe, getNotice)
  return {
    status: state.status,
    session: state.session,
    userScope: state.userScope,
    isRealAccount: state.status === STATUS.AUTHED,
    ready: state.status !== STATUS.INITIALIZING, // watchdog guarantees ≤4s
    hadAccount: !!state.snapshot?.hadAccount,
    lastEmail: state.snapshot?.lastEmail ?? null,
    otp: state.otp, // { email, expiresAt } while OTP_PENDING
    otpReturn: state.otpReturn, // status OTP_EXIT falls back to
    bind: state.bind, // { provider, surface, mode, … } while BINDING
    bindError: state.bindError,
    notice,
    urlAuthError: store.urlAuthError,
    requestOtp,
    verifyOtp,
    exitOtp,
    bindEmail,
    verifyBind,
    resendOtp,
    signInOAuth,
    bindOAuth,
    signOut,
    chooseGuest,
    clearBindError,
    clearNotice,
  }
}

export { STATUS }
