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

// (The old intentionalSignOut wrapper is gone: login-auth-core carries logout
// intent in its own state machine — its signOut() leaves 'account' before the
// SIGNED_OUT event fires, so no storage flag is needed to tell an explicit
// logout apart from a token death.)
