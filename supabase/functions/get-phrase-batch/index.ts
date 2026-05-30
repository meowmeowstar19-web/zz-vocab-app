// Edge Function: get-phrase-batch  — Anti-scraping Phase 2
// Returns the next batch of oral phrases for a language pair, keyset-paginated
// by slug. Requires a valid JWT (auth.uid()). Never returns a total count.
//
// POST body: { native, target, cursor?, limit? }
// Response:  { items: [...], nextCursor: string | null }

import { corsHeaders, jsonResponse, serviceClient, parseBatchRequest, requestGate, recordActivity } from '../_shared/content-api.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = serviceClient();
  const parsed = await parseBatchRequest(req, supabase);
  if (parsed.kind === 'response') return parsed.response;

  const { userId, native, target, cursor, limit } = parsed;
  // Phase 6 切片2 (c): speed line + zero-progress gate. Silent 429; the windowed
  // client treats it as a fetch failure and falls back to offline cache. Real
  // learners never reach either threshold.
  const gate = await requestGate(supabase, userId);
  if (gate !== 'ok') return jsonResponse({ items: [], nextCursor: null }, 429);

  const { data, error } = await supabase.rpc('get_phrase_batch', {
    p_native: native,
    p_target: target,
    p_cursor: cursor,
    p_limit: limit,
  });
  if (error) {
    console.error('get_phrase_batch rpc error:', error);
    return jsonResponse({ error: 'internal_error' }, 500);
  }

  const items = Array.isArray(data) ? data : [];
  // Phase 6 切片1: meter how much this account pulled (fire-and-forget).
  recordActivity(supabase, userId, items.length);
  const nextCursor = items.length === limit ? items[items.length - 1].slug : null;
  return jsonResponse({ items, nextCursor });
});
