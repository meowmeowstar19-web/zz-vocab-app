// kid-signup — creates an under-13 username account (docs/kids-account-plan.md).
// This file is byte-copied between apps; the per-app domain / limits live in
// config.ts.
//
// ⚠️ Deploys by hand ONLY (`npm run deploy:kid-signup`) — Edge Functions do
// not ride the git auto-deploy. A project whose anon key is not a JWT
// (sb_publishable_…) must deploy with --no-verify-jwt.
//
// A username account is a plain Supabase email+password account whose email
// is an internal address on a reserved `.invalid` domain — the child never
// sees it and no mail can ever go there. It has to be created HERE, with the
// service role, because:
//  - client signUp would send a confirmation email the fake address can't get;
//    admin.createUser({ email_confirm: true }) makes it verified up front;
//  - app_metadata.kid is server-writable only, so "is this a child account"
//    can't be flipped by the client afterwards.
// The client then signs in with signInWithPassword like any other login.
//
// Username rules mirror src/login-auth-ui/kidRules.js (Deno can't import it):
// change both together, error codes included.
//
// CORS is `*`: this is a public sign-up door with no cookie/credential, and a
// per-origin allowlist is exactly what silently broke clone-session after a
// domain rename. The real guard is the per-IP rate limit below.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { KID_EMAIL_DOMAIN, SIGNUP_ATTEMPTS_PER_IP_HOUR } from './config.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function usernameProblem(u: string): string | null {
  if (!u) return 'username_empty'
  if (u.includes('@')) return 'username_at'
  if (/\d{7,}/.test(u)) return 'username_digits'
  if (u.length < 3 || u.length > 16) return 'username_length'
  if (!/^[a-z0-9_]+$/.test(u)) return 'username_chars'
  return null
}

function passwordProblem(p: string): string | null {
  if (p.length < 6) return 'password_short'
  if (p.length > 72) return 'password_long'
  return null
}

// first hop of x-forwarded-for = the client as the platform's proxy saw it
function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return xff || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || 'unknown'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

  let body: { username?: unknown; password?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(400, { error: 'bad_json' })
  }
  const username = String(body?.username ?? '').trim().toLowerCase()
  const password = typeof body?.password === 'string' ? body.password : ''
  const bad = usernameProblem(username) || passwordProblem(password)
  if (bad) return json(400, { error: bad })

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // rate_hit only stores a salted hash of the IP, kept ≤1 day (see migration)
  const { data: allowed, error: rateError } = await admin.rpc('rate_hit', {
    p_bucket: 'kid-signup',
    p_ip: clientIp(req),
    p_max: SIGNUP_ATTEMPTS_PER_IP_HOUR,
    p_window_seconds: 3600,
  })
  if (rateError) return json(500, { error: 'failed' })
  if (allowed !== true) return json(429, { error: 'rate_limited' })

  const { error } = await admin.auth.admin.createUser({
    email: `${username}@${KID_EMAIL_DOMAIN}`,
    password,
    email_confirm: true,
    app_metadata: { kid: true },
  })
  if (error) {
    const msg = `${(error as { code?: string }).code ?? ''} ${error.message ?? ''}`
    if (/email_exists|user_already_exists|already been registered|already registered|already exists/i.test(msg)) {
      return json(409, { error: 'taken' })
    }
    if (/weak_password|password/i.test(msg)) return json(400, { error: 'password_short' })
    return json(500, { error: 'failed' })
  }
  return json(200, { ok: true })
})
