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
// Redemption CLONES; it does not refresh. refreshSession({refresh_token})
// ROTATES the token, so the browser container that shares the cookie is left
// holding a stale one — its next use trips Supabase's refresh-token-reuse
// detection and revokes the whole family (both containers logged out a day
// later; this actually happened, twice). The clone path instead asks the
// 'clone-session' Edge Function to verify the mirrored tokens (access token
// first — getUser consumes nothing, so the browser's session survives intact)
// and mint a magiclink token_hash, which verifyOtp turns into a brand-new
// INDEPENDENT session — a different token family, invisible to reuse
// detection.
//
// When the clone path can't answer (function down, CORS, plane mode) the
// handoff simply DOESN'T happen: the PWA opens at the login gate, the cookies
// stay for the next boot, and — crucially — nothing rotates. That "harmless
// fallback" to refreshSession is what made a mere deploy slip catastrophic:
// 2026-07-24's domain rename left the deployed function allowing the old
// origin, so every clone hit CORS, silently fell through to the rotating path,
// and killed BOTH containers a day or two later. A missing handoff costs one
// re-login; a rotated shared token costs the account on every device. So the
// exchange is now opt-in (`allowRefreshFallback`), and ONLY safe for a project
// with refresh-token rotation turned OFF — where the token never rotates and
// reuse detection has nothing to detect. A client with no functions API at all
// (another app carrying this core, no Edge Function deployed) still gets it:
// there is no clone to prefer, so refusing would just mean "never works".
//
// Core module (zero React, zero game imports — same charter as store.js):
// everything hangs off public client.auth/client.functions of the injected
// client, so the app's wiring point (authSetup in Muku Fuku) just calls
// attachSessionMirror(client) once.

export const MIRROR_COOKIE = 'la_rt' // login-auth refresh token (app-neutral name)
export const ACCESS_COOKIE = 'la_at' // login-auth access token (feeds the clone path)
export const CLONE_FN = 'clone-session' // Edge Function name, same in every app that carries the core
// Safari trims a JS-written cookie to 7 days no matter what we ask for, so this
// number only ever BUYS time elsewhere: Chrome/Android honour it (capped at
// their own 400-day ceiling), which is what lets a home screen added months
// after the last visit still inherit a login there.
const MAX_AGE = 400 * 24 * 3600
const MAX_VALUE = 3800 // stay under the ~4KB single-cookie cap; an oversize JWT is skipped, not truncated

// Clone verdicts. The distinction that matters is REJECTED (the server looked
// at these tokens and said no — they are dead, drop them) versus UNAVAILABLE
// (we never got an answer — keep them and try again next boot, since the
// tokens may well still be good and the outage is ours).
const CLONE_OK = 'ok'
const CLONE_REJECTED = 'rejected'
const CLONE_UNAVAILABLE = 'unavailable'

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

// REJECTED is reserved for the function's OWN 401 — `{"error":"unauthorized"}`,
// the single answer in it that means the mirrored tokens are dead (it checks
// the access token, then the refresh token, and only then says this).
//
// Everything else is UNAVAILABLE, and the status alone is NOT enough to tell
// them apart: a 404 means the same-origin rewrite never shipped, a 403 or a
// bare 401 can come from the gateway when verify_jwt sees a bad anon key, a
// 5xx is the function breaking — none of those are a verdict on the tokens,
// and clearing the cookies over one throws away a live handoff. So the body
// has to say so too.
const isDeadTokenAnswer = (status, body) => status === 401 && body?.error === 'unauthorized'

// Transport 1 — SAME-ORIGIN. The host rewrites this path to the very same Edge
// Function, and a same-origin request runs no CORS check at all: no preflight,
// no Access-Control-Allow-Origin to get wrong. That check is exactly what took
// the handoff down when the domain was renamed and the deployed function kept
// allowing the dead origin, so the proxy retires that entire failure mode —
// a future rename, a stale allowlist, a forgotten `functions deploy` of a CORS
// edit can no longer reach this path.
//
// The Edge Function runs with verify_jwt on, so the gateway wants a JWT: the
// anon key (a real JWT on this project) is what functions.invoke would have
// attached, and the app passes it in as cloneApiKey.
function mintViaProxy(endpoint, apiKey, body) {
  if (!endpoint || typeof fetch !== 'function') return Promise.resolve({ verdict: CLONE_UNAVAILABLE })
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { apikey: apiKey, Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  })
    .then((res) =>
      res
        .json()
        .catch(() => null) // a rewrite that answered with someone else's HTML
        .then((parsed) => {
          if (!res.ok) return { verdict: isDeadTokenAnswer(res.status, parsed) ? CLONE_REJECTED : CLONE_UNAVAILABLE }
          return parsed?.token_hash
            ? { verdict: CLONE_OK, tokenHash: parsed.token_hash }
            : { verdict: CLONE_UNAVAILABLE }
        }),
    )
    .catch(() => ({ verdict: CLONE_UNAVAILABLE }))
}

// Transport 2 — the portable direct call. Still the only path for an app that
// carries this core without a same-origin rewrite (and the net under a proxy
// that 404s because the host config didn't ship).
function mintViaInvoke(client, body) {
  if (typeof client.functions?.invoke !== 'function') return Promise.resolve({ verdict: CLONE_UNAVAILABLE })
  return client.functions
    .invoke(CLONE_FN, { body })
    .then(({ data, error }) => {
      if (!error) {
        return data?.token_hash ? { verdict: CLONE_OK, tokenHash: data.token_hash } : { verdict: CLONE_UNAVAILABLE }
      }
      // supabase-js hands a non-2xx back as FunctionsHttpError with the raw
      // Response on .context — the only place the body is still readable.
      const ctx = error?.context
      if ((ctx?.status ?? error?.status) !== 401 || typeof ctx?.json !== 'function') {
        return { verdict: CLONE_UNAVAILABLE }
      }
      return ctx
        .json()
        .then((parsed) => ({ verdict: isDeadTokenAnswer(401, parsed) ? CLONE_REJECTED : CLONE_UNAVAILABLE }))
        .catch(() => ({ verdict: CLONE_UNAVAILABLE }))
    })
    .catch(() => ({ verdict: CLONE_UNAVAILABLE }))
}

// Clone path: mirrored tokens → token_hash → verifyOtp → a new independent
// session. Resolves a verdict, never throws. A REJECTED verdict is final (the
// server judged these tokens; the other transport would only hear the same
// answer), an UNAVAILABLE one falls through to the next transport.
//
// verifyOtp failing on a hash the server was willing to mint is UNAVAILABLE
// too, not REJECTED: identity was already proven, so the tokens are alive and
// the OTP leg is ours to retry.
function redeemClone(client, opts, accessToken, refreshToken) {
  const body = { access_token: accessToken || undefined, refresh_token: refreshToken || undefined }
  return mintViaProxy(opts.cloneEndpoint, opts.cloneApiKey, body)
    .then((r) => (r.verdict === CLONE_UNAVAILABLE ? mintViaInvoke(client, body) : r))
    .then(({ verdict, tokenHash }) => {
      if (verdict !== CLONE_OK) return verdict
      return client.auth
        .verifyOtp({ type: 'magiclink', token_hash: tokenHash })
        .then(({ data: v, error: vErr }) => (!vErr && v?.session ? CLONE_OK : CLONE_UNAVAILABLE))
        .catch(() => CLONE_UNAVAILABLE)
    })
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

// A breadcrumb, because SILENCE is what made the CORS regression expensive:
// every failure here is caught and swallowed by design (a broken handoff must
// never break the app), so a handoff that had been dead for four days looked
// exactly like a handoff that was never attempted. One line of last-attempt
// outcome turns "why does it keep logging me out" into something the phone can
// answer by itself — boot.js paints it into the ?diag=1 panel.
//
// Outcome + timestamp ONLY. No token, no fragment of one, nothing that leaves
// the device: this is a local note, not telemetry.
export const HANDOFF_LOG_KEY = 'la.handoff.last'

function noteHandoff(outcome) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(HANDOFF_LOG_KEY, `${new Date().toISOString()} ${outcome}`)
  } catch {}
}

export function attachSessionMirror(
  client,
  doc = typeof document !== 'undefined' ? document : null,
  options = {},
) {
  const { allowRefreshFallback = false } = options
  if (!doc) return Promise.resolve()

  const clearMirrors = () => {
    writeMirror(doc, null)
    writeMirror(doc, null, ACCESS_COOKIE)
  }

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      clearMirrors()
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
      const canClone = !!options.cloneEndpoint || typeof client.functions?.invoke === 'function'
      return redeemClone(client, options, at, rt).then((verdict) => {
        // on success the cookies re-stamp themselves via the SIGNED_IN event above
        if (verdict === CLONE_OK) return noteHandoff('clone ok')
        if (verdict === CLONE_REJECTED) {
          noteHandoff('clone rejected — mirrored tokens are dead, cookies cleared')
          return clearMirrors() // dead tokens: never retried
        }
        // UNAVAILABLE. Spending the refresh token here would rotate a token a
        // sibling container may still hold — the family-revoking move. Only a
        // client that could never clone, or a project that opted in by turning
        // rotation off, takes that path; everyone else keeps the cookies and
        // retries on the next boot (one request, no damage).
        if (canClone && !allowRefreshFallback) {
          return noteHandoff('clone UNREACHABLE — no handoff this boot, cookies kept, will retry')
        }
        return redeemRefresh(client, rt).then((ok) => {
          noteHandoff(ok ? 'refresh-fallback ok' : 'refresh-fallback rejected — cookies cleared')
          if (!ok) clearMirrors()
        })
      })
    })
    .catch(() => {}) // a hung/failed getSession is the auth core's problem (watchdog), not ours
}
