// The ONE persisted auth snapshot (铁律6): a single versioned JSON under a
// single key, read/written only by this module. Nothing else in the app may
// touch localStorage's auth data — the 13 scattered flags PlushieWord grew are
// exactly what this replaces.
//
// Zero imports. localStorage is taken from globalThis so tests can inject a
// fake and the module still no-ops safely where storage is unavailable.

export const SNAPSHOT_KEY = 'auth.snapshot.v1'

export function defaultSnapshot() {
  return {
    v: 1,
    hadAccount: false, // this device once held a real account (never cleared)
    explicitLogout: false, // user chose to log out (≠ token death)
    lastUserScope: null, // 铁律8: last u_<uid> / 'guest' — boot renders from it
    lastEmail: null,
    otp: null, // { email, expiresAt } — 铁律1: validated on read
    bind: null, // { provider, surface, mode, email?, expiresAt } — same rule
  }
}

const ls = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// migrate older snapshot versions forward; v1 is the first, so today this only
// normalizes shape (drops unknown fields, fills missing ones with defaults)
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return defaultSnapshot()
  const d = defaultSnapshot()
  return {
    v: 1,
    hadAccount: !!raw.hadAccount,
    explicitLogout: !!raw.explicitLogout,
    lastUserScope: typeof raw.lastUserScope === 'string' ? raw.lastUserScope : d.lastUserScope,
    lastEmail: typeof raw.lastEmail === 'string' ? raw.lastEmail : d.lastEmail,
    otp: raw.otp && typeof raw.otp === 'object' ? raw.otp : null,
    bind: raw.bind && typeof raw.bind === 'object' ? raw.bind : null,
  }
}

// expired in-flight markers are cleared AT READ TIME (铁律1) so no code path
// can ever trust a stale one; a marker missing its expiresAt is stale too.
function clearExpired(snap, now) {
  let changed = false
  const next = { ...snap }
  for (const k of ['otp', 'bind']) {
    if (next[k] && !(next[k].expiresAt > now)) {
      next[k] = null
      changed = true
    }
  }
  return { snap: next, changed }
}

// synchronous read (the 0ms boot path) — always returns a usable snapshot
export function loadSnapshot(now) {
  const store = ls()
  let raw = null
  try {
    raw = JSON.parse(store?.getItem(SNAPSHOT_KEY))
  } catch {
    raw = null // bad JSON = fresh snapshot; never let a corrupt write brick boot
  }
  const { snap, changed } = clearExpired(migrate(raw), now)
  if (changed) writeSnapshot(snap)
  return snap
}

function writeSnapshot(snap) {
  try {
    ls()?.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
  } catch {}
}

// merge-and-persist; returns the merged snapshot so callers can keep their copy
export function saveSnapshot(patch, now) {
  const current = loadSnapshot(now)
  const next = migrate({ ...current, ...patch })
  writeSnapshot(next)
  return next
}

// dev-mode full reset (the app's "reset all data" flow)
export function clearSnapshot() {
  try {
    ls()?.removeItem(SNAPSHOT_KEY)
  } catch {}
}
