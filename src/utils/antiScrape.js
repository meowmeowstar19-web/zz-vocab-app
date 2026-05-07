// Client-side anti-scrape deterrents.
// Note: a determined attacker can still extract data from the JS bundle.
// This raises the bar for casual scraping (right-click save, copy text,
// devtools inspection, image dragging, headless browsers).

const isEditable = (el) => {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    el.isContentEditable === true
  );
};

const blockContextMenu = (e) => {
  if (isEditable(e.target)) return;
  e.preventDefault();
};

const blockDrag = (e) => {
  e.preventDefault();
};

const BLOCKED_KEYS = new Set([
  'F12',
]);

const blockKeyShortcuts = (e) => {
  if (BLOCKED_KEYS.has(e.key)) {
    e.preventDefault();
    return;
  }
  const k = (e.key || '').toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl/Cmd+Shift+I/J/C  -> devtools
  if (mod && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) {
    e.preventDefault();
    return;
  }
  // Ctrl/Cmd+U  -> view source
  if (mod && k === 'u') {
    e.preventDefault();
    return;
  }
  // Ctrl/Cmd+S  -> save page
  if (mod && k === 's') {
    e.preventDefault();
    return;
  }
  // Ctrl/Cmd+P  -> print
  if (mod && k === 'p') {
    e.preventDefault();
    return;
  }
};

let devtoolsOpen = false;
let detectionTimer = null;

const onDevtoolsOpen = () => {
  if (devtoolsOpen) return;
  devtoolsOpen = true;
  // Soft response: wipe document. Hard reload would loop forever.
  try {
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;width:100vw;height:100vh;font-family:system-ui;color:#2b2a26;background:#f7d376;text-align:center;padding:24px;font-size:18px;font-weight:700;">Content protected.<br/>Please close developer tools to continue.</div>';
  } catch {
    // ignore
  }
};

const startDevtoolsDetection = () => {
  // Heuristic: when devtools docks open, viewport vs window dimensions diverge.
  detectionTimer = setInterval(() => {
    const widthGap = window.outerWidth - window.innerWidth;
    const heightGap = window.outerHeight - window.innerHeight;
    if (widthGap > 200 || heightGap > 200) {
      onDevtoolsOpen();
    }
  }, 1000);

  // Console-based trap: getter triggers when devtools formats the object.
  const trap = /./;
  trap.toString = () => {
    onDevtoolsOpen();
    return '';
  };
  setInterval(() => {
    // eslint-disable-next-line no-console
    console.debug(trap);
    // eslint-disable-next-line no-console
    console.clear();
  }, 2000);
};

const printConsoleWarning = () => {
  const style1 = 'color:#e84d4d;font-size:24px;font-weight:bold;';
  const style2 = 'color:#2b2a26;font-size:14px;';
  // eslint-disable-next-line no-console
  console.log('%cStop!', style1);
  // eslint-disable-next-line no-console
  console.log(
    '%cThis is a protected app. Pasting code here can compromise your account and content. Close this panel.',
    style2,
  );
};

export const installAntiScrape = ({ enableDevtoolsDetection = true } = {}) => {
  if (typeof window === 'undefined') return;

  document.addEventListener('contextmenu', blockContextMenu);
  document.addEventListener('dragstart', blockDrag);
  document.addEventListener('keydown', blockKeyShortcuts);

  printConsoleWarning();

  if (enableDevtoolsDetection) {
    startDevtoolsDetection();
  }
};

export const uninstallAntiScrape = () => {
  document.removeEventListener('contextmenu', blockContextMenu);
  document.removeEventListener('dragstart', blockDrag);
  document.removeEventListener('keydown', blockKeyShortcuts);
  if (detectionTimer) clearInterval(detectionTimer);
};
