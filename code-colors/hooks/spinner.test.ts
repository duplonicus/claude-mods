import { expect, test } from 'claude-code/testing'

import { glyphAt, glyphs, isLit, shimmerAt } from './spinner'

test("the glyph turns up and back over two seconds, eased, as the engine's spinner", () => {
  // At 500 ms the easing is a hair under half (cos(π/2) is not quite 0), as in the engine.
  expect([0, 250, 500, 750, 1000, 1500, 2000].map(ms => glyphAt(ms))).toEqual(['·', '✢', '*', '✻', '✽', '✶', '·'])
  expect(glyphAt(1000, glyphs('xterm-ghostty'))).toBe('✻')
  expect(glyphs('xterm-256color')).toEqual(['·', '✢', '*', '✶', '✻', '✽'])
})

test('the shimmer comes in from the right, one character per 200 ms, and runs out ten past each end', () => {
  // `Bash()` is 6 long: the middle starts 10 past its end and comes round after 26 steps.
  expect(shimmerAt(0, 6)).toBe(16)
  expect(shimmerAt(11 * 200, 6)).toBe(5)
  expect(shimmerAt(16 * 200 + 199, 6)).toBe(0)
  expect(shimmerAt(26 * 200, 6)).toBe(16)
  expect([3, 4, 5, 6, 7].map(i => isLit(i, 5))).toEqual([false, true, true, true, false])
})
