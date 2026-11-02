/**
 * The conversation as a list of rows, read from the session's transcript
 * (JSONL), and the pick of which prompt a button press scrolls to.
 *
 * Only rows the transcript draws as messages are kept: your prompts, and the
 * text blocks of Claude's replies. Tool calls and tool results are left out;
 * the engine keys those by tool_use_id, not by the row's uuid.
 */

/**
 * One transcript row. `scrollId` is what `$.ui.scroll` takes for it when that
 * is not its uuid: a tool call's row is drawn under its tool_use id.
 */
export type Row = { id: string; isPrompt: boolean; scrollId?: string }

/** Which part of a message is on screen, as `UserMessage` / `AssistantMessage` report it. */
export type Shown = { first: number; last: number; of: number }

export type Jump = { id: string; block: 'start' | 'end' }

/** The row the last jump went to, how it was placed, and when (ms). */
export type Pin = { key: string; block: Jump['block']; time: number; landing?: string }

/**
 * A row's key for matching render events to transcript rows. The engine has
 * handed `ui.render` both the full uuid and one with its last group zeroed
 * (`1a2b3c4d-5e6f-4a7b-8c9d-000000000000`, seen on a resumed session), so the
 * first four groups are what both forms share.
 */
export const keyOf = (id: string) => id.slice(0, 23)

/** The key a row's on-screen reports arrive under: a tool row's by its tool_use id. */
export const rowKey = (row: Row) => keyOf(row.scrollId ?? row.id)

// For rows stored without an origin: text that starts with one of these is the
// engine's, not something you typed. An auto-run skill is stored as
// command-message with no origin; one you typed carries origin human.
// This mod's own name: a prompt its ↩ button sent is stored with a plugin
// origin under it, and is yours like a typed one.
export const MOD_NAME = 'jump-to-prompts'

type Origin = { kind?: string; name?: string } | null | undefined

/** Whether a stored origin is yours: typed, or sent by this mod's ↩. */
export const isYourOrigin = (origin: Origin) =>
  origin?.kind === 'human' || (origin?.kind === 'plugin' && origin.name === MOD_NAME)

const ENGINE_TEXT =
  /^(<(local-command-|command-message|task-notification|system-reminder|bash-stdout|bash-stderr)|\[Request interrupted by user)/

type Block = { type?: string; text?: string; id?: string }
type Entry = {
  type?: string
  uuid?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  origin?: Origin
  attachment?: { type?: string; commandMode?: string; origin?: Origin }
  message?: { content?: string | Block[] }
}

export const rowOf = (entry: Entry): Row | undefined => {
  if (!entry.uuid || entry.isSidechain) return undefined
  const content = entry.message?.content
  if (entry.type === 'assistant') {
    if (!Array.isArray(content)) return undefined
    if (content.some(block => block.type === 'text' && block.text?.trim())) return { id: entry.uuid, isPrompt: false }
    // A tool call's row. Thinking-only entries are left out: the engine draws
    // nothing $.ui.scroll can reach under their uuid (seen: "nothing drawn").
    const toolUse = content.find(block => block.type === 'tool_use' && block.id)
    return toolUse ? { id: entry.uuid, isPrompt: false, scrollId: toolUse.id } : undefined
  }
  // A prompt you sent while Claude was working, delivered into the running
  // turn. It is drawn under this entry's uuid (seen live; source_uuid is refused).
  if (entry.type === 'attachment') {
    const attachment = entry.attachment
    const isYours = attachment?.type === 'queued_command' && isYourOrigin(attachment.origin)
    return isYours && (attachment.commandMode ?? 'prompt') === 'prompt' ? { id: entry.uuid, isPrompt: true } : undefined
  }
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary) return undefined
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content) && !content.some(block => block.type === 'tool_result'))
    text = content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
  else return undefined
  text = text.trimStart()
  if (!text) return undefined
  const isPrompt = entry.origin?.kind ? isYourOrigin(entry.origin) : !ENGINE_TEXT.test(text)
  return isPrompt ? { id: entry.uuid, isPrompt: true } : undefined
}

/**
 * Parses the complete lines of a chunk of the transcript. `consumed` is how
 * many characters of `chunk` they span, so a half-written last line is read
 * again on the next call.
 */
export const parseChunk = (chunk: string): { rows: Row[]; consumed: number } => {
  const end = chunk.lastIndexOf('\n') + 1
  const rows: Row[] = []
  for (const line of chunk.slice(0, end).split('\n')) {
    if (!line) continue
    let entry: Entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const row = rowOf(entry)
    if (row) rows.push(row)
  }
  return { rows, consumed: end }
}

/**
 * One read of the transcript: the rows in its complete lines, the text it
 * used up (the caller advances its byte offset by that), and whether to read
 * on. A single line longer than the read (a huge pasted image) is dropped
 * rather than stopping the reader for good: `dropping` carries over until the
 * read that holds its end.
 */
export const readChunk = (
  chunk: string,
  dropping: boolean,
  isTruncated: boolean,
): { rows: Row[]; used: string; dropping: boolean; more: boolean } => {
  let start = 0
  if (dropping) {
    const end = chunk.indexOf('\n')
    if (end < 0) return { rows: [], used: chunk, dropping: true, more: isTruncated }
    start = end + 1
  }
  const { rows, consumed } = parseChunk(chunk.slice(start))
  if (isTruncated && start + consumed === 0) return { rows, used: chunk, dropping: true, more: true }
  return { rows, used: chunk.slice(0, start + consumed), dropping: false, more: isTruncated }
}

/** An on-screen report and when it last changed (ms). */
export type Report = { at: Shown; time: number }

// Reports from one redraw arrive within a few ms of each other.
export const BURST_MS = 100 // seen live: 30 ms between the two edges of one scroll
// The redraw a jump itself causes, which must not count as you scrolling.
export const JUMP_SETTLE_MS = 300

/**
 * The rows on screen now. The engine reports a message again only when what it
 * shows of it changes, which on a scroll is the messages at the two edges. So
 * the newest burst of reports holds the edges of the current view, and its
 * earliest row is the top. Older reports can be stale: a row a long jump went
 * past may never be reported leaving (seen live), so they are ignored.
 */
export const onScreenNow = (rows: readonly Row[], reports: ReadonlyMap<string, Report>): Map<string, Shown> => {
  // Only rows count: a report from a row that is not a jump target (a task
  // notification) would otherwise set the newest time and hide the real edges.
  let newest = -Infinity
  for (const row of rows) newest = Math.max(newest, reports.get(rowKey(row))?.time ?? -Infinity)
  const shown = new Map<string, Shown>()
  for (const row of rows) {
    const report = reports.get(rowKey(row))
    if (report && report.time >= newest - BURST_MS) shown.set(rowKey(row), report.at)
  }
  return shown
}

/**
 * Where you are for the next press. After a jump to the start of a prompt that
 * prompt is the top, even when the conversation's end kept it from reaching
 * the top edge (then nothing moves and nothing new is reported). After a jump
 * to the end, the last row is fully on screen even though a row that stays
 * fully shown is never reported again (seen live: ▼ then went back up). That holds
 * until you scroll yourself: the prompt or a row above it reports a change
 * after the jump's own redraw settled. The caller also drops the pin when the
 * prompt reports leaving the screen.
 *
 * @param pinned the row the last jump went to, how it was placed, and when
 */
export const whereNow = (
  rows: readonly Row[],
  reports: ReadonlyMap<string, Report>,
  pinned: Pin | undefined,
): Map<string, Shown> => {
  const at = pinned === undefined ? -1 : rows.findIndex(row => rowKey(row) === pinned.key)
  const landed = pinned?.landing === undefined ? -1 : rows.findIndex(row => rowKey(row) === pinned.landing)
  const settled = pinned === undefined ? 0 : pinned.time + JUMP_SETTLE_MS
  // The row the jump landed on sits at the top edge, so any scroll changes it.
  const moved = rows.slice(0, Math.max(at, landed) + 1).some(row => (reports.get(rowKey(row))?.time ?? 0) > settled)
  if (at < 0 || moved) return onScreenNow(rows, reports)
  if (pinned!.block === 'start') return new Map([[pinned!.key, { first: 0, last: 0, of: 1 }]])
  // At the end: the newest burst still says where the top is; add the last row, whole.
  const shown = onScreenNow(rows, reports)
  // A row taller than the window is shown from its top: trust its own report then.
  shown.set(pinned!.key, reports.get(pinned!.key)?.at ?? { first: 0, last: 0, of: 1 })
  return shown
}

/**
 * The row a press scrolls to, or undefined when there is nowhere to go.
 *
 * "Where you are" is the topmost transcript row that is on screen. Up goes to
 * that row when it is a prompt whose head is scrolled away, otherwise to the
 * prompt before it. Down goes to the next prompt after it, and past the last
 * prompt to the bottom of the conversation.
 *
 * @param shown on-screen rows by `keyOf` their id
 * @param lastTop the top row's index from an earlier press, for a screen that
 *   shows only tool rows (no message reports where it is)
 */
export const pickJump = (
  rows: readonly Row[],
  shown: ReadonlyMap<string, Shown>,
  direction: 'up' | 'down',
  lastTop?: number,
): Jump | undefined => {
  let top = rows.findIndex(row => shown.has(rowKey(row)))
  if (top < 0) top = lastTop ?? rows.length
  const topRow = rows[top]

  if (direction === 'up') {
    // Row 0 of a message is the blank spacer above it; past that, its text is cut.
    if (topRow?.isPrompt && (shown.get(rowKey(topRow))?.first ?? 0) > 1) return { id: topRow.id, block: 'start' }
    const before = rows.slice(0, top).findLast(row => row.isPrompt)
    return before && { id: before.id, block: 'start' }
  }

  // At the bottom already: the last prompt cannot scroll any higher, and a
  // press that re-targets it moves nothing (seen: ▼ hit "delta" twice).
  const last = rows[rows.length - 1]
  const lastShown = last && shown.get(rowKey(last))
  if (!last || (lastShown && lastShown.last >= lastShown.of - 1)) return undefined
  const after = rows.slice(top + 1).find(row => row.isPrompt)
  if (after) return { id: after.id, block: 'start' }
  if (top >= rows.length - 1) return undefined
  return { id: last.id, block: 'end' }
}


/**
 * Where a jump to a prompt lands, best first. Fullscreen pins the prompt of the
 * turn at the top of the view as a sticky header, so landing on the prompt row
 * itself shows the previous turn's prompt above it (two prompts stacked).
 * Landing on the first reply or tool row after it makes the header that
 * prompt, once. The prompt row itself is the fallback (the last row, or a
 * row the engine refuses).
 */
export const landingIds = (rows: readonly Row[], target: Row): string[] => {
  const ids = [target.scrollId ?? target.id]
  const next = rows[rows.indexOf(target) + 1]
  // Even when the next row is another prompt (two sent back to back): the
  // header then reads this prompt, with the next one right under it.
  if (target.isPrompt && next) ids.unshift(next.scrollId ?? next.id)
  return ids
}
