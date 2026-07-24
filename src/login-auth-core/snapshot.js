// The ONE persisted auth snapshot: a single versioned JSON under a single key,
// read/written only by this module. Nothing else in the app may touch
// localStorage's auth data — inherited discipline from the previous stack's
// storage.js (铁律6), kept verbatim in the rewrite.
//
// v2 (Plan B rewrite): the old in-flight `otp` / `bind` markers collapse into
// one `flow` marker — { kind:'otp'|'oauth', surface, expiresAt, … }. The
// `bind.mode` intent is gone entirely: sign-up vs log-in no longer needs to
// survive an OAuth round trip (the empty-account check decides data movement).
//
// Zero imports. localStorage is taken from globalThis so tests can inject a
// fake and the module still no-ops safely where storage is unavailable.

export const SNAPSHOT_KEY = 'auth.snapshot.v1' // key kept stable across v1→v2

export function defaultSnapshot() {
  return {
    v: 2,
    hadAccount: false, // this device once held a real account (never cleared)
    explicitLogout: false, // user chose to log out (≠ token death)
    lastUserScope: null, // last u_<uid> / 'guest' — boot renders from it (铁律8)
    lastEmail: null,
    flow: null, // { kind:'otp'|'oauth', email?, provider?, surface, expiresAt } — validated on read (铁律1)
  }
}

const ls = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

// a valid in-flight flow marker: known kind + a live expiry
const validFlow = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  if (raw.kind !== 'otp' && raw.kind !== 'oauth') return null
  return raw
}

// normalize any stored shape forward (drops unknown fields, fills missing ones
// with defaults). A v1 snapshot's scalars carry over; its otp/bind markers are
// simply dropped — the single user re-enters any flow fresh.
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return defaultSnapshot()
  const d = defaultSnapshot()
  return {
    v: 2,
    hadAccount: !!raw.hadAccount,
    explicitLogout: !!raw.explicitLogout,
    lastUserScope: typeof raw.lastUserScope === 'string' ? raw.lastUserScope : d.lastUserScope,
    lastEmail: typeof raw.lastEmail === 'string' ? raw.lastEmail : d.lastEmail,
    flow: validFlow(raw.flow),
  }
}

// an expired in-flight flow is cleared AT READ TIME (铁律1) so no code path can
// ever trust a stale one; a marker missing its expiresAt is stale too.
function clearExpired(snap, now) {
  if (snap.flow && !(snap.flow.expiresAt > now)) {
    return { snap: { ...snap, flow: null }, changed: true }
  }
  return { snap, changed: false }
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
