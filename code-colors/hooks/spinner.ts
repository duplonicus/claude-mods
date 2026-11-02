/**
 * The engine's spinner, copied (2.1.312, the chunk exporting DHn and T1e, and
 * the spinner line's glimmer): a running Bash row's bullet turns like the
 * spinner's glyph, and its `Bash(` `)` shimmers like the spinner's word. Pure,
 * so the surface module (running.tsx) and the tests share it.
 */

// The glyphs, as the engine picks them by $TERM: Ghostty's font has `✳`.
const GLYPHS = ['·', '✢', '*', '✶', '✻', '✽']
const GHOSTTY_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✻']
// One turn of the glyph, up and back, eased (the engine's T1e over 2000 ms).
const GLYPH_CYCLE_MS = 2000
// The word's shimmer moves one character this often, right to left.
const SHIMMER_STEP_MS = 200
// How far past each end of the word the shimmer runs before it comes round.
const SHIMMER_RUN_OUT = 10

/** The theme color the spinner draws in, and the dark theme's shimmer over it (no theme key names that one). */
export const SPINNER_COLOR = 'claude'
export const SHIMMER_COLOR = 'rgb(235,159,127)'

/** How often the surface module redraws: the glyph's quickest change is about this. */
export const TICK_MS = 100

export const glyphs = (term: string | undefined) => (term === 'xterm-ghostty' ? GHOSTTY_GLYPHS : GLYPHS)

/** The glyph `ms` into the row's run. */
export function glyphAt(ms: number, set: readonly string[] = GLYPHS): string {
  const eased = (1 - Math.cos((2 * Math.PI * ms) / GLYPH_CYCLE_MS)) / 2
  return set[Math.round(eased * (set.length - 1))]!
}

/** Which character of a word `length` long is the shimmer's middle `ms` in; off the word for part of each round. */
export function shimmerAt(ms: number, length: number): number {
  const round = length + 2 * SHIMMER_RUN_OUT
  return length + SHIMMER_RUN_OUT - (Math.floor(ms / SHIMMER_STEP_MS) % round)
}

/** Whether character `index` is lit: the shimmer is three characters wide. */
export const isLit = (index: number, middle: number) => Math.abs(index - middle) <= 1
