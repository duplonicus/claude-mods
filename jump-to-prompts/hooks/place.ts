/**
 * Which footer row the ↩ ▲ ▼ buttons go on.
 *
 * The footer under the prompt box is a wrapping row: on the left a column of
 * the status line's rows and then the permission-mode line, on the right the
 * SessionMode block (mode labels, and here the buttons), pushed to the right
 * end. When the status line leaves no room beside it, the engine wraps that
 * block below everything. Before that happens the buttons move to the right end
 * of the permission-mode line, if it has room; failing that, they go where the
 * engine wraps them.
 *
 * A mod is not told how wide the status line is. claude-statusline saves its
 * printed rows' widths, and the $COLUMNS it fitted them to, per session; with
 * no such file (another status line) the buttons stay in the SessionMode block.
 */

export type Place = 'status' | 'hint'

/** The status line's printed rows, in cells, and the width they were fitted to. */
export type StatusRows = { rows: number[]; cols: number }

/** Where claude-statusline saves a session's rows (its record_context). */
export const statusFile = (home: string, sessionId: string) => `${home}/.cache/claude-statusline/sessions/${sessionId}.json`

// The footer's rows run from column 2 to two short of the right edge (seen in
// a 160-column probe: the buttons' last cell at 158).
export const FOOTER_INSET = 4

// On the permission-mode line the engine draws the mode label and " · " before
// a hook's own tree, and does not say which mode it is (props.hint leaves the
// label out; shift+tab changes it without any event). Room is counted for the
// longest label, so a tree never overflows the line: an overflow wraps the
// engine's " · " onto a row of its own and clips the buttons (seen live).
// In a shorter mode the buttons sit up to 9 cells short of the right end.
export const LONGEST_MODE_LABEL = '⏵⏵ bypass permissions on · '.length

// Wide in the terminal, as Bun.stringWidth (the footer's measure) counts them:
// emoji shown as emoji (not the flag letters, 1 each) and the CJK blocks.
const WIDE =
  /(?![\u{1f1e6}-\u{1f1ff}])\p{Emoji_Presentation}|[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u
const SKIN_TONE = /[\u{1f3fb}-\u{1f3ff}]/u
// What an emoji presentation selector widens: an emoji, but not a keycap's # * or digit.
const TEXT_EMOJI = /(?![#*0-9])\p{Emoji}/u

/**
 * Cells a string takes in the footer, matching Bun.stringWidth: wide
 * characters and emoji 2, marks and joiners 0, the rest 1.
 */
export function cells(text: string) {
  let n = 0
  let prev = ''
  for (const ch of text) {
    if (ch === '\ufe0f') {
      if (prev && !WIDE.test(prev) && TEXT_EMOJI.test(prev)) n += 1 // emoji presentation (↩️ ℹ️ ‼️): 2
    } else if (ch === '\u20e3') n += 1 // a keycap (1️⃣) is 2 wide
    else if (prev && (SKIN_TONE.test(ch) || (prev === '\u200d' && WIDE.test(ch)))) {
      // a skin tone, or an emoji joined to the one before it
    } else if (!ZERO_WIDTH.test(ch)) n += WIDE.test(ch) ? 2 : 1
    prev = ch
  }
  return n
}

export function readStatusRows(text: string): StatusRows | undefined {
  try {
    const { rows, cols } = JSON.parse(text) as { rows?: unknown; cols?: unknown }
    const isWidth = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
    if (!Array.isArray(rows) || !rows.length || !rows.every(isWidth) || !isWidth(cols)) return undefined
    return { rows, cols }
  } catch {
    return undefined
  }
}

/**
 * The row for `buttons` cells of buttons, given the window's width, the status
 * line's rows (only trusted when fitted to this width), the SessionMode labels
 * and the permission-mode line's hint text.
 */
export function placeButtons(o: { columns?: number; status?: StatusRows; modes: string; hint: string; buttons: number }): Place {
  if (o.columns === undefined || !o.status || o.status.cols !== o.columns) return 'status'
  const room = o.columns - FOOTER_INSET
  const besideStatus = Math.max(...o.status.rows) + 1 + cells(o.modes) + o.buttons
  if (besideStatus <= room) return 'status'
  return hintGap(o.columns, o.hint, o.buttons) >= 1 ? 'hint' : 'status'
}

/** The blank cells between the hint text and the buttons on the permission-mode line. */
export const hintGap = (columns: number, hint: string, buttons: number) =>
  columns - FOOTER_INSET - LONGEST_MODE_LABEL - cells(hint) - buttons
