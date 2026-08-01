// clone-session — the server half of the PWA login handoff (see
// src/login-auth-core/sessionMirror.js for the whole story; pwa-kit:
// docs/pwa-kit.md). This file is byte-copied between apps — the per-app
// origin allowlist lives in config.ts.
//
// ⚠️ Deploys by hand ONLY (`npm run deploy:functions`) — Edge Functions do
// not ride the git auto-deploy. A project whose anon key is not a JWT
// (sb_publishable_…) must deploy with --no-verify-jwt, or the gateway
// rejects the unauthenticated first-open invoke this function exists for.
//
// A freshly added iOS home-screen app inherits ONLY cookies, so the frontend
// mirrors the session's tokens into two cookies and, on a boot with no
// persisted session, posts them here. This function verifies the caller really
// owns a session and answers with a magiclink token_hash the client turns into
// a BRAND-NEW independent session via verifyOtp — a different refresh-token
// family, so redeeming the handoff no longer rotates the token the browser
// container still holds (that rotation is what used to trip Supabase's
// refresh-token-reuse detection and revoke both containers a day later).
//
// Verification order matters:
//   1. access token → auth.getUser(jwt). Pure read, consumes nothing — the
//      browser's session survives untouched. This is the mainline: handoffs
//      happen minutes after the mirror was stamped, well inside the JWT's TTL.
//   2. expired/invalid access token → spend the refresh token once to prove
//      identity (same cost as the legacy path, and only as a last resort).
//      The rotated session it returns is deliberately discarded — and NEVER
//      signed out, since revoking it would kill the family the browser uses.
//
// CORS: browsers may call this from a known app origin only (config.ts).
// Origin checks don't gate curl — but neither would anything else here: the
// caller must already hold valid tokens, which are the actual credential.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { ALLOWED_ORIGINS } from './config.ts'

const FALLBACK_ORIGIN = ALLOWED_ORIGINS[0]

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : FALLBACK_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsFor(req) })
  if (req.method !== 'POST') return json(req, 405, { error: 'method_not_allowed' })

  let body: { access_token?: unknown; refresh_token?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(req, 400, { error: 'bad_json' })
  }
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : null
  const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : null
  if (!accessToken && !refreshToken) return json(req, 400, { error: 'no_token' })

  const url = Deno.env.get('SUPABASE_URL')!
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let email: string | null = null
  if (accessToken) {
    const { data, error } = await admin.auth.getUser(accessToken)
    if (!error && data?.user?.email) email = data.user.email
  }
  if (!email && refreshToken) {
    const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await anon.auth.refreshSession({ refresh_token: refreshToken })
    if (!error && data?.user?.email) email = data.user.email
  }
  if (!email) return json(req, 401, { error: 'unauthorized' })

  // generateLink only MINTS the OTP hash — no email is sent, no session is
  // touched. verifyOtp on the client side is what opens the new family.
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) return json(req, 500, { error: 'generate_failed' })
  return json(req, 200, { token_hash: tokenHash })
})
