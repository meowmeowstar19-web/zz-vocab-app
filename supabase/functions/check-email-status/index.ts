// Edge Function: check-email-status
// Returns the auth status for an email so the client can show a precise login error.
// Rate-limited per IP to mitigate account enumeration.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || entry.resetAt < now) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  const ip =
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
  if (isRateLimited(ip)) {
    return jsonResponse({ error: 'rate_limited' }, 429);
  }

  let email: unknown;
  try {
    const body = await req.json();
    email = body?.email;
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    return jsonResponse({ error: 'invalid_email' }, 400);
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await supabase.rpc('check_email_status', {
    p_email: email,
  });

  if (error) {
    console.error('check_email_status rpc error:', error);
    return jsonResponse({ error: 'internal_error' }, 500);
  }

  return jsonResponse(data ?? { status: 'unknown' });
});
