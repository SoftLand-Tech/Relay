/**
 * Design tokens.
 *
 * Palette follows the ChatGPT dark theme: true black canvas, near-black
 * elevated surfaces, one blue accent reserved for primary actions. The token
 * names are kept stable so every screen picks up the new palette without
 * touching its own styles.
 */
export const C = {
  // Surfaces
  bg: '#000000',
  bgCard: '#1C1C1C',
  bgElev: '#212121',
  bgHover: '#2C2C2C',
  inputBg: '#212121',
  scrim: 'rgba(0,0,0,0.55)',

  // Text
  text: '#FFFFFF',
  textDim: '#B4B4B4',
  textFaint: '#8C8C8C',

  // Accent — reserved for primary actions only (send, new chat, active nav).
  accent: '#2F8CFF',
  accentDark: '#1B6ED1',

  // Status
  green: '#10A37F',
  greenSoft: '#4ADE80',
  red: '#FF5A5A',
  amber: '#F5A524',

  border: '#2F2F2F',
  borderSoft: '#232323',

  // Messages — the assistant is unboxed, the user sits in a soft bubble.
  userBubble: '#2A2A2A',
  assistantBubble: 'transparent',
}

export const FONT = { regular: '400', medium: '500', bold: '700' } as const

/** ChatGPT-style pill. `size` is the pill height; radius is always half of it. */
export function pill(height: number) {
  return { borderRadius: height / 2, minHeight: height }
}
