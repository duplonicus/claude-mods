/**
 * The thinking rainbow: while the spinner says Claude is thinking, its word is
 * a rainbow that flows faster the faster the thinking streams in. Pure, so the
 * surface module (rainbow.tsx), the hooks and the tests share it.
 */

// How far back the thinking speed is measured.
const RATE_WINDOW_MS = 1500
// The rainbow's flow, in degrees of hue a second: a crawl with nothing
// streaming, about a turn a second at a brisk 400 characters a second.
const MIN_FLOW = 40
const FLOW_PER_CHAR = 0.8
const MAX_FLOW = 720
// Hue between neighbouring characters: a seven-letter word spans most of the wheel.
export const HUE_SPREAD = 40

/** Characters of thinking that arrived, and when, per agent ('main' for the session's own). */
export class ThoughtMeter {
  private arrivals = new Map<string, { at: number; chars: number }[]>()

  add(agent: string, chars: number, at: number) {
    const list = this.arrivals.get(agent) ?? []
    list.push({ at, chars })
    while (list.length && list[0]!.at < at - RATE_WINDOW_MS) list.shift()
    this.arrivals.set(agent, list)
  }

  has(agent: string) {
    return this.arrivals.has(agent)
  }

  /** Characters a second over the last window. */
  rate(agent: string, now: number): number {
    const recent = (this.arrivals.get(agent) ?? []).filter(a => a.at >= now - RATE_WINDOW_MS)
    return (recent.reduce((sum, a) => sum + a.chars, 0) * 1000) / RATE_WINDOW_MS
  }
}

/** Degrees of hue a second the rainbow flows at, for a thinking rate in characters a second. */
export const flow = (rate: number) => Math.min(MAX_FLOW, MIN_FLOW + rate * FLOW_PER_CHAR)

/** The color of a hue, at the saturation and lightness of the engine's own rainbow. */
export function hueColor(hue: number): string {
  const h = (((hue % 360) + 360) % 360) / 60
  const s = 0.7
  const l = 0.6
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const x = chroma * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] = h < 1 ? [chroma, x, 0] : h < 2 ? [x, chroma, 0] : h < 3 ? [0, chroma, x] : h < 4 ? [0, x, chroma] : h < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = l - chroma / 2
  const channel = (v: number) => Math.round((v + m) * 255)
  return `rgb(${channel(r)},${channel(g)},${channel(b)})`
}
