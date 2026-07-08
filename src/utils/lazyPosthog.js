// Lazy posthog-js loader. posthog-js is ~190KB minified — statically importing
// it put all of that on the app-open critical path (inside the vendor chunk)
// even though init is already deferred until after `load`. Instead we hand the
// PostHogProvider this proxy client immediately and dynamic-import the real
// library from initAnalytics (main.jsx), so the bytes download + parse strictly
// after the app has painted.
//
// Components keep calling `usePostHog()?.capture(...)` unchanged: before the
// real library arrives, method calls are queued and replayed on load (same
// pre-init window that already existed with the deferred init); after load,
// every property access forwards to the real singleton.
let real = null;
const queued = [];

export const posthogClient = new Proxy({}, {
  get(_, prop) {
    if (real) {
      const v = real[prop];
      return typeof v === 'function' ? v.bind(real) : v;
    }
    // PostHogProvider (slim) reads `client.config?.bootstrap` at render time.
    if (prop === 'config') return undefined;
    if (prop === '__loaded') return false;
    // Anything else pre-load is assumed to be a method call: queue it.
    return (...args) => { queued.push([prop, args]); };
  },
});

export function loadPosthog() {
  return import('posthog-js').then((m) => {
    real = m.default;
    for (const [prop, args] of queued.splice(0)) {
      try { real[prop](...args); } catch (e) { /* analytics must never throw */ }
    }
    return real;
  });
}
