import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.warn('[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.local');
}

export const supabase = createClient(url || 'http://placeholder', anonKey || 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

// Wrap signOut so the onAuthStateChange SIGNED_OUT handler can tell apart
// "user/app explicitly asked to log out" from "Supabase auto-signed-out
// because token refresh failed". Without this distinction, a stale refresh
// token (e.g. another device rotated it past the reuse window) silently
// drops the user into guest mode mid-session — no popup, no message.
//
// Every intentional signOut in the app — handleLogout, bind-rejection
// rollback, anon-clear before email OTP — must go through this wrapper so
// the flag is set BEFORE the underlying signOut, and cleared inside the
// SIGNED_OUT handler regardless of which path got us there.
export async function intentionalSignOut() {
  try { localStorage.setItem('intentional_signout', '1'); } catch {}
  return supabase.auth.signOut();
}
