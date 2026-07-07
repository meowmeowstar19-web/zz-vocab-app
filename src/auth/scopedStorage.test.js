import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mergeScopes } from './scopedStorage.js';

// PW policy: 'login' merges are SKIPPED (sign-in enters the account
// untouched); 'remint' merges run (anon re-mint inherits the old scope).
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

describe('PW mergeScopes policy', () => {
  it("reason 'login' is a no-op — the account's slot stays untouched", () => {
    const store = fakeStorage({ vocab_kids_progress_u_anon1_en: guestProgress });
    install(store);
    mergeScopes('u_anon1', 'u_acc9', 'login');
    expect(store.getItem('vocab_kids_progress_u_acc9_en')).toBeNull();
    expect(store.getItem('vocab_kids_progress_u_anon1_en')).toBe(guestProgress); // backup intact
  });

  it("reason 'remint' folds the dead anon scope into the fresh one", () => {
    const store = fakeStorage({ vocab_kids_progress_u_dead1_en: guestProgress });
    install(store);
    mergeScopes('u_dead1', 'u_fresh2', 'remint');
    const merged = JSON.parse(store.getItem('vocab_kids_progress_u_fresh2_en'));
    expect(merged.w1).toMatchObject({ timestamp: 111 });
    expect(store.getItem('vocab_kids_progress_u_dead1_en')).toBe(guestProgress); // backup intact
  });

  it('remint merge keeps the busier side per word', () => {
    const store = fakeStorage({
      vocab_kids_progress_u_old_en: JSON.stringify({ w1: { timestamp: 200, mastered: true }, w2: { timestamp: 50 } }),
      vocab_kids_progress_u_new_en: JSON.stringify({ w1: { timestamp: 100 } }),
    });
    install(store);
    mergeScopes('u_old', 'u_new', 'remint');
    const merged = JSON.parse(store.getItem('vocab_kids_progress_u_new_en'));
    expect(merged.w1.mastered).toBe(true); // mastered unions, recent wins
    expect(merged.w2.timestamp).toBe(50); // missing words fill in
  });
});
