// iOS "添加到主屏幕" login handoff. When a site is added to the Home Screen as a
// standalone web app, iOS copies ONLY its cookies into the new app container —
// localStorage (where supabase-js persists the session) arrives empty, so the
// PWA used to boot logged-out (Safari 17 release notes: "logged in … only if
// the authentication state is stored within cookies").
//
// Mirror = two tiny cookies: the refresh token (~150 bytes) and the access
// token (a ~1KB JWT). Two duties:
//   1. keep the cookies current: every auth event with a session rewrites them
//      (restarting Safari ITP's 7-day clock on JS-written cookies); an
//      intentional/terminal SIGNED_OUT clears them so a dead login can't
//      resurrect.
//   2. redeem on boot: no persisted session but mirror cookies present →
//      exchange them for a full session. Success surfaces through the normal
//      onAuthStateChange path (the auth core's isRealSession handler), so this
//      module never touches auth state directly. Tokens the exchange rejects
//      are cleared — never retried on every boot.
//
// Redemption prefers CLONING over refreshing. refreshSession({refresh_token})
// ROTATES the token, so the browser container that shares the cookie is left
// holding a stale one — its next use trips Supabase's refresh-token-reuse
// detection and revokes the whole family (both containers logged out a day
// later; this actually happened). The clone path instead asks the
// 'clone-session' Edge Function to verify the mirrored tokens (access token
// first — getUser consumes nothing, so the browser's session survives intact)
// and mint a magiclink token_hash, which verifyOtp turns into a brand-new
// INDEPENDENT session — a different token family, invisible to reuse
// detection. Any failure anywhere in the clone path falls back to the old
// refreshSession exchange, so the handoff never gets worse than it was.
//
// Core module (zero React, zero game imports — same charter as store.js):
// everything hangs off public client.auth/client.functions of the injected
// client, so the app's wiring point (authSetup in miracleZZ) just calls
// attachSessionMirror(client) once.

export const MIRROR_COOKIE = 'la_rt' // login-auth refresh token (app-neutral name)
export const ACCESS_COOKIE = 'la_at' // login-auth access token (feeds the clone path)
export const CLONE_FN = 'clone-session' // Edge Function name, same in every app that carries the core
const MAX_AGE = 7 * 24 * 3600 // ITP caps JS-written cookies at 7 days anyway
const MAX_VALUE = 3800 // stay under the ~4KB single-cookie cap; an oversize JWT is skipped, not truncated

export function readMirror(doc, name = MIRROR_COOKIE) {
  try {
    const m = doc.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}

export function writeMirror(doc, token, name = MIRROR_COOKIE) {
  // Secure is dropped by some browsers on plain-http dev — harmless there, the
  // handoff only matters on the https production origin.
  try {
    const value = token ? encodeURIComponent(token) : ''
    doc.cookie = token && value.length <= MAX_VALUE
      ? `${name}=${value}; Max-Age=${MAX_AGE}; Path=/; SameSite=Lax; Secure`
      : `${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure`
  } catch {}
}

// Clone path: mirrored tokens → Edge Function → token_hash → verifyOtp → a new
// independent session. Resolves false on ANY miss (no functions API on the
// client, invoke error, no hash, verifyOtp rejection) — never throws.
function redeemClone(client, accessToken, refreshToken) {
  if (typeof client.functions?.invoke !== 'function') return Promise.resolve(false)
  return client.functions
    .invoke(CLONE_FN, {
      body: { access_token: accessToken || undefined, refresh_token: refreshToken || undefined },
    })
    .then(({ data, error }) => {
      if (error || !data?.token_hash) return false
      return client.auth
        .verifyOtp({ type: 'magiclink', token_hash: data.token_hash })
        .then(({ data: v, error: vErr }) => !vErr && !!v?.session)
    })
    .catch(() => false)
}

// Legacy path (and the safety net under the clone path): spend the mirrored
// refresh token directly. Works, but leaves the sibling container's copy stale
// — kept only as fallback.
function redeemRefresh(client, refreshToken) {
  if (!refreshToken) return Promise.resolve(false)
  return client.auth
    .refreshSession({ refresh_token: refreshToken })
    .then(({ data, error }) => !error && !!data?.session)
    .catch(() => false)
}

export function attachSessionMirror(client, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return Promise.resolve()

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      writeMirror(doc, null)
      writeMirror(doc, null, ACCESS_COOKIE)
    } else if (session?.refresh_token) {
      writeMirror(doc, session.refresh_token)
      writeMirror(doc, session.access_token ?? null, ACCESS_COOKIE)
    }
  })

  return client.auth
    .getSession()
    .then(({ data }) => {
      if (data?.session) return // normal boot — the INITIAL_SESSION event above already re-stamped the cookies
      const rt = readMirror(doc)
      const at = readMirror(doc, ACCESS_COOKIE)
      if (!rt && !at) return
      return redeemClone(client, at, rt)
        .then((ok) => ok || redeemRefresh(client, rt))
        .then((ok) => {
          if (!ok) {
            writeMirror(doc, null) // both paths rejected the handoff — clear so it never retries every boot
            writeMirror(doc, null, ACCESS_COOKIE)
          }
          // on success the cookies re-stamp themselves via the SIGNED_IN event above
        })
    })
    .catch(() => {}) // a hung/failed getSession is the auth core's problem (watchdog), not ours
}
