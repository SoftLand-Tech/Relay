/**
 * Design tokens.
 *
 * Palette extracted from the logo assets: the mark is a cream robot with a
 * navy face and one orange antenna on pure black. Surfaces derive from the
 * face navy (hue ~249°) kept near-black, the antenna orange #F79236 (hue 29°,
 * the only saturated element) is the single accent reserved for primary
 * actions, and every neutral (text grays, borders, bubbles) is hue-locked to
 * the 247-254° indigo band. Anything sitting on the accent uses `onAccent` —
 * dark ink — because white fails contrast (2.3:1) on this lightness of orange.
 * The token names are kept stable so every screen picks up the palette
 * without touching its own styles.
 */
export const C = {
  // Surfaces — hue-matched to the logo face navy, kept near-black.
  bg: '#0A0813',
  bgCard: '#151220',
  bgElev: '#1A1727',
  bgHover: '#272535',
  inputBg: '#1A1727',
  scrim: 'rgba(0,0,0,0.55)',

  // Text
  text: '#FFFFFF',
  textDim: '#B4B1C4',
  textFaint: '#86829B',

  // Accent — the Moch logo antenna orange. `onAccent` is the ink that sits on it.
  accent: '#F79236',
  accentDark: '#C56F1F',
  onAccent: '#2E1A08',

  // Status
  green: '#10A37F',
  greenSoft: '#4ADE80',
  red: '#FF5A5A',
  amber: '#F5A524',

  // Derived soft tints — the translucent washes the command-output cards fill
  // their alert/confirm bodies and hint chips with. 12% of the parent ink;
  // accentSoft doubles as the code_inline background so cards and chat prose
  // render inline code identically. No component hardcodes an rgba of a token.
  accentSoft: 'rgba(247,146,54,0.12)',
  redSoft: 'rgba(255,90,90,0.12)',
  amberSoft: 'rgba(245,165,36,0.12)',
  greenTint: 'rgba(74,222,128,0.12)',

  border: '#2B283B',
  borderSoft: '#201C2D',

  // Messages — the assistant is unboxed, the user sits in a soft bubble.
  userBubble: '#262236',
  assistantBubble: 'transparent',
}

export const FONT = { regular: '400', medium: '500', bold: '700' } as const

/** ChatGPT-style pill. `size` is the pill height; radius is always half of it. */
export function pill(height: number) {
  return { borderRadius: height / 2, minHeight: height }
}
