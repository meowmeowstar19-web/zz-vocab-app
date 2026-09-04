// PW's wiring point for login-auth-core (mirrors miracleZZ's authSetup.js —
// the ONE per-app file between the portable identity engine and the app's
// data). Creates the single auth-core instance and PW's onUpgrade; the app and
// login-auth-ui import useAuth ONLY from here so core + UI stay byte-identical
// with miracleZZ.
import { supabase } from './lib/supabase.js'
import {
  createAuthCore,
  createUseAuth,
  attachSessionMirror,
  saveSnapshot,
  SNAPSHOT_KEY,
} from './login-auth-core/index.js'
import {
  readLocalSnapshot,
  writeLocalSnapshot,
  mergeSnapshots,
  cloudHasProgress,
  pushToCloud,
  clearScope,
} from './utils/progressSync.js'

/* ---------------------------------------------------- legacy-stack fold */
// One-time migration off the pre-rewrite auth stack (anon sessions + ~13
// loose flags). Two facts carry over into the core's snapshot — "this device
// once held a real account" (drives the welcome-back gate) and "the user
// explicitly logged out" (drives the welcome page on next open). Everything
// else from the old machinery is deleted. Old GUEST progress is deliberately
// NOT migrated (决策 2026-07-24): the anon-uid slots stay orphaned on disk and
// the persistent 'guest' sandbox starts fresh — same "never inherit residue"
// rule miracleZZ adopted. Real accounts need no data migration at all: their
// slots are already named u_<uid>, exactly what the new core renders.
function migrateLegacyAuth() {
  try {
    if (localStorage.getItem('auth_v2_folded')) return
    const hadAccount = localStorage.getItem('app_had_account') === '1'
    const explicitLogout = localStorage.getItem('app_logged_out') === '1'
    if ((hadAccount || explicitLogout) && !localStorage.getItem(SNAPSHOT_KEY)) {
      saveSnapshot({ hadAccount, explicitLogout }, Date.now())
    }
    const KILL = [
      'app_logged_in', 'app_logged_out', 'app_had_account',
      'app_anon_scope', 'app_anon_data_to_migrate', 'app_email_auth_pending',
      'bind_flow_active', 'bind_inline_active', 'bind_oauth_pending',
      'gate_oauth_pending', 'bind_oauth_email_mode', 'intentional_signout',
      'app_last_active',
    ]
    for (const k of KILL) localStorage.removeItem(k)
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('anon_migrated_') || k.startsWith('lang_onboarded_')
        || k.startsWith('gate_words_') || k.startsWith('gate_dismissed_'))) {
        localStorage.removeItem(k)
      }
    }
    localStorage.setItem('auth_v2_folded', '1')
  } catch {}
}
migrateLegacyAuth()

/* ------------------------------------------------------------ onUpgrade */
// The guest→account seed — PW's ONE data bridge, honoring the six contracts
// from the miracleZZ blueprint (§10.2 A):
//   A.2  empty guest sandbox → no-op, zero network;
//   A.1  emptiness of the ACCOUNT is judged by the SERVER (its user_progress
//        row), never the local u_<uid> cache — queried here with explicit
//        error handling because progressSync's pullFromCloud collapses
//        "no row" and "query failed" into the same null;
//   A.5  a seeded account is entered UNTOUCHED — the guest sandbox stays local;
//   A.3  seeded=false → merge the guest slots into u_<uid> locally, push the
//        union to the cloud row, and only then clear the guest source;
//   A.4  idempotent by construction (union merges, upsert push) — the core
//        may replay this on retry / page kill / multi-tab;
//   any uncertainty (query error, failed push, session swap) THROWS so the
//   core keeps lastUserScope='guest' and re-fires on the next account entry.
const TARGETS = ['en', 'ja', 'zh']

function guestHasData() {
  try {
    const custom = JSON.parse(localStorage.getItem('vocab_custom_words_guest') || '[]')
    if (Array.isArray(custom) && custom.length > 0) return true
    for (const t of TARGETS) {
      const p = JSON.parse(localStorage.getItem(`vocab_kids_progress_guest_${t}`) || '{}')
      if (Object.keys(p).length > 0) return true
      const r = JSON.parse(localStorage.getItem(`vocab_review_states_guest_${t}`) || '{}')
      if (Object.keys(r).length > 0) return true
    }
  } catch {}
  return false
}

export function createOnUpgrade(client) {
  return async function onUpgrade({ toScope }) {
    if (!guestHasData()) return // A.2
    const uid = toScope.slice(2)
    const { data, error } = await client
      .from('user_progress')
      .select('data')
      .eq('user_id', uid)
      .maybeSingle()
    if (error) throw error // A.1: unknown emptiness ≠ empty
    // Pin the verdict to the account being entered (防串号): the query ran
    // under the client's LIVE session — if a cross-tab account switch swapped
    // it mid-flight, this judgment belongs to a different account. Throw; the
    // newer account's own queued entry re-judges under the right session.
    const { data: live } = await client.auth.getSession()
    if (`u_${live?.session?.user?.id}` !== toScope) throw new Error('session changed during seed')
    if (cloudHasProgress(data?.data || null)) return // A.1/A.5: enter untouched
    const guestSnap = readLocalSnapshot(uid, 'guest')
    const acctLocal = readLocalSnapshot(uid, toScope)
    const merged = mergeSnapshots(guestSnap, acctLocal, { isBindFlow: true })
    writeLocalSnapshot(uid, merged, toScope)
    if (!(await pushToCloud(uid, merged))) throw new Error('seed push failed') // A.3: guest survives
    clearScope('guest') // sign-up consumed the sandbox — the next guest starts fresh
  }
}

const core = createAuthCore({ client: supabase, onUpgrade: createOnUpgrade(supabase) })
export const useAuth = createUseAuth(core)

// iOS Add-to-Home-Screen handoff (core/sessionMirror.js): keep a refresh-token
// cookie beside the localStorage session so a freshly added PWA — which
// inherits ONLY cookies — restores the login instead of booting as a guest.
// A redeemed session surfaces through the client's normal auth events, which
// the core is already listening to; no-op where there is no document (tests).
//
// No allowRefreshFallback: PW runs with refresh-token rotation ON (dashboard
// 实查 2026-08-01), so spending the mirrored token when the clone-session
// function is unreachable would rotate a token the phone's browser still holds
// and get the whole family revoked — every container logged out a day later
// (miracleZZ hit this twice). A missed handoff (one re-login) is the cheaper
// failure. Flip it on ONLY if rotation is ever turned off in the dashboard.
//
// cloneEndpoint is the SAME-ORIGIN route (vercel.json rewrites it to the Edge
// Function), so the handoff never depends on a CORS check clearing. Without
// the rewrite (localhost dev) the fetch just 404s and the direct
// functions.invoke answers. The function MUST be deployed with --no-verify-jwt
// (PW's anon key is sb_publishable_, not a JWT — `npm run deploy:functions`
// has it baked in); an undeployed/misdeployed function reads as UNAVAILABLE
// and the mirror simply retries next boot, cookies intact.
attachSessionMirror(supabase, undefined, {
  cloneEndpoint: '/api/clone-session',
  cloneApiKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
})
