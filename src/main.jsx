import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { installAntiScrape } from './utils/antiScrape';
import { initVpLogger } from './debug/vpLogger';
import posthog from 'posthog-js';
import { PostHogProvider } from '@posthog/react';

posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_TOKEN, {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  defaults: '2026-01-30',
});

// Tag every event with the user's language mode so retention / funnels can be
// broken down by it (zh_en, zh_ja, en_zh, en_ja, ja_zh, ja_en).
{
  const native = localStorage.getItem('app_native');
  const target = localStorage.getItem('app_target');
  if (native && target) {
    posthog.register({
      native_lang: native,
      target_lang: target,
      language_mode: `${native}_${target}`,
    });
  }
}

installAntiScrape();
initVpLogger();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <PostHogProvider client={posthog}>
      <App />
    </PostHogProvider>
  </React.StrictMode>
);
