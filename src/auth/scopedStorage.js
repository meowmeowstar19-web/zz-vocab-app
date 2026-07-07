// PW-specific half of the auth module (the ONLY file here that is not a
// byte-identical miracleZZ copy). The machine emits a `mergeScopes` effect
// whenever a user's localStorage scope changes hands (guest logs into an
// existing account, or a fresh anon uid replaces a lost one); this file
// implements it over PlushieWord's data shapes.
//
// PW's per-user data layout (unchanged by the migration):
//   vocab_kids_progress_<scope>_<target>   word progress maps
//   vocab_review_states_<scope>_<target>   review session bookkeeping
//   login_days_<uid|'guest'>               distinct-day array
// where <scope> is 'guest' (legacy device-global slot) or `u_<uid>`.
//
// Merge semantics are progressSync's battle-tested ones (most-recently-touched
// entry wins per word, `mastered` unions, review states keep the busier entry,
// login days union) — reused via its exported readLocalSnapshot /
// mergeSnapshots / writeLocalSnapshot instead of re-implementing.
import { readLocalSnapshot, writeLocalSnapshot, mergeSnapshots } from '../utils/progressSync';

const uidOf = (scope) => (scope && scope.startsWith('u_') ? scope.slice(2) : undefined);

// guest → existing-account login, or dead-anon → fresh-anon re-mint: fold the
// from-scope's wardrobe into the to-scope. The from-scope keys are left
// untouched (cheap backup) — mirrors miracleZZ's behavior.
export function mergeScopes(fromScope, toScope) {
  if (!fromScope || !toScope || fromScope === toScope) return;
  try {
    const from = readLocalSnapshot(uidOf(fromScope), fromScope);
    const to = readLocalSnapshot(uidOf(toScope), toScope);
    // mergeSnapshots(local, cloud): per-word recency merge either way; the
    // second bag's preferences win, which is a no-op here (both read the
    // same device-global app_native/app_target keys).
    const merged = mergeSnapshots(from, to);
    writeLocalSnapshot(uidOf(toScope), merged, toScope);
  } catch {}
}
