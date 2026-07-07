// One-time fold of PW's scattered legacy auth flags into the single
// versioned snapshot (auth.snapshot.v1). Runs at module load, BEFORE the
// machine's first BOOT reads the snapshot — must be imported from App.jsx
// above the useAuth() mount.
//
// Durable flags map into the snapshot; in-flight markers (an OTP window or
// OAuth round-trip that happened to straddle the deploy) are dropped — the
// user simply re-taps their login button once. Flag inventory and mapping:
//
//   app_had_account        → hadAccount
//   app_logged_out         → explicitLogout (old code also set it on token
//                            expiry; those users see WelcomePage once, then
//                            the snapshot takes over — accepted one-time cost)
//   app_last_email         → lastEmail
//   app_anon_scope         → lastUserScope (the guest's u_<anon> pointer);
//                            falls back to 'guest' if the device has history
//   gate_oauth_pending, bind_oauth_pending, bind_flow_active,
//   bind_oauth_email_mode, bind_inline_active, app_email_auth_pending,
//   intentional_signout, app_logged_in                    → deleted
//   app_anon_data_to_migrate → KEPT (still consumed by migrateScopesToAnon)
//   app_native / app_target / lang_onboarded_* → untouched (language, not auth)
import { SNAPSHOT_KEY, saveSnapshot } from './storage.js';

const DROPPED = [
  'app_logged_in',
  'app_logged_out',
  'app_had_account',
  'app_last_email',
  'app_anon_scope',
  'intentional_signout',
  'gate_oauth_pending',
  'bind_oauth_pending',
  'bind_flow_active',
  'bind_oauth_email_mode',
  'bind_inline_active',
  'app_email_auth_pending',
];

export function migrateLegacyAuthFlags() {
  let store;
  try {
    store = globalThis.localStorage;
    if (!store) return;
  } catch {
    return;
  }
  try {
    // Snapshot already exists → this device migrated (or started fresh on
    // the new code). Never run twice: the old flags are gone by then and a
    // re-run would clobber newer snapshot state with defaults.
    if (store.getItem(SNAPSHOT_KEY) != null) return;

    const get = (k) => {
      try { return store.getItem(k); } catch { return null; }
    };
    const hadAccount = get('app_had_account') === '1';
    const explicitLogout = get('app_logged_out') === '1';
    const lastEmail = get('app_last_email') || null;
    // The guest's anon-scope pointer is the merge identity the machine needs
    // on its next mint/login. An old device without one but WITH history
    // (language picked) reads the legacy device-global 'guest' slot.
    const anonScope = get('app_anon_scope');
    const lastUserScope = anonScope || (get('app_native') ? 'guest' : null);

    saveSnapshot({ hadAccount, explicitLogout, lastEmail, lastUserScope }, Date.now());

    DROPPED.forEach((k) => {
      try { store.removeItem(k); } catch {}
    });
  } catch {}
}
