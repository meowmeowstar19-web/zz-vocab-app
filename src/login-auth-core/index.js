// login-auth-core public API. Portable: the host app feeds createAuthCore a
// Supabase client + an onUpgrade callback (its own guest→account data move),
// binds createIdentity to its own storage keys, and gets the same engine —
// nothing in here knows which app it is serving. Porting contract: README.md.
export { createAuthCore, OTP_TTL_MS, OAUTH_TTL_MS, WATCHDOG_MS } from './store.js'
export { createUseAuth } from './useAuth.js'
export { attachSessionMirror, readMirror, MIRROR_COOKIE, ACCESS_COOKIE, CLONE_FN, HANDOFF_LOG_KEY } from './sessionMirror.js'
export { createIdentity, oauthAvatarOf } from './identity.js'
export { loadSnapshot, saveSnapshot, clearSnapshot, defaultSnapshot, SNAPSHOT_KEY } from './snapshot.js'
export {
  setScope,
  getScope,
  scopedKey,
  loadScoped,
  saveScoped,
  clearScope,
} from './scope.js'
