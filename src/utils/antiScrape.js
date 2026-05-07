// Client-side anti-scrape deterrents.
// Note: a determined attacker can still extract data from the JS bundle.
// This is a casual-scraper deterrent: right-click save and image dragging.
// Devtools key blocking and detection were removed because they risked
// trapping real users (extension false positives, blocked legit shortcuts).

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

  printConsoleWarning();
};

export const uninstallAntiScrape = () => {
  document.removeEventListener('contextmenu', blockContextMenu);
  document.removeEventListener('dragstart', blockDrag);
};
