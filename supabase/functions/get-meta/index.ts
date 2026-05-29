// Edge Function: get-meta  — Anti-scraping Phase 2
// Returns languages + per-category COUNTS (numbers only, never content) for a
// language pair, so the word-list page can show "30/200" without pulling the
// full set. Requires a valid JWT (auth.uid()).
//
// POST body: { native, target }
// Response:  { languages: [...], wordCategories: {cat:n}, phraseCategories: {cat:n} }

import {
  corsHeaders,
  jsonResponse,
  serviceClient,
  getUserId,
  validLang,
} from '../_shared/content-api.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

  const supabase = serviceClient();
  const userId = await getUserId(supabase, req);
  if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const { native, target } = body || {};
  if (!validLang(native) || !validLang(target) || native === target) {
    return jsonResponse({ error: 'invalid_lang_pair' }, 400);
  }

  const { data, error } = await supabase.rpc('get_meta', { p_native: native, p_target: target });
  if (error) {
    console.error('get_meta rpc error:', error);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
  return jsonResponse(data ?? {});
});
