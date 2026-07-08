import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { installAntiScrape } from './utils/antiScrape';
// '@posthog/react' is aliased to its slim entry in vite.config.js — the
// default entry statically imports all of posthog-js (~190KB min), which we
// deliberately keep OFF the startup chunks; see src/utils/lazyPosthog.js.
import { PostHogProvider } from '@posthog/react';
import { posthogClient, loadPosthog } from './utils/lazyPosthog';

installAntiScrape();

// Render the app FIRST — nothing analytics-related is on the open critical
// path. The PostHogProvider just hands the lazy proxy client down via
// context; usePostHog()/capture() calls all happen on user interaction, long
// after the deferred init below has run.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PostHogProvider client={posthogClient}>
      <App />
    </PostHogProvider>
  </React.StrictMode>
);

// Defer PostHog off the open critical path — both the ~190KB library download
// + parse (dynamic import) and init() itself, which does network (remote
// config) + autocapture wiring; running any of that before first paint
// competed with rendering and violated the "app open must never block on
// network" rule.
function initAnalytics() {
  loadPosthog().then((posthog) => {
    posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN, {
      api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
      defaults: '2026-01-30',
    });

    // Keep our own hand-testing out of analytics. The Vite dev server backs both
    // localhost:5174 and the dev.plushieword.com tunnel, so import.meta.env.DEV is
    // true everywhere we test by hand; the Vercel prod build has it false. Opting
    // out leaves the posthog object intact, so identify()/capture() elsewhere
    // safely no-op instead of minting a fresh person every time we clear storage.
    if (import.meta.env.DEV) {
      posthog.opt_out_capturing();
    }

    // Tag every event with the user's language mode so retention / funnels can be
    // broken down by it (zh_en, zh_ja, en_zh, en_ja, ja_zh, ja_en).
    const native = localStorage.getItem('app_native');
    const target = localStorage.getItem('app_target');
    if (native && target) {
      posthog.register({
        native_lang: native,
        target_lang: target,
        language_mode: `${native}_${target}`,
      });
    }
  }).catch(() => {
    // Offline / blocked analytics must never affect the app.
  });
}

// Gate on the `load` event FIRST, then idle. requestIdleCallback alone fires
// during any early idle gap — on a fast machine that's before first paint, so
// analytics would still race the open. Waiting for `load` guarantees the
// critical resources/paint are done before PostHog touches the network.
function scheduleAnalytics() {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(initAnalytics, { timeout: 3000 });
  } else {
    setTimeout(initAnalytics, 1200);
  }
}
if (typeof window !== 'undefined') {
  if (document.readyState === 'complete') {
    scheduleAnalytics();
  } else {
    window.addEventListener('load', scheduleAnalytics, { once: true });
  }
}
