/**
 * Design tokens.
 *
 * Palette extracted from the logo assets: the mark is brand cyan #39CADB
 * (hue 186°, >50% of logo.png's opaque pixels) on dark teal #0E181B (93% of
 * icon.png). The canvas and elevated surfaces derive from that teal, the logo
 * cyan is the single accent reserved for primary actions, and every neutral
 * (text grays, borders, bubbles) is hue-locked to the same 186–194° band.
 * Anything sitting on the accent uses `onAccent` — dark ink — because white
 * fails contrast on this lightness of cyan. The token names are kept stable
 * so every screen picks up the palette without touching its own styles.
 */
export const C = {
  // Surfaces — hue-matched to the logo cyan, kept near-black.
  bg: '#060D0F',
  bgCard: '#121B1D',
  bgElev: '#162022',
  bgHover: '#233134',
  inputBg: '#162022',
  scrim: 'rgba(0,0,0,0.55)',

  // Text
  text: '#FFFFFF',
  textDim: '#AEBDBF',
  textFaint: '#829396',

  // Accent — the Relay logo cyan. `onAccent` is the ink that sits on it.
  accent: '#39CADB',
  accentDark: '#2795A3',
  onAccent: '#052529',

  // Status
  green: '#10A37F',
  greenSoft: '#4ADE80',
  red: '#FF5A5A',
  amber: '#F5A524',

  border: '#26383A',
  borderSoft: '#1A2628',

  // Messages — the assistant is unboxed, the user sits in a soft bubble.
  userBubble: '#1F2C2F',
  assistantBubble: 'transparent',
}

export const FONT = { regular: '400', medium: '500', bold: '700' } as const

/** ChatGPT-style pill. `size` is the pill height; radius is always half of it. */
export function pill(height: number) {
  return { borderRadius: height / 2, minHeight: height }
}
