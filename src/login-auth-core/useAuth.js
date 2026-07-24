// Thin React binding over a createAuthCore() instance — the ONLY way the app
// and login-auth-ui read auth state. useSyncExternalStore keeps every caller
// on the same store snapshot (no per-component closures of stale state).
import { useSyncExternalStore } from 'react'

export function createUseAuth(core) {
  return function useAuth() {
    core.boot() // idempotent; first hook call starts the engine (as before)
    const s = useSyncExternalStore(core.subscribe, core.getState)
    return {
      // state
      status: s.status, // 'loading' | 'guest' | 'account' | 'authenticating'
      session: s.session,
      user: s.session?.user ?? null,
      userScope: s.scope, // the drawer the game stores under
      ready: s.status !== 'loading', // watchdog guarantees ≤4s
      isRealAccount: s.status === 'account', // a LIVE session exists right now
      // Does the drawer we're playing out of belong to an account? True through
      // the whole boot window, including the watchdog's degraded guest (铁律2:
      // status flips to 'guest' at 4s while `scope` stays the optimistic
      // u_<uid> — see the watchdog test in store.test.js). Ask THIS, not
      // isRealAccount, for anything that follows the DATA (whose name/avatar to
      // show, whether mutations must be logged for the server). Ask
      // isRealAccount only when a token is needed this instant.
      isAccountScope: typeof s.scope === 'string' && s.scope.startsWith('u_'),
      atWelcome: s.atWelcome, // guest presentation: welcome gate vs playing
      flow: s.flow, // { kind:'otp'|'oauth', email?, provider?, surface, expiresAt } | null
      error: s.error, // login-flow error for the modal/welcome error pane
      notice: s.notice, // 'session-expired' | 'account-created' | 'welcome-back' | null
      urlAuthError: s.urlAuthError,
      hadAccount: !!s.snapshot?.hadAccount,
      lastEmail: s.snapshot?.lastEmail ?? null,
      // actions
      loginWithGoogle: core.loginWithGoogle,
      startEmail: core.startEmail,
      verifyEmail: core.verifyEmail,
      resendEmail: core.resendEmail,
      exitFlow: core.exitFlow,
      signOut: core.signOut,
      chooseGuest: core.chooseGuest,
      clearError: core.clearError,
      clearNotice: core.clearNotice,
    }
  }
}
