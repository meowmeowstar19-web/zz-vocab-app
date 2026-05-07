// Client-side anti-scrape deterrents.
// Note: a determined attacker can still extract data from the JS bundle.
// This raises the bar for casual scraping (right-click save, F12 inspection,
// image dragging, view-source). Devtools auto-detection was removed because
// browser extensions (React DevTools, etc.) trigger false positives.

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

const blockKeyShortcuts = (e) => {
  if (e.key === 'F12') {
    e.preventDefault();
    return;
  }
  const k = (e.key || '').toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) {
    e.preventDefault();
    return;
  }
  if (mod && k === 'u') {
    e.preventDefault();
    return;
  }
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

export const installAntiScrape = () => {
  if (typeof window === 'undefined') return;

  document.addEventListener('contextmenu', blockContextMenu);
  document.addEventListener('dragstart', blockDrag);
  document.addEventListener('keydown', blockKeyShortcuts);

  printConsoleWarning();
};

export const uninstallAntiScrape = () => {
  document.removeEventListener('contextmenu', blockContextMenu);
  document.removeEventListener('dragstart', blockDrag);
  document.removeEventListener('keydown', blockKeyShortcuts);
};
