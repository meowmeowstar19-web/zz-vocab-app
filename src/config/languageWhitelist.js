// Emails allowed to freely switch native/learning languages on the Settings page.
// Users not in this list (and not in test mode) will see a toast and can't switch.
//
// To add an email, just append a string to the array below.
// Comparison is case-insensitive and trims whitespace.
export const LANGUAGE_SWITCH_WHITELIST = [
  'meowmeowstar19@gmail.com',
  'ahsirjoe@gmail.com',
  'adacylar@gmail.com',
  'chenwenaiba@gmail.com',
];

export function canSwitchLanguageFreely(email) {
  if (!email) return false;
  const normalized = String(email).trim().toLowerCase();
  return LANGUAGE_SWITCH_WHITELIST.some(
    (e) => String(e).trim().toLowerCase() === normalized
  );
}
