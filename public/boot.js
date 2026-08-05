/* boot.js — the pre-React boot layer (pwa-kit; see docs/pwa-kit.md).
 *
 * Runs BEFORE the app module, as a same-origin EXTERNAL script: a strict CSP
 * (`script-src 'self'`) silently blocks INLINE scripts — logic that sits
 * inline in index.html can turn out to have never run in production. Being an
 * external, stable-named (non-hashed) file also means even a STALE cached
 * index.html still pulls a fresh copy of this logic — which is what lets the
 * self-heal below rescue a poisoned cache.
 *
 * ═════════ APP CONFIG — the ONLY block that differs between apps ═════════
 * (PlushieWord note: adopted 2026-08-01 — the install-prompt stash, SW
 * registration and keyboard-scroll reset moved here out of index.html's
 * inline scripts; the <html lang> bootstrap stays inline there (app logic,
 * must run before first paint). The purge lever has NEVER been armed on PW:
 * `purgeToken: null` keeps it dormant — review `purgePatterns` against the
 * real key inventory before ever arming it.)
 */
var BOOT = {
  appName: 'PlushieWord',
  docTitle: 'PlushieWord',
  manifestHref: '/manifest.json',

  // One-time GLOBAL local-data purge. Bump `purgeToken` to wipe every
  // device's matching localStorage keys on its next open; null = unarmed
  // (mechanism present, nothing ever purged). The flag key must NOT match
  // any pattern, so the marker survives and the purge stays one-shot/token.
  purgeFlagKey: 'pw_purge',
  purgeToken: null,
  purgePatterns: [/^vocab_/, /^app_/, /^auth\./, /^sb-/],

  // sessionStorage marker for the stale-cache self-heal (one heal per tab).
  selfHealKey: 'pw_selfheal_v1',

  // Dev ports that mean "local dev" even on a non-localhost hostname
  // (LAN-IP testing). Plain localhost/127.0.0.1/0.0.0.0 always count.
  devPorts: ['5174'],

  // Hostnames that are local dev wearing a public name. The phone-testing
  // tunnel (dev.plushieword.com → localhost:5174) is HTTPS on the default
  // port, so BOTH other checks miss it: the hostname isn't localhost and
  // `location.port` is ''. Without it listed here the tunnel looked like
  // production and got the real SW registered on it, which then cached the
  // *dev* module graph (/@vite/client, /src/*.jsx, dep hashes) — a stale or
  // server-down visit then replays that graph and the page never mounts.
  devHosts: ['dev.plushieword.com'],
}

/* ═════════ PORTABLE BODY — byte-copied between apps, do not edit ═════════
 *
 * What lives here (all of it app-configured through BOOT above):
 *  - PWA identity repair (title/meta/manifest link) — Chrome can snapshot a
 *    stale manifest for an open tab; re-stamping from a no-store script wins.
 *  - Install-prompt stash — Chrome fires `beforeinstallprompt` once, very
 *    early; React mounts too late to catch it (general-ui/installPrompt.js
 *    consumes the stash).
 *  - Persistent-storage request — localStorage (where the Supabase session
 *    lives) is evictable "best effort" storage until this is granted;
 *    eviction reads to the user as "it logged me out for no reason".
 *  - One-time global purge (see config).
 *  - Stale-cache self-heal — in-app WebViews (WeChat desktop, notably) cache
 *    the bare `/` document hard and ignore `no-store`; after a redeploy the
 *    cached index points at content-hashed chunks that now 404, and the page
 *    is a silent white screen. Re-entering through a never-seen URL
 *    (`/?v=<ts>`) bypasses the poisoned cache. Guarded to fire at most once.
 *  - ?diag=1 panel — a console-less WebView's only voice: did boot run, did
 *    the app mount, what threw, is storage writable, how did the last
 *    Add-to-Home-Screen login handoff end (sessionMirror's breadcrumb, the
 *    line that turned a four-day silent CORS failure into a one-screenshot
 *    diagnosis), and which display-mode is asking.
 *  - iOS keyboard-scroll reset — the soft keyboard closing leaves the page
 *    scrolled; a position:fixed app root ends up displaced over a growing
 *    white strip (every failed-login retry made it worse).
 *  - Service-worker registration — NEVER in local dev (a stale SW masks a
 *    stopped dev server); dev also actively unregisters strays and clears
 *    their caches, so a prod-preview session can't haunt localhost. "Local
 *    dev" is hostname OR port OR `devHosts` — a tunnel that fronts the dev
 *    server on a public HTTPS name matches none of the first two.
 */
;(function (cfg) {
  document.title = cfg.docTitle;

  function setMeta(name, value) {
    var meta = document.querySelector('meta[name="' + name + '"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', name);
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', value);
  }

  setMeta('application-name', cfg.appName);
  setMeta('mobile-web-app-capable', 'yes');
  setMeta('apple-mobile-web-app-capable', 'yes');
  setMeta('apple-mobile-web-app-title', cfg.appName);

  var manifestLinks = document.querySelectorAll('link[rel~="manifest"]');
  if (manifestLinks.length) {
    manifestLinks[0].setAttribute('href', cfg.manifestHref);
    for (var manifestIndex = 1; manifestIndex < manifestLinks.length; manifestIndex += 1) {
      manifestLinks[manifestIndex].remove();
    }
  } else {
    var manifestLink = document.createElement('link');
    manifestLink.setAttribute('rel', 'manifest');
    manifestLink.setAttribute('href', cfg.manifestHref);
    document.head.appendChild(manifestLink);
  }

  // ── Ask for PERSISTENT storage ────────────────────────────────────────────
  // Granted silently to installed/home-screen apps on Chromium (never a prompt
  // in practice, and a rejection costs nothing); Safari decides for itself and
  // simply resolves false. Fire-and-forget, guarded because older WebViews
  // have no navigator.storage at all.
  try {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted().then(function (already) {
        if (!already) navigator.storage.persist().catch(function () {});
      }).catch(function () {});
    }
  } catch (e) {}

  // ── One-time GLOBAL data purge ────────────────────────────────────────────
  // The ONLY lever that reaches in-app WebViews (WeChat / Messenger / vendor
  // browsers) whose storage the user can't clear by hand — and it runs HERE,
  // before the app module reads a single key. localStorage ONLY: the server is
  // NEVER touched, so a signed-in account loses nothing and re-syncs on its
  // next login.
  try {
    if (cfg.purgeToken && localStorage.getItem(cfg.purgeFlagKey) !== cfg.purgeToken) {
      Object.keys(localStorage).forEach(function (k) {
        for (var pi = 0; pi < cfg.purgePatterns.length; pi += 1) {
          if (cfg.purgePatterns[pi].test(k)) { localStorage.removeItem(k); return; }
        }
      });
      localStorage.setItem(cfg.purgeFlagKey, cfg.purgeToken);
    }
  } catch (e) {}

  // Every display mode a launch from the installed icon can land in — not just
  // `standalone`: an Android WebAPK can come up `minimal-ui`, a `display_override`
  // manifest `fullscreen`, an installed desktop app `window-controls-overlay`.
  // None of them is a browser tab. Mirrors LAUNCH_MODES in installPrompt.js.
  var LAUNCH_MODES = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];
  // "THIS launch came from the icon" flag, shared with
  // general-ui/installPrompt.js (HOME_SCREEN_KEY there) — change both together.
  // sessionStorage, never localStorage: on Android and desktop Chrome the
  // browser tab and the installed app share one localStorage, so a remembered
  // verdict would hand the install-only gift to the browser tab too.
  var HOME_SCREEN_KEY = 'pwa.launch.v1';

  // Diagnostic mode: append ?diag=1 to the URL to paint a full status panel.
  // Off for everyone else, so normal users never see it.
  var DIAG = /[?&]diag=1/.test(location.search);
  var captured = []; // JS errors caught during boot, shown in the diag panel

  function ss(get, key) {
    // sessionStorage can THROW (SecurityError) in WebViews with storage
    // disabled. Never let that crash boot.
    try { return get ? sessionStorage.getItem(key) : sessionStorage.setItem(key, '1'); }
    catch (e) { return null; }
  }

  function alreadyFresh() {
    // We arrived via a cache-busted url already, or we've healed once this tab.
    return /[?&]v=/.test(location.search) || ss(true, cfg.selfHealKey);
  }

  function escapeStaleCache() {
    if (DIAG) return; // in diag mode never navigate away — keep the panel visible
    if (alreadyFresh()) return; // fresh index still failed → a real error, don't loop
    ss(false, cfg.selfHealKey);
    // replace() so the dead shell doesn't linger in history
    location.replace(location.origin + '/?v=' + Date.now());
  }

  // (a) Precise + immediate: the entry chunk 404s → a resource `error` event on
  //     its <script> element. Resource errors don't bubble, so capture phase.
  window.addEventListener(
    'error',
    function (e) {
      var t = e && e.target;
      if (
        t &&
        t.tagName === 'SCRIPT' &&
        typeof t.src === 'string' &&
        /\/assets\/index-.*\.js(\?|$)/.test(t.src)
      ) {
        escapeStaleCache();
      }
    },
    true
  );

  // (b) Belt-and-suspenders: if some engine doesn't fire (a), fall back to a
  //     "root never populated" check. A healthy boot fills #root within a
  //     second of the chunk executing, so a long timeout has no false positives.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var root = document.getElementById('root');
      if (DIAG) { paintDiag(root); return; } // diag: always show status, never redirect
      if (!root) return;
      if (root.childElementCount === 0) {
        // If we already came in fresh (?v=) and STILL nothing rendered, this is
        // NOT a stale cache — it's a real boot failure in this engine. Don't
        // loop; surface it on-screen so it can be screenshotted.
        if (/[?&]v=/.test(location.search)) {
          showBootError('App loaded but did not render (blank after fresh fetch).');
        } else {
          escapeStaleCache();
        }
      } else if (/[?&]v=/.test(location.search)) {
        // Healthy boot that came in on a cache-buster → tidy the URL back to `/`.
        try { history.replaceState(null, '', location.origin + '/'); } catch (e) {}
      }
    }, 5000);
  });

  // Full diagnostic panel — one screenshot answers: did boot.js run (yes, since
  // this is painting), did the app mount, and what (if anything) threw.
  function paintDiag(root) {
    var mounted = !!(root && root.childElementCount > 0);
    var lines = [
      cfg.appName + ' DIAG — screenshot this whole panel',
      '',
      'boot.js ran:     YES (this panel proves it)',
      'app mounted:     ' + (mounted ? 'YES (#root has ' + root.childElementCount + ' children)' : 'NO — #root is EMPTY'),
      'entry chunk:     ' + entryChunkStatus(),
      'errors caught:   ' + (captured.length ? captured.length : 'none'),
      'localStorage:    ' + storageProbe(),
      'login session:   ' + sessionProbe(),
      'account:         ' + accountProbe(),
      'mirror cookies:  ' + cookieProbe(),
      'PWA handoff:     ' + handoffProbe(),
      'display-mode:    ' + displayModeProbe(),
      'home screen:     ' + homeScreenProbe(),
      'online:          ' + (navigator.onLine ? 'yes' : 'no'),
      'URL:             ' + location.href,
      'UA:              ' + navigator.userAgent,
    ];
    if (captured.length) lines.push('', '--- errors ---', captured.join('\n\n'));
    var prev = document.getElementById('boot-diag');
    if (prev) prev.remove();
    var box = document.createElement('div');
    box.id = 'boot-diag';
    box.setAttribute(
      'style',
      'position:fixed;inset:0;z-index:99999;background:#fff;color:#111;' +
        'font:12px/1.5 ui-monospace,Menlo,monospace;padding:16px;' +
        'white-space:pre-wrap;word-break:break-word;overflow:auto'
    );
    box.textContent = lines.join('\n');
    document.body.appendChild(box);
  }
  function entryChunkStatus() {
    try {
      var s = document.querySelector('script[type=module]');
      if (!s) return 'no module script in DOM';
      // did it load? check performance entries
      var src = s.getAttribute('src') || '';
      var hit = performance.getEntriesByType('resource').filter(function (r) {
        return r.name.indexOf(src) !== -1;
      })[0];
      return src + (hit ? ' (fetched, ' + Math.round(hit.transferSize || 0) + 'B)' : ' (NOT in resource timing)');
    } catch (e) { return 'probe failed: ' + e; }
  }
  function storageProbe() {
    try { localStorage.setItem('__boot', '1'); localStorage.removeItem('__boot'); return 'writable'; }
    catch (e) { return 'BLOCKED (' + (e && e.name) + ')'; }
  }
  // Is a Supabase session stored in THIS container, and is its access token
  // still inside its lifetime? (An expired access token is not a verdict — the
  // refresh token may still revive it; 'absent' is the only sure "signed out".)
  // Presence + expiry ONLY — no token material ever appears on the panel.
  function sessionProbe() {
    try {
      var key = null;
      for (var i = 0; i < localStorage.length; i += 1) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') === k.length - 11) { key = k; break; }
      }
      if (!key) return 'ABSENT — this container is not signed in';
      var exp = (JSON.parse(localStorage.getItem(key)) || {}).expires_at;
      if (!exp) return 'present (no expiry readable)';
      var mins = Math.round((exp * 1000 - Date.now()) / 60000);
      return mins >= 0
        ? 'LIVE (access token fresh for ' + mins + 'm)'
        : 'present, access token stale ' + (-mins) + 'm (refresh may revive it)';
    } catch (e) { return 'unreadable (' + (e && e.name) + ')'; }
  }
  // WHICH account this container is signed into — the question that settles a
  // "why is this icon a guest" report in one screenshot. Masked local part;
  // the domain plus three letters is enough to tell two identities apart.
  function accountProbe() {
    try {
      for (var i = 0; i < localStorage.length; i += 1) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') === k.length - 11) {
          var email = ((JSON.parse(localStorage.getItem(k)) || {}).user || {}).email || '';
          if (!email) return 'session present, no email readable';
          var at = email.indexOf('@');
          return email.slice(0, Math.min(3, at)) + '…' + email.slice(at);
        }
      }
      return '(no login in this container)';
    } catch (e) { return 'unreadable (' + (e && e.name) + ')'; }
  }
  // Are the handoff cookies stamped in THIS container's jar? Lengths only.
  function cookieProbe() {
    try {
      var rt = document.cookie.match(/(?:^|; )la_rt=([^;]*)/);
      var at = document.cookie.match(/(?:^|; )la_at=([^;]*)/);
      if (!rt && !at) return 'NONE — nothing here to hand off to a new icon';
      return 'la_rt ' + (rt ? 'yes(' + rt[1].length + 'ch)' : 'MISSING')
        + ' · la_at ' + (at ? 'yes(' + at[1].length + 'ch)' : 'MISSING');
    } catch (e) { return 'unreadable (' + (e && e.name) + ')'; }
  }
  // Outcome of the last Add-to-Home-Screen login handoff, written by
  // login-auth-core/sessionMirror.js. Every failure on that path is swallowed
  // by design (a broken handoff must never break the app), which once made a
  // four-day CORS outage invisible; this line is where it becomes visible from
  // the phone itself. Boot runs before the app, so what shows here is the
  // PREVIOUS attempt — the timestamp says which, and that is exactly the one
  // worth reading.
  function handoffProbe() {
    try { return localStorage.getItem('la.handoff.last') || 'no attempt recorded on this device'; }
    catch (e) { return 'unreadable (' + (e && e.name) + ')'; }
  }
  // Standalone = launched from the home-screen icon, browser = a normal tab.
  // Which one is asking changes what a handoff line means, and it is the one
  // thing a screenshot of the panel can't otherwise tell us.
  function displayModeProbe() {
    try {
      if (navigator.standalone) return 'standalone (iOS home screen)';
      for (var i = 0; i < LAUNCH_MODES.length; i++) {
        if (matchMedia('(display-mode: ' + LAUNCH_MODES[i] + ')').matches) {
          return 'standalone (PWA, display-mode: ' + LAUNCH_MODES[i] + ')';
        }
      }
      return 'browser tab';
    } catch (e) { return 'unknown'; }
  }
  // Why the install-gated gift is (or isn't) claimable right now: the verdict
  // this boot reached, and the flag it left for the rest of the launch.
  function homeScreenProbe() {
    var stamped = window.__launchedFromHomeScreen === true;
    var marker = /[?&]source=pwa\b/.test(location.search);
    return 'this launch: ' + (stamped ? 'FROM ICON' : 'no')
      + ' (start_url marker: ' + (marker ? 'yes' : 'no') + ')'
      + ' · flag: ' + (ss(true, HOME_SCREEN_KEY) === '1' ? 'set' : 'no');
  }

  // Turn a silent white screen into a visible, screenshottable diagnostic —
  // for WebViews with no reachable console.
  function showBootError(msg) {
    try {
      var root = document.getElementById('root');
      if (root && root.childElementCount > 0) return; // app rendered — not a boot failure
      var box = document.getElementById('boot-error');
      if (!box) {
        box = document.createElement('div');
        box.id = 'boot-error';
        box.setAttribute(
          'style',
          'position:fixed;inset:0;z-index:99999;background:#fff;color:#c1123f;' +
            'font:13px/1.5 -apple-system,system-ui,sans-serif;padding:18px;' +
            'white-space:pre-wrap;word-break:break-word;overflow:auto'
        );
        document.body.appendChild(box);
      }
      box.textContent =
        cfg.appName + ' boot error (screenshot this):\n\nUA: ' +
        navigator.userAgent +
        '\nURL: ' +
        location.href +
        '\n\n' +
        msg;
    } catch (e) {}
  }
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    // Only surface REAL uncaught JS exceptions (target is window, no tagName).
    // Resource-load errors (script/img/link) carry an element target and are
    // handled by the capture listener above / are benign — ignore them here.
    if (t && t.tagName) return;
    var m = 'error: ' + (e && e.message ? e.message : e) + (e && e.filename ? '\n@ ' + e.filename + ':' + e.lineno + ':' + e.colno : '');
    captured.push(m);
    showBootError(m);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var m = 'unhandledrejection: ' + (r && r.stack ? r.stack : (r && r.message ? r.message : r));
    captured.push(m);
    showBootError(m);
  });

  // ── In-app diagnostic trigger ─────────────────────────────────────────────
  // A home-screen (standalone) container has no address bar, so ?diag=1 is
  // unreachable exactly where diagnosis matters most. Five quick taps in the
  // top-left corner (120×120) paint the same panel — deliberate enough that
  // players never hit it, URL-free so any container can answer for itself.
  (function () {
    var taps = 0;
    var lastTap = 0;
    var lastTouch = 0;
    function count(x, y) {
      if (x > 120 || y > 120) { taps = 0; return; }
      var now = Date.now();
      taps = now - lastTap < 1200 ? taps + 1 : 1;
      lastTap = now;
      if (taps >= 5) {
        taps = 0;
        paintDiag(document.getElementById('root'));
      }
    }
    window.addEventListener('touchstart', function (e) {
      lastTouch = Date.now();
      var t = e.touches && e.touches[0];
      if (t) count(t.clientX, t.clientY);
    }, true);
    window.addEventListener('mousedown', function (e) {
      if (Date.now() - lastTouch < 700) return; // synthetic mouse after touch
      count(e.clientX, e.clientY);
    }, true);
  })();

  // ── Install-prompt stash ──────────────────────────────────────────────────
  // ── Home-screen launch stamp ──────────────────────────────────────────────
  // "Did this launch come from the installed icon?" has to be answered HERE,
  // not after React mounts, and the answer has to be written down: the
  // manifest's `start_url` marker (`?source=pwa`) is the only signal that
  // survives an engine whose display-mode query lies, and it is destroyed by
  // our own cache-buster reload and URL tidy-up a few seconds later. Writing
  // the verdict down means a later render, a late media query or a dropped
  // marker can no longer un-prove a launch that already proved itself — and
  // sessionStorage scopes that memory to THIS launch, so it can never leak the
  // install-gated gift into a browser tab. installPrompt.js reads both halves;
  // keep the key in sync with it.
  (function stampHomeScreenLaunch() {
    var fromIcon = false;
    try {
      if (navigator.standalone === true) fromIcon = true; // iOS Safari home-screen app
      if (!fromIcon && window.matchMedia) {
        for (var i = 0; i < LAUNCH_MODES.length; i++) {
          if (matchMedia('(display-mode: ' + LAUNCH_MODES[i] + ')').matches) { fromIcon = true; break; }
        }
      }
      if (!fromIcon && /[?&]source=pwa\b/.test(location.search)) fromIcon = true;
    } catch (e) {}
    if (!fromIcon) return;
    window.__launchedFromHomeScreen = true;
    ss(false, HOME_SCREEN_KEY);
  })();

  // Capture the PWA install prompt before React mounts (Chrome fires it once,
  // very early). general-ui/installPrompt.js consumes the stash.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    window.__deferredInstallPrompt = e;
    window.dispatchEvent(new Event('installpromptready'));
  });
  window.addEventListener('appinstalled', function () {
    window.__deferredInstallPrompt = null;
  });

  // ── iOS keyboard-scroll reset ─────────────────────────────────────────────
  // iOS Safari leaves the page scrolled after the on-screen keyboard closes.
  // Because the app is a position:fixed root, that residual scroll displaces
  // it and exposes a white strip at the bottom that grows on every re-open
  // (e.g. retrying a failed login). Force the page back to top once focus
  // leaves the inputs or the visual viewport settles.
  (function () {
    function resetScroll() {
      requestAnimationFrame(function () {
        window.scrollTo(0, 0);
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      });
    }
    window.addEventListener('focusout', function () {
      setTimeout(function () {
        var a = document.activeElement;
        var typing =
          a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
        if (!typing) resetScroll();
      }, 100);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        if (window.visualViewport.height >= window.innerHeight - 80) resetScroll();
      });
    }
    window.addEventListener('orientationchange', resetScroll);
  })();

  // ── Service worker ────────────────────────────────────────────────────────
  // Register the app's /sw.js so browsers treat us as installable. NEVER in
  // local dev: a stale SW serves a cached shell that masks a stopped dev
  // server — dev actively unregisters strays and clears their caches instead.
  if ('serviceWorker' in navigator) {
    var isLocalDev =
      ['localhost', '127.0.0.1', '0.0.0.0'].indexOf(location.hostname) !== -1 ||
      cfg.devPorts.indexOf(location.port) !== -1 ||
      (cfg.devHosts || []).indexOf(location.hostname) !== -1;
    if (isLocalDev) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { r.unregister(); });
      }).catch(function () {});
      if (window.caches) {
        caches.keys().then(function (keys) {
          keys.forEach(function (k) { caches.delete(k); });
        }).catch(function () {});
      }
    } else {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
      });
    }
  }
})(BOOT);
