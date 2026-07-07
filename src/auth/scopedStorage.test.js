import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mergeScopes } from './scopedStorage.js';

// mergeScopes fires on exactly one machine path: a dead anon session's scope
// is inherited by the freshly-minted one. (Sign-in never merges — that
// guarantee lives in machine.test.js: no mergeScopes effect is emitted.)
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

let saved;
beforeEach(() => { saved = globalThis.localStorage; });
afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: saved, configurable: true });
});
const install = (store) =>
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });

const guestProgress = JSON.stringify({ w1: { timestamp: 111 } });

describe('PW mergeScopes (anon re-mint inheritance)', () => {
  it('folds the dead anon scope into the fresh one, source kept as backup', () => {
    const store = fakeStorage({ vocab_kids_progress_u_dead1_en: guestProgress });
    install(store);
    mergeScopes('u_dead1', 'u_fresh2');
    const merged = JSON.parse(store.getItem('vocab_kids_progress_u_fresh2_en'));
    expect(merged.w1).toMatchObject({ timestamp: 111 });
    expect(store.getItem('vocab_kids_progress_u_dead1_en')).toBe(guestProgress);
  });

  it('keeps the busier side per word, unions mastered, fills gaps', () => {
    const store = fakeStorage({
      vocab_kids_progress_u_old_en: JSON.stringify({ w1: { timestamp: 200, mastered: true }, w2: { timestamp: 50 } }),
      vocab_kids_progress_u_new_en: JSON.stringify({ w1: { timestamp: 100 } }),
    });
    install(store);
    mergeScopes('u_old', 'u_new');
    const merged = JSON.parse(store.getItem('vocab_kids_progress_u_new_en'));
    expect(merged.w1.mastered).toBe(true);
    expect(merged.w2.timestamp).toBe(50);
  });

  it('same scope or missing scope is a no-op', () => {
    const store = fakeStorage({ vocab_kids_progress_u_a_en: guestProgress });
    install(store);
    mergeScopes('u_a', 'u_a');
    mergeScopes(null, 'u_a');
    expect(store.getItem('vocab_kids_progress_u_a_en')).toBe(guestProgress);
  });
});
