// Detect WeChat in-app browser via User-Agent. The guest-mode login gate is
// suppressed in WeChat because OAuth providers (Google/Discord) don't reliably
// open in this environment, so we let WeChat users keep learning indefinitely
// until they choose to link an account from Settings.
export function isWeChatBrowser() {
  try {
    return /MicroMessenger/i.test(navigator.userAgent || '');
  } catch {
    return false;
  }
}
