// kid-signup APP CONFIG — the only file in this function an app edits
// (index.ts is byte-copied from miracleZZ; plan = miracleZZ
// webapp/docs/kids-account-plan.md, PW notes in docs/kids-account.md).
//
// The internal-address domain MUST match login-auth-ui/theme.js
// KID_EMAIL_DOMAIN (the client signs in with the same address) and the
// domain in supabase/migrations/20261007120000_kid_accounts.sql. `.invalid`
// is a reserved TLD: mail to it can never be delivered.
export const KID_EMAIL_DOMAIN = 'kids.plushieword.invalid'

// Per-IP cap on sign-up ATTEMPTS (including "username taken" retries) per
// hour. Loose enough for a classroom behind one school IP, tight enough that
// one machine can't mint accounts in bulk.
export const SIGNUP_ATTEMPTS_PER_IP_HOUR = 20
