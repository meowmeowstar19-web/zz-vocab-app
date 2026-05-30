// Shared helpers for the Phase 2 anti-scraping read API
// (get-word-batch / get-phrase-batch / get-meta).
//
// Each function is the ONLY door to the locked content tables: it validates the
// caller's JWT, then calls a SECURITY DEFINER RPC via the service role (the RPCs
// are not executable by anon/authenticated, so the browser can't bypass this).

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const ALLOWED_LANGS = new Set(['en', 'zh', 'ja']);
export function validLang(x: unknown): x is string {
  return typeof x === 'string' && ALLOWED_LANGS.has(x);
}

// Clamp the requested batch size to [1, 50]; default 30.
export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(Math.trunc(n), 1), 50);
}

// Service-role client: bypasses RLS to call the SECURITY DEFINER RPCs.
// Also used to validate the caller's JWT via auth.getUser(token).
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

// Returns the authenticated user's id, or null if the request has no valid JWT.
// Anonymous Supabase sessions count as logged in (they have a uid) — the
// anon-visitor 5-words/day cap is enforced elsewhere (login gate / Phase 6).
export async function getUserId(supabase: SupabaseClient, req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

// Shared request guard for the two batch endpoints: validates method, auth, and
// the {native, target, cursor, limit} body. Returns either an early Response
// (to return immediately) or the parsed, validated params.
export async function parseBatchRequest(
  req: Request,
  supabase: SupabaseClient,
): Promise<
  | { kind: 'response'; response: Response }
  | { kind: 'ok'; userId: string; native: string; target: string; cursor: string | null; limit: number }
> {
  if (req.method !== 'POST') {
    return { kind: 'response', response: jsonResponse({ error: 'method_not_allowed' }, 405) };
  }
  const userId = await getUserId(supabase, req);
  if (!userId) {
    return { kind: 'response', response: jsonResponse({ error: 'unauthorized' }, 401) };
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const { native, target } = body || {};
  if (!validLang(native) || !validLang(target) || native === target) {
    return { kind: 'response', response: jsonResponse({ error: 'invalid_lang_pair' }, 400) };
  }
  const cursor = typeof body?.cursor === 'string' && body.cursor ? body.cursor : null;
  const limit = clampLimit(body?.limit);
  return { kind: 'ok', userId, native, target, cursor, limit };
}

// Anti-scraping Phase 6 (切片1): record how many content items this account
// pulled, fire-and-forget. The daily_activity counter is OBSERVE-ONLY — read by
// a daily pg_cron job, never in the request path — so this must NEVER block or
// fail the response. Errors are swallowed; the work runs after the response via
// EdgeRuntime.waitUntil when available, else best-effort un-awaited.
export function recordActivity(supabase: SupabaseClient, userId: string, count: number): void {
  if (!userId || count <= 0) return;
  const task = (async () => {
    try {
      await supabase.rpc('bump_daily_activity', { p_user_id: userId, p_count: count });
    } catch (_e) {
      // swallow — metering must never affect content delivery
    }
  })();
  try {
    // @ts-ignore — EdgeRuntime is provided by the Supabase Edge runtime
    EdgeRuntime.waitUntil(task);
  } catch (_e) {
    // not available (e.g. local) — let it run un-awaited
  }
}
