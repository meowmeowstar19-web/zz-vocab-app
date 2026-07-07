import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrateLegacyAuthFlags } from './legacyFlags.js';
import { SNAPSHOT_KEY, loadSnapshot } from './storage.js';

// minimal in-memory localStorage
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get size() { return m.size; },
    keys: () => [...m.keys()],
  };
}

let saved;
beforeEach(() => { saved = globalThis.localStorage; });
afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: saved, configurable: true });
});
const install = (store) =>
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });

describe('legacy flag → snapshot migration', () => {
  it('folds durable flags into the snapshot and deletes them', () => {
    const store = fakeStorage({
      app_had_account: '1',
      app_logged_out: '1',
      app_last_email: 'a@b.c',
      app_anon_scope: 'u_anon9',
      app_logged_in: 'true',
      bind_flow_active: '1',
      gate_oauth_pending: '1',
      app_email_auth_pending: '1',
      app_native: 'zh',
      app_anon_data_to_migrate: 'u_dead1',
    });
    install(store);
    migrateLegacyAuthFlags();

    const snap = loadSnapshot(Date.now());
    expect(snap.hadAccount).toBe(true);
    expect(snap.explicitLogout).toBe(true);
    expect(snap.lastEmail).toBe('a@b.c');
    expect(snap.lastUserScope).toBe('u_anon9');
    expect(snap.otp).toBeNull();
    expect(snap.bind).toBeNull();

    // dropped flags are gone; non-auth + still-consumed keys survive
    for (const k of ['app_had_account', 'app_logged_out', 'app_last_email', 'app_anon_scope',
      'app_logged_in', 'bind_flow_active', 'gate_oauth_pending', 'app_email_auth_pending']) {
      expect(store.getItem(k)).toBeNull();
    }
    expect(store.getItem('app_native')).toBe('zh');
    expect(store.getItem('app_anon_data_to_migrate')).toBe('u_dead1');
  });

  it('device with history but no anon pointer falls back to the legacy guest scope', () => {
    const store = fakeStorage({ app_native: 'en' });
    install(store);
    migrateLegacyAuthFlags();
    expect(loadSnapshot(Date.now()).lastUserScope).toBe('guest');
  });

  it('brand-new device: snapshot defaults, nothing to fold', () => {
    const store = fakeStorage();
    install(store);
    migrateLegacyAuthFlags();
    const snap = loadSnapshot(Date.now());
    expect(snap.hadAccount).toBe(false);
    expect(snap.explicitLogout).toBe(false);
    expect(snap.lastUserScope).toBeNull();
  });

  it('never runs twice — an existing snapshot wins over stale flags', () => {
    const store = fakeStorage({
      [SNAPSHOT_KEY]: JSON.stringify({ v: 1, hadAccount: false, explicitLogout: false, lastUserScope: 'u_new', lastEmail: null, otp: null, bind: null }),
      app_logged_out: '1', // stale leftover that somehow survived
      app_anon_scope: 'u_old',
    });
    install(store);
    migrateLegacyAuthFlags();
    const snap = loadSnapshot(Date.now());
    expect(snap.explicitLogout).toBe(false);
    expect(snap.lastUserScope).toBe('u_new');
  });
});
