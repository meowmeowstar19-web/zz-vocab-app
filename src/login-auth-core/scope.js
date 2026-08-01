// Per-user localStorage scoping. Every persisted app key lives under
// `<scope>.<name>`. There are exactly two kinds of scope:
//   'guest'   — the device's ONE persistent guest sandbox (local-only; a guest
//               has NO server identity in Plan B — the server is never
//               consulted for a guest)
//   'u_<uid>' — a signed-in account (a cache mirror of the server-authoritative
//               state; the server is the source of truth)
//
// 'guest' is a NORMAL scope with its own `guest.` prefix. A guest starts from
// ONLY its own `guest.*` keys: fresh per browser, always empty on a browser
// that has never played. Signing INTO an existing account never merges — it
// enters the account untouched and leaves 'guest' on disk, so returning to
// guest restores the same sandbox.
//
// DATA MOVEMENT IS APP LAND. The lone merge in the whole system —
// Sign-Up-into-an-EMPTY-account folding the guest sandbox into the new
// account — is owned entirely by the host app's onUpgrade (wired in its
// authSetup): which keys move, how the two sides merge, and when the guest is
// cleared are product decisions this core has no business hardcoding. This
// module only provides the storage primitives those decisions are built on.

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

// wipe a whole scope (every `<scope>.*` key). Used by the app after a
// Sign-Up seed consumed the guest sandbox — so the next time the player
// enters Guest Mode they start a genuinely fresh game.
export function clearScope(scope) {
  const store = ls()
  if (!store || !scope) return
  try {
    const prefix = `${scope}.`
    for (const k of allKeys(store)) if (k.startsWith(prefix)) store.removeItem(k)
  } catch {}
}
