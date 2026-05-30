// Anti-scraping Phase 5 — deterministic, unguessable image filenames.
//
// The on-CDN image filename used to be the English word itself (apple.jpg), so a
// scraper could enumerate images with a word dictionary WITHOUT ever logging in.
// We replace it with sha256(SALT + ':' + word_id) so the name has no pattern and
// can't be derived from a dictionary. It stays deterministic (same id → same
// name) so re-syncs don't churn names, and the only way to learn a name is to
// read the login-gated word record. The SALT lives only in .env.local — it is
// never shipped to the client or Vercel. See memory project_anti_scraping_plan.md.

import { createHash } from 'node:crypto';

export function hashedImageName(id, salt) {
  if (!salt) throw new Error('IMAGE_HASH_SALT missing — set it in .env.local (Phase 5)');
  const h = createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 20);
  return `${h}.jpg`;
}

// Slugify an English word into the stable word id. MUST match the id derivation
// emitted by writeWordsJs in sync-data.mjs, so a category cover (referenced by
// English word) hashes to the SAME name as that word's own image.
export function slugifyEn(en) {
  return String(en).toLowerCase().replace(/[\s']+/g, '-').replace(/[^a-z0-9-]/g, '');
}
