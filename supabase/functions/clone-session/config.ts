// clone-session APP CONFIG — the only file in this function an app edits
// (pwa-kit; index.ts is byte-copied between apps).
//
// ⚠️ PW's anon key is the sb_publishable_ format (NOT a JWT) — this function
// must be deployed with --no-verify-jwt (`npm run deploy:functions` has the
// flag baked in), or the gateway rejects the unauthenticated first-open
// invoke this function exists for.
//
// The allowlist is echoed back per request, and deliberately NOT a single
// hardcoded origin — a single constant is what broke miracleZZ's handoff on
// 2026-07-24: this function does NOT ride the git auto-deploy, so a domain
// rename left the DEPLOYED copy allowing only the dead origin, every handoff
// failed CORS, fell back to the token-rotating path, and revoked both
// containers a day later. List every origin the app has ever answered on.
export const ALLOWED_ORIGINS = [
  'https://plushieword.com',
  'https://www.plushieword.com',
  'https://zz-vocab-app.vercel.app',
  'http://localhost:5174',
  'http://localhost:5173',
]
