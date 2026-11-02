import { expect, test } from 'claude-code/testing'

import { LONGEST_MODE_LABEL, cells, hintGap, placeButtons, readStatusRows, statusFile } from './place'

const HINT = '(shift+tab to cycle)'

test('the saved widths are read; a file without them, or not JSON, gives none', () => {
  expect(readStatusRows('{"pct": 8, "rows": [107, 103], "cols": 181, "t": 1}')).toEqual({ rows: [107, 103], cols: 181 })
  expect(readStatusRows('{"pct": 8, "t": 1}')).toBeUndefined()
  expect(readStatusRows('{"rows": [], "cols": 80}')).toBeUndefined()
  expect(readStatusRows('{"rows": ["80"], "cols": 80}')).toBeUndefined()
  expect(readStatusRows('{"rows": [80], "cols": null}')).toBeUndefined()
  expect(readStatusRows('{"rows": [8')).toBeUndefined()
  expect(statusFile('/home/me', 'abc-123')).toBe('/home/me/.cache/claude-statusline/sessions/abc-123.json')
})

test('a wide window keeps the buttons beside the status line', () => {
  // The probe: rows 80 and 81 in 160 columns, ↩ ▲ ▼.
  expect(placeButtons({ columns: 160, status: { rows: [80, 81], cols: 160 }, modes: '', hint: HINT, buttons: 9 })).toBe('status')
  // Exactly full: 146 + 1 + 9 = 156, the footer's room in 160 columns.
  expect(placeButtons({ columns: 160, status: { rows: [146, 20], cols: 160 }, modes: '', hint: HINT, buttons: 9 })).toBe('status')
})

test('when the status line leaves no room, the buttons go to the permission-mode line', () => {
  expect(placeButtons({ columns: 160, status: { rows: [147, 20], cols: 160 }, modes: '', hint: HINT, buttons: 9 })).toBe('hint')
  // The widest row counts, and the mode labels share the block with the buttons.
  expect(placeButtons({ columns: 100, status: { rows: [40, 95], cols: 100 }, modes: '', hint: HINT, buttons: 9 })).toBe('hint')
  expect(placeButtons({ columns: 100, status: { rows: [83, 60], cols: 100 }, modes: 'focus', hint: HINT, buttons: 9 })).toBe('hint')
  expect(placeButtons({ columns: 100, status: { rows: [83, 60], cols: 100 }, modes: '', hint: HINT, buttons: 9 })).toBe('status')
})

test('a permission-mode line without room leaves the buttons where the engine wraps them', () => {
  // 50 - 4 - 27 - 20 - 9 = -10: no gap.
  expect(placeButtons({ columns: 50, status: { rows: [48, 30], cols: 50 }, modes: '', hint: HINT, buttons: 9 })).toBe('status')
  // One blank cell is enough.
  const columns = 4 + LONGEST_MODE_LABEL + HINT.length + 9 + 1
  expect(hintGap(columns, HINT, 9)).toBe(1)
  expect(placeButtons({ columns, status: { rows: [columns], cols: columns }, modes: '', hint: HINT, buttons: 9 })).toBe('hint')
  expect(placeButtons({ columns: columns - 1, status: { rows: [columns], cols: columns - 1 }, modes: '', hint: HINT, buttons: 9 })).toBe('status')
})

test('without widths fitted to this window the buttons stay in the SessionMode block', () => {
  const narrow = { rows: [95, 40], cols: 100 }
  expect(placeButtons({ columns: 100, status: undefined, modes: '', hint: HINT, buttons: 9 })).toBe('status')
  expect(placeButtons({ columns: undefined, status: narrow, modes: '', hint: HINT, buttons: 9 })).toBe('status')
  // Fitted to 120 before a resize to 100: not this window's.
  expect(placeButtons({ columns: 100, status: { ...narrow, cols: 120 }, modes: '', hint: HINT, buttons: 9 })).toBe('status')
})

test('the gap puts the buttons at the right end of the line in the longest mode', () => {
  // 160 columns: 2 + 27 + 20 + gap + 9 ends at 158, the footer's right end.
  expect(2 + LONGEST_MODE_LABEL + HINT.length + hintGap(160, HINT, 9) + 9).toBe(158)
  expect(LONGEST_MODE_LABEL).toBe(27)
})

// Bun.stringWidth's answers (the footer measures with it), read from bun
// 2026-10-29; claude-statusline's cells() is pinned to the same table.
const BUN_WIDTHS: Record<string, number> = {
  '⏵⏵ bypass permissions on · ': 27, '修正 🔧': 7, 'e\u0301': 1, '⚠️': 2, '⚠': 1, '👍🏽': 2,
  'a\u200db': 2, '👨\u200d👩\u200d👧': 2, '❤️': 2, 'ｱｲ': 2, '한국어': 6, 'ＡＢ': 4, '©️': 2,
  '🇨🇦': 2, '…▏─': 3, 'x\ufe0fy': 2, '1️⃣': 2, '日本 branch/修正': 16,
  '↩️': 2, '↔️': 2, '⤴️': 2, '‼️': 2, '⁉️': 2, 'ℹ️': 2, '™️': 2, '#️⃣': 2, '✔️': 2, '〰️': 2, '#\ufe0f': 1,
}

test('cells count wide characters and emoji as the footer does', () => {
  expect(Object.fromEntries(Object.keys(BUN_WIDTHS).map(s => [s, cells(s)]))).toEqual(BUN_WIDTHS)
})
