// Lightweight client-side email sanity check.
//
// Goal: catch the obvious typos that the user almost certainly didn't mean
// (`.con`, `gmial.com`, missing TLD) BEFORE we hand off to Supabase's OTP
// send, where a bad address still triggers a real network round-trip and
// then surfaces a generic "send failed" message. We do NOT try to confirm
// the inbox actually exists — that's what the verification code is for.
//
// Returns:
//   { ok: true }                 — looks reasonable, proceed
//   { ok: false, msg, kind }     — show msg as a form error
//     kind: 'shape' | 'typo'
//
// The caller supplies the i18n strings so error copy stays consistent
// with the rest of the form. `t.emailInvalid` is the generic "bad shape"
// message; `t.emailTypoSuggest` is the "Did you mean {s}?" template.

const TLD_TYPOS = {
  con: 'com', cmo: 'com', vom: 'com', xom: 'com',
  coom: 'com', comm: 'com', cpm: 'com', con1: 'com',
  nte: 'net', ner: 'net', nwt: 'net',
  ogr: 'org', orgg: 'org',
};

const DOMAIN_TYPOS = {
  // gmail
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmali.com': 'gmail.com', 'gmaill.com': 'gmail.com',
  'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.con': 'gmail.com',
  // hotmail
  'hotnail.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'hormail.com': 'hotmail.com', 'hotmial.com': 'hotmail.com',
  // yahoo
  'yhoo.com': 'yahoo.com', 'yhaoo.com': 'yahoo.com', 'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  // outlook
  'oulook.com': 'outlook.com', 'outloo.com': 'outlook.com',
  'outlok.com': 'outlook.com',
  // icloud
  'icoud.com': 'icloud.com', 'icluod.com': 'icloud.com', 'iclod.com': 'icloud.com',
  // qq / 163 (common CN providers)
  'qq.con': 'qq.com', 'qq.cm': 'qq.com',
  '163.con': '163.com', '163.cm': '163.com',
};

export function validateEmailShape(raw, t = {}) {
  const e = (raw || '').trim();
  if (!e) return { ok: false, kind: 'shape', msg: t.emailRequired || 'Please enter your email' };

  // Basic shape: exactly one @, non-empty local, non-empty domain with a dot.
  const m = e.match(/^([^\s@]+)@([^\s@]+)$/);
  if (!m) return { ok: false, kind: 'shape', msg: t.emailInvalid || 'Invalid email' };
  const [, local, domain] = m;
  if (!domain.includes('.')) {
    return { ok: false, kind: 'shape', msg: t.emailInvalid || 'Invalid email' };
  }
  const labels = domain.split('.');
  // No empty labels (catches `foo@bar..com`, `foo@.com`, `foo@bar.`)
  if (labels.some((l) => l.length === 0)) {
    return { ok: false, kind: 'shape', msg: t.emailInvalid || 'Invalid email' };
  }
  const tld = labels[labels.length - 1].toLowerCase();
  // TLDs are at least 2 letters
  if (!/^[a-z]{2,}$/i.test(tld)) {
    return { ok: false, kind: 'shape', msg: t.emailInvalid || 'Invalid email' };
  }

  // Known TLD typo? Suggest the fix.
  if (TLD_TYPOS[tld]) {
    const fixed = e.slice(0, e.length - tld.length) + TLD_TYPOS[tld];
    const tmpl = t.emailTypoSuggest || 'Did you mean {s} ?';
    return { ok: false, kind: 'typo', msg: tmpl.replace('{s}', fixed) };
  }

  // Known domain typo? Suggest the fix.
  const dlc = domain.toLowerCase();
  if (DOMAIN_TYPOS[dlc]) {
    const fixed = local + '@' + DOMAIN_TYPOS[dlc];
    const tmpl = t.emailTypoSuggest || 'Did you mean {s} ?';
    return { ok: false, kind: 'typo', msg: tmpl.replace('{s}', fixed) };
  }

  return { ok: true };
}
