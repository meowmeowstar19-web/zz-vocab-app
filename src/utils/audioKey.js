// Canonical filename key for pre-recorded audio files.
// Used at build time (scripts/sync-audio.mjs) and runtime (hooks/useAudio.js)
// so the saved file name matches the lookup key exactly.
//
// Rules (apply to en/zh/ja text):
// - strip <ruby>...<rt>...</rt></ruby> wrappers, keep base text
// - lowercase only when lang === 'en'
// - any char that is not a letter, digit, apostrophe, or hyphen → '_'
// - collapse runs of '_' and trim from both ends
export function audioKey(text, lang) {
  let s = String(text || '').trim();
  s = s.replace(/<ruby>([^<]+)<rt>[^<]+<\/rt><\/ruby>/g, '$1');
  if (lang === 'en') s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}'\-]+/gu, '_');
  s = s.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return s;
}
