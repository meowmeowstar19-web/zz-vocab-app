// Display-identity resolution — what to CALL the current player and which
// avatar to show, including across the BOOT WINDOW (铁律8: boot renders the
// account's drawer optimistically; the 4s watchdog can report status:'guest'
// while scope is still u_<uid> and no `user` object is in hand yet). Pure
// scope-storage logic — zero React, zero DOM — extracted out of the app's
// AccountPage so the whole "who am I looking at" question lives in the core.
//
// The one rule that keeps the boot window honest: these helpers take the SCOPE
// question (`isAccount` = auth.isAccountScope), never "is a token live right
// now" — an account's drawer keeps its name/avatar while the session resolves
// (day-2 mobile cold start: the access token is expired, so the verdict costs
// a network refresh).
import { loadScoped, saveScoped } from './scope.js'

// user-chosen display name (scoped per account/guest, like the avatar); a
// real account also mirrors it into Supabase user_metadata.full_name
export const NAME_KEY = 'miraclezz.name.v1'
export const NAME_MAX = 20
// Last identity a LIVE session carried, mirrored into that account's scope.
// Without this cache the header flashed "Guest" over the account's own coins
// until getSession finally resolved.
export const NAME_CACHE_KEY = 'miraclezz.nameCache.v1'
export const AVATAR_CACHE_KEY = 'miraclezz.avatarCache.v1'

// the name a session itself carries (OAuth display name → email local part)
const sessionNameOf = (user) =>
  user?.user_metadata?.full_name
  || user?.user_metadata?.name
  || (user?.email ? user.email.split('@')[0] : '')

// the resolved display name — a user-typed name wins, else the session's own
// (or the last one seen under this scope), else Guest.
export const displayNameOf = (user, isAccount) => {
  const typed = loadScoped(NAME_KEY, '')
  if (typed) return typed
  if (!isAccount) return 'Guest'
  return sessionNameOf(user) || loadScoped(NAME_CACHE_KEY, '') || 'Signed in'
}

// OAuth providers expose the profile picture under different keys — check
// user_metadata first, then each identity's identity_data.
export const oauthAvatarOf = (user) => {
  const m = user?.user_metadata || {}
  const fromIdentities = (user?.identities || [])
    .map((i) => i.identity_data || {})
    .find((d) => d.avatar_url || d.picture)
  return m.avatar_url || m.picture
    || (fromIdentities && (fromIdentities.avatar_url || fromIdentities.picture)) || ''
}

// Mirror a live session's identity into the current (account) scope so the next
// cold boot can label itself before getSession answers. Write-only cache: it
// never overrides a live session, and a scope switch remounts the tree, so the
// value can only ever belong to the account whose drawer it sits in.
export function cacheIdentity(user) {
  const name = sessionNameOf(user)
  if (name) saveScoped(NAME_CACHE_KEY, name)
  const pic = oauthAvatarOf(user)
  if (pic) saveScoped(AVATAR_CACHE_KEY, pic)
}
// the account's picture when no session is in hand yet (boot window only —
// a live session's own avatar always wins over this)
export const cachedAvatarOf = () => loadScoped(AVATAR_CACHE_KEY, '')
