// login-auth-core public API. Portable: the next app feeds createAuthCore a
// Supabase client + an onUpgrade callback (its own guest→account data move)
// and gets the same engine — nothing in here knows about miracleZZ.
export { createAuthCore, OTP_TTL_MS, OAUTH_TTL_MS, WATCHDOG_MS } from './store.js'
export { createUseAuth } from './useAuth.js'
export { attachSessionMirror, MIRROR_COOKIE, ACCESS_COOKIE, CLONE_FN } from './sessionMirror.js'
export {
  displayNameOf,
  oauthAvatarOf,
  cacheIdentity,
  cachedAvatarOf,
  NAME_KEY,
  NAME_MAX,
  NAME_CACHE_KEY,
  AVATAR_CACHE_KEY,
} from './identity.js'
export { loadSnapshot, saveSnapshot, clearSnapshot, defaultSnapshot, SNAPSHOT_KEY } from './snapshot.js'
export {
  setScope,
  getScope,
  scopedKey,
  loadScoped,
  saveScoped,
  scopeHasData,
  clearScope,
  mergeData,
  mergeScopes,
  GAME_KEYS,
} from './scope.js'
