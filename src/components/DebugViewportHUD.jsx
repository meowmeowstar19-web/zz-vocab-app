// TEMPORARY diagnostic overlay for the OAuth viewport-shift bug. NOT for
// production — delete this file and its <DebugViewportHUD/> mount before merge.
//
// Enable on the phone two ways:
//   1. Visit `<url>/#vpdebug` once (flag stored in localStorage).
//   2. In the installed PWA (no address bar): tap the TOP-RIGHT corner 5 times
//      within 2.5s. The corner trigger is always mounted, even when off.
// Disable with the "off" button or by clearing localStorage `vpdebug`.
//
// It logs scroll + visualViewport + shell-offset values on every event that
// could move the content (scroll, visualViewport resize/scroll, pageshow,
// visibilitychange, resize) into localStorage so the values captured during the
// pre-redirect flash and the bfcache-restore survive the round-trip and can be
// read back afterward.
import { useEffect, useState, useRef } from 'react';

const LOG_KEY = 'vpdebug_log';
const FLAG_KEY = 'vpdebug';
const MAX = 24;

function enabled() {
  try {
    if (typeof location !== 'undefined' && location.hash.toLowerCase().includes('vpdebug')) {
      localStorage.setItem(FLAG_KEY, '1');
    }
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch { return false; }
}

function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  } catch { return false; }
}

function snapshot(ev) {
  const vv = window.visualViewport;
  const se = document.scrollingElement || document.documentElement;
  const shell = document.querySelector('[data-shell]');
  return {
    t: new Date().toTimeString().slice(0, 8),
    ev,
    sa: isStandalone() ? 1 : 0,
    sy: Math.round(window.scrollY || 0),
    st: Math.round(se?.scrollTop || 0),
    bt: Math.round(document.body?.scrollTop || 0),
    vot: vv ? Math.round(vv.offsetTop) : -1,
    vh: vv ? Math.round(vv.height) : -1,
    ih: Math.round(window.innerHeight),
    shy: shell ? Math.round(shell.getBoundingClientRect().top) : -999,
  };
}

function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
}
function writeLog(arr) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(arr.slice(-MAX))); } catch {}
}

export default function DebugViewportHUD() {
  const [on, setOn] = useState(enabled);
  const [live, setLive] = useState(() => (on ? snapshot('live') : null));
  const [log, setLog] = useState(() => (on ? readLog() : []));
  const lastRef = useRef('');

  useEffect(() => {
    if (!on) return;

    const push = (ev) => {
      const s = snapshot(ev);
      // Dedupe consecutive identical readings (scroll fires in bursts).
      const sig = `${s.ev}|${s.sy}|${s.st}|${s.bt}|${s.vot}|${s.vh}|${s.shy}`;
      if (sig === lastRef.current) return;
      lastRef.current = sig;
      const next = [...readLog(), s].slice(-MAX);
      writeLog(next);
      setLog(next);
    };

    const onScroll = () => push('scroll');
    const onVvResize = () => push('vv-resize');
    const onVvScroll = () => push('vv-scroll');
    const onPageShow = (e) => push(`pageshow${e.persisted ? '(bf)' : ''}`);
    const onVis = () => push(`vis:${document.visibilityState}`);
    const onResize = () => push('resize');

    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onVvResize);
      window.visualViewport.addEventListener('scroll', onVvScroll);
    }

    push('mount');
    const id = setInterval(() => setLive(snapshot('live')), 300);

    return () => {
      clearInterval(id);
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', onVvResize);
        window.visualViewport.removeEventListener('scroll', onVvScroll);
      }
    };
  }, [on]);

  // Secret enable for the installed PWA (no address bar to type #vpdebug):
  // 5 taps in the top-right corner within 2.5s.
  const tapRef = useRef([]);
  const onCornerTap = () => {
    const now = Date.now();
    tapRef.current = [...tapRef.current, now].filter((t) => now - t < 2500);
    if (tapRef.current.length >= 5) {
      tapRef.current = [];
      try { localStorage.setItem(FLAG_KEY, '1'); } catch {}
      setOn(true);
    }
  };

  const corner = (
    <div
      onClick={onCornerTap}
      style={{
        position: 'fixed', top: 0, right: 0, width: 40, height: 40,
        zIndex: 2147483647, background: 'transparent',
      }}
    />
  );

  if (!on) return corner;

  const row = (s) => `${s.t} ${s.ev} sa${s.sa} sy${s.sy} st${s.st} bt${s.bt} vot${s.vot} vh${s.vh} ih${s.ih} shy${s.shy}`;

  return (
    <>
    {corner}
    <div
      style={{
        position: 'fixed', top: 0, left: 0, zIndex: 2147483647,
        maxWidth: '78vw', maxHeight: '46vh', overflow: 'auto',
        background: 'rgba(0,0,0,0.82)', color: '#0f0',
        font: '9px/1.35 ui-monospace, Menlo, monospace',
        padding: '4px 6px', borderBottomRightRadius: 8,
        whiteSpace: 'pre', pointerEvents: 'auto',
      }}
    >
      <div style={{ color: '#ff0', marginBottom: 2 }}>{live ? row(live) : '—'}</div>
      <div style={{ marginBottom: 3 }}>
        <span
          onClick={() => { writeLog([]); setLog([]); }}
          style={{ color: '#0ff', textDecoration: 'underline', marginRight: 12 }}
        >clr</span>
        <span
          onClick={() => { try { localStorage.removeItem(FLAG_KEY); } catch {}; setOn(false); }}
          style={{ color: '#f66', textDecoration: 'underline' }}
        >off</span>
      </div>
      {log.slice().reverse().map((s, i) => (
        <div key={i} style={{ color: s.ev.startsWith('pageshow') ? '#ff0' : '#0f0' }}>{row(s)}</div>
      ))}
    </div>
    </>
  );
}
