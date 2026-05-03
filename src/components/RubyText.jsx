// Renders text that may contain <ruby>漢字<rt>かんじ</rt></ruby> annotations.
// Excel data can use this format on the `ja` field to show furigana above kanji.

const RUBY_RE = /<ruby>([^<]+)<rt>([^<]+)<\/rt><\/ruby>/g;

// Strip ruby tags, keeping only the base text (kanji). Used for TTS, alt text, comparisons.
export function stripRuby(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(RUBY_RE, '$1');
}

export default function RubyText({ text, className, style }) {
  if (!text || typeof text !== 'string') return null;
  if (!text.includes('<ruby>')) return <span className={className} style={style}>{text}</span>;

  const parts = [];
  let lastIndex = 0;
  let match;
  let key = 0;
  RUBY_RE.lastIndex = 0;
  while ((match = RUBY_RE.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(
      <ruby key={key++}>
        {match[1]}
        <rt style={{ fontWeight: 400, paddingBottom: '0.2em' }}>{match[2]}</rt>
      </ruby>
    );
    lastIndex = RUBY_RE.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return <span className={className} style={style}>{parts}</span>;
}
