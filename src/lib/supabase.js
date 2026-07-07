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

// NOTE: the old intentionalSignOut() wrapper is gone — "intentional" now
// travels as an event payload into the auth state machine (SIGNED_OUT
// {intentional:true}), never as a localStorage flag. Sign out via
// useAuth().signOut(); nothing outside src/auth may call supabase.auth.
