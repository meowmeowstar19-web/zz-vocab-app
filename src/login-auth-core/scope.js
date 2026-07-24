// Per-user localStorage scoping. Every persisted game key lives under
// `<scope>.<name>`. There are exactly two kinds of scope:
//   'guest'   — the device's ONE persistent guest sandbox (local-only; a guest
//               has NO server identity in Plan B — the server is never
//               consulted for a guest, see data/economy.js)
//   'u_<uid>' — a signed-in account (a cache mirror of the server-authoritative
//               state; the server is the source of truth)
//
// 'guest' is a NORMAL scope with its own `guest.` prefix. A guest starts from
// ONLY its own `guest.*` keys: fresh per browser, always 0 on a browser that
// has never played. The lone merge in the whole system is Sign-Up-into-an-
// EMPTY-account: the app's onUpgrade folds the guest sandbox into the freshly
// created account (mergeScopes) and then clears 'guest'. Signing INTO an
// existing account never merges — it enters the account untouched and leaves
// 'guest' on disk, so returning to guest restores the same sandbox.
//
// (The old reconcileGuestScopeOnce migration — recovering data stranded under
// per-anon-uid scopes — is gone: anonymous sessions no longer exist, and the
// single real user was migrated long ago.)

// every persisted game key (unscoped names; epoch v5)
const GAME_KEYS = [
  'miraclezz.coins.v5',
  'miraclezz.owned.v5',
  'miraclezz.claimed.v5',
  'miraclezz.daily.v5',
  'miraclezz.equipped.v5',
  'miraclezz.active.v5',
  'miraclezz.seen.v5',
  'miraclezz.loginDays.v1',
  'miraclezz.avatar.v1',
]

let currentScope = 'guest'

const ls = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// every key currently in storage (works with both real localStorage and the
// tests' Map-backed fake)
const allKeys = (store) => {
  if (typeof store.keys === 'function') return store.keys()
  const out = []
  for (let i = 0; i < store.length; i++) out.push(store.key(i))
  return out
}

export function setScope(scope) {
  currentScope = scope || 'guest'
}
export function getScope() {
  return currentScope
}
export const scopedKey = (name, scope = currentScope) => `${scope}.${name}`

export function loadScoped(name, fallback) {
  try {
    const v = JSON.parse(ls()?.getItem(scopedKey(name)))
    return v == null ? fallback : v
  } catch {
    return fallback
  }
}
export function saveScoped(name, value) {
  try {
    ls()?.setItem(scopedKey(name), JSON.stringify(value))
  } catch {}
}

// does a scope hold ANY persisted progress? — the app's onUpgrade uses this to
// skip the server round trip for a truly empty guest. Checks every game key
// (not just coins/owned): a guest whose only progress is an avatar or an
// outfit must still count as "has data", or the seed would silently skip it.
export function scopeHasData(scope) {
  const store = ls()
  if (!store) return false
  try {
    return GAME_KEYS.some((name) => store.getItem(scopedKey(name, scope)) != null)
  } catch {
    return false
  }
}

// wipe a whole scope (every `<scope>.*` key). Used to reset the guest sandbox
// after Sign Up folds it into the new account — so the next time the player
// enters Guest Mode they start a genuinely fresh game.
export function clearScope(scope) {
  const store = ls()
  if (!store || !scope) return
  try {
    const prefix = `${scope}.`
    for (const k of allKeys(store)) if (k.startsWith(prefix)) store.removeItem(k)
  } catch {}
}

/* ------------------------------------------------------------------ merge */
// Pure merge of two data bags — unit-tested; the strategy is the user's call
// (auth-implementation-plan.md §4.3): coins max, owned/claimed union,
// equipped prefers `to` and backfills from `from`, daily per-pack max.
export function mergeData(from, to) {
  const coins = Math.max(from.coins ?? 0, to.coins ?? 0)
  const owned = [...new Set([...(to.owned ?? []), ...(from.owned ?? [])])]
  const claimed = [...new Set([...(to.claimed ?? []), ...(from.claimed ?? [])])]

  const daily = { ...(from.daily ?? {}) }
  for (const [packId, prog] of Object.entries(to.daily ?? {})) {
    const other = daily[packId]
    daily[packId] = !other || (prog.count ?? 0) >= (other.count ?? 0) ? prog : other
  }

  // equipped is { slug: {slot:id} } — to wins per doll, from fills the gaps
  const equipped = { ...(from.equipped ?? {}) }
  for (const [slug, look] of Object.entries(to.equipped ?? {})) {
    equipped[slug] = { ...(equipped[slug] ?? {}), ...look }
  }

  // seen maps { tab: [ids] } — union per tab (red dots stay cleared)
  const seen = { ...(from.seen ?? {}) }
  for (const [tab, ids] of Object.entries(to.seen ?? {})) {
    seen[tab] = [...new Set([...(seen[tab] ?? []), ...ids])]
  }

  const active = to.active ?? from.active ?? null

  // loginDays is an array of local-calendar ISO dates (count = length) —
  // union keeps every distinct day either side has seen
  const loginDays = [
    ...new Set([
      ...(Array.isArray(to.loginDays) ? to.loginDays : []),
      ...(Array.isArray(from.loginDays) ? from.loginDays : []),
    ]),
  ].sort()

  const avatar = to.avatar || from.avatar || null

  return { coins, owned, claimed, daily, equipped, seen, active, loginDays, avatar }
}

const readBag = (scope) => {
  const get = (name, fb) => {
    try {
      const v = JSON.parse(ls()?.getItem(scopedKey(name, scope)))
      return v == null ? fb : v
    } catch {
      return fb
    }
  }
  return {
    coins: get('miraclezz.coins.v5', 0),
    owned: get('miraclezz.owned.v5', []),
    claimed: get('miraclezz.claimed.v5', []),
    daily: get('miraclezz.daily.v5', {}),
    equipped: get('miraclezz.equipped.v5', {}),
    seen: get('miraclezz.seen.v5', {}),
    active: get('miraclezz.active.v5', null),
    loginDays: get('miraclezz.loginDays.v1', []),
    avatar: get('miraclezz.avatar.v1', null),
  }
}

// Fold one scope's data into another. The ONLY caller is the app's onUpgrade
// (guest → freshly-created EMPTY account). The from-scope keys are left
// untouched (a cheap backup); the caller clears them explicitly when a reset
// is wanted. NOT used on sign-IN — that enters the account untouched.
//
// Returns true only when every key landed. The caller MUST NOT clearScope the
// source on false — a partial write (e.g. storage quota) must leave the guest
// sandbox intact as the surviving copy.
export function mergeScopes(fromScope, toScope) {
  const store = ls()
  if (!store || !fromScope || !toScope || fromScope === toScope) return false
  try {
    const merged = mergeData(readBag(fromScope), readBag(toScope))
    const put = (name, v) => store.setItem(scopedKey(name, toScope), JSON.stringify(v))
    put('miraclezz.coins.v5', merged.coins)
    put('miraclezz.owned.v5', merged.owned)
    put('miraclezz.claimed.v5', merged.claimed)
    put('miraclezz.daily.v5', merged.daily)
    put('miraclezz.equipped.v5', merged.equipped)
    put('miraclezz.seen.v5', merged.seen)
    if (merged.active != null) put('miraclezz.active.v5', merged.active)
    put('miraclezz.loginDays.v1', merged.loginDays)
    if (merged.avatar != null) put('miraclezz.avatar.v1', merged.avatar)
    return true
  } catch {
    return false
  }
}

export { GAME_KEYS }
