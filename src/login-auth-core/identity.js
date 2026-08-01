// Display-identity resolution — what to CALL the current player and which
// avatar to show, including across the BOOT WINDOW (铁律8: boot renders the
// account's drawer optimistically; the 4s watchdog can report status:'guest'
// while scope is still u_<uid> and no `user` object is in hand yet). Pure
// scope-storage logic — zero React, zero DOM, zero app key names: the host app
// instantiates createIdentity with ITS storage keys (in authSetup, next to the
// core instance) and re-exports the bound helpers.
//
// The one rule that keeps the boot window honest: these helpers take the SCOPE
// question (`isAccount` = auth.isAccountScope), never "is a token live right
// now" — an account's drawer keeps its name/avatar while the session resolves
// (day-2 mobile cold start: the access token is expired, so the verdict costs
// a network refresh).
import { loadScoped, saveScoped } from './scope.js'

// the name a session itself carries (OAuth display name → email local part)
const sessionNameOf = (user) =>
  user?.user_metadata?.full_name
  || user?.user_metadata?.name
  || (user?.email ? user.email.split('@')[0] : '')

// OAuth providers expose the profile picture under different keys — check
// user_metadata first, then each identity's identity_data. Pure session
// parsing, no storage: usable without a createIdentity instance.
export const oauthAvatarOf = (user) => {
  const m = user?.user_metadata || {}
  const fromIdentities = (user?.identities || [])
    .map((i) => i.identity_data || {})
    .find((d) => d.avatar_url || d.picture)
  return m.avatar_url || m.picture
    || (fromIdentities && (fromIdentities.avatar_url || fromIdentities.picture)) || ''
}

// The app's identity keys (all scoped per account/guest):
//   nameKey        — the user-typed display name; a real account may also
//                    mirror it into Supabase user_metadata (app's business)
//   nameCacheKey   — last identity a LIVE session carried, mirrored into that
//                    account's scope. Without this cache the header flashed
//                    "Guest" over the account's own coins until getSession
//                    finally resolved.
//   avatarCacheKey — same idea for the profile picture
export function createIdentity({ nameKey, nameCacheKey, avatarCacheKey }) {
  // the resolved display name — a user-typed name wins, else the session's own
  // (or the last one seen under this scope), else Guest.
  const displayNameOf = (user, isAccount) => {
    const typed = loadScoped(nameKey, '')
    if (typed) return typed
    if (!isAccount) return 'Guest'
    return sessionNameOf(user) || loadScoped(nameCacheKey, '') || 'Signed in'
  }

  // Mirror a live session's identity into the current (account) scope so the
  // next cold boot can label itself before getSession answers. Write-only
  // cache: it never overrides a live session, and a scope switch remounts the
  // tree, so the value can only ever belong to the account whose drawer it
  // sits in.
  const cacheIdentity = (user) => {
    const name = sessionNameOf(user)
    if (name) saveScoped(nameCacheKey, name)
    const pic = oauthAvatarOf(user)
    if (pic) saveScoped(avatarCacheKey, pic)
  }

  // the account's picture when no session is in hand yet (boot window only —
  // a live session's own avatar always wins over this)
  const cachedAvatarOf = () => loadScoped(avatarCacheKey, '')

  return { displayNameOf, cacheIdentity, cachedAvatarOf }
}
