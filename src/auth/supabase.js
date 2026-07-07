// Shim: the auth core (useAuth.js) is a byte-identical copy of miracleZZ's —
// it imports './supabase.js', so this file adapts that to PW's existing
// client. Keeping the core byte-identical is the migration discipline: any
// future fix in either app is a straight file copy, never a hand-merge.
export { supabase } from '../lib/supabase';
