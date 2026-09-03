// general-ui icon set — the app's generic line icons (24-viewBox stroke paths).
// These are the SMALL utility glyphs (back chevron, X, check, lock…) shared by
// every app; big illustrated buttons (home-screen mall/reward PNGs etc.) are
// app assets and stay in the host. Add new names here, never inline an SVG in
// a page for a glyph this table already has.
//   fill: true  → path painted solid   ·   s: false → no stroke   ·   o → opacity
export const ICONS = {
  scene: [
    { d: 'M5 5.6h14a1.5 1.5 0 0 1 1.5 1.5v9.8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V7.1A1.5 1.5 0 0 1 5 5.6Z', fill: true, o: 0.14, s: false },
    { d: 'M5 5.6h14a1.5 1.5 0 0 1 1.5 1.5v9.8a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V7.1A1.5 1.5 0 0 1 5 5.6Z' },
    { d: 'M4 17 8.4 12.4 11.4 15 15 11.2 20 16.4V17a1.4 1.4 0 0 1-1.4 1.4H5A1 1 0 0 1 4 17.4Z', fill: true, o: 0.4, s: false },
    { d: 'M8.4 8.4a1.35 1.35 0 1 0 .01 0Z', fill: true },
  ],
  back: [{ d: 'M14.5 5 8 12l6.5 7' }],
  up: [{ d: 'M5 14.5 12 8l7 6.5' }], // the back chevron stood on end (回到顶部)
  check: [{ d: 'M5 12.4 10 17 19 6.6' }],
  close: [{ d: 'M7 7 17 17M17 7 7 17' }],
  edit: [{ d: 'M17 3.5 20.5 7 8.5 19 4 20l1-4.5L17 3.5Z' }],
  shop: [
    { d: 'M6.5 8.5h11l-.9 9.4a1.4 1.4 0 0 1-1.4 1.3H8.8a1.4 1.4 0 0 1-1.4-1.3L6.5 8.5Z' },
    { d: 'M9.3 8.5V7a2.7 2.7 0 0 1 5.4 0v1.5' },
  ],
  gift: [
    { d: 'M4.7 11.4h14.6V19a1.3 1.3 0 0 1-1.3 1.3H6A1.3 1.3 0 0 1 4.7 19v-7.6Z' },
    { d: 'M3.7 8h16.6v3.4H3.7z' },
    { d: 'M12 8v12.3' },
    { d: 'M12 8C10.6 8 8.6 7.8 8.6 6.2A1.7 1.7 0 0 1 12 6M12 8c1.4 0 3.4-.2 3.4-1.8A1.7 1.7 0 0 0 12 6' },
  ],
  lock: [
    { d: 'M7.5 11V8.6a4.5 4.5 0 0 1 9 0V11' },
    { d: 'M6.4 11h11.2a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H6.4a1 1 0 0 1-1-1V12a1 1 0 0 1 1-1Z' },
  ],
  user: [
    { d: 'M8.6 8.2a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0-6.8 0Z' },
    { d: 'M4.8 19.4c1.6-3.4 4.3-5.1 7.2-5.1s5.6 1.7 7.2 5.1' },
  ],
  clock: [ // countdown mark — plain circle + two hands, no emoji
    { d: 'M4.5 12a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0-15 0Z' },
    { d: 'M12 7.3V12l3.1 1.9' },
  ],
  code: [ // </> dev mark
    { d: 'M9 8 5 12l4 4' },
    { d: 'M15 8l4 4-4 4' },
  ],
  search: [ // magnifier — lens + handle, drawn on the same 24 grid as the rest
    { d: 'M4.8 10.9a6.1 6.1 0 1 0 12.2 0a6.1 6.1 0 1 0-12.2 0Z' },
    { d: 'M15.4 15.4 20 20' },
  ],
  plus: [{ d: 'M12 5.5v13M5.5 12h13' }], // "add one more" — same weight as close
}

export function Icon({ name, size = 22, color = '#9a6a82', stroke = 1.8 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name].map((p, i) => (
        <path key={i} d={p.d} fill={p.fill ? color : 'none'}
          stroke={p.s === false ? 'none' : color} opacity={p.o ?? 1} />
      ))}
    </svg>
  )
}
