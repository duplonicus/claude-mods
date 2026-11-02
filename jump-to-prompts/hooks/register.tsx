import type { EngineInterface, Register } from 'claude-code'

import { commandOf, heldBack } from './draft'
import { hintGap, placeButtons, readStatusRows, statusFile, type Place, type StatusRows } from './place'
import { JUMP_SETTLE_MS, MOD_NAME, keyOf, landingIds, readChunk, rowKey, pickJump, whereNow, type Pin, type Report, type Row, type Shown } from './rows'

/**
 * jump-to-prompts: ↩ ▲ ▼ buttons at the right end of the row under the
 * prompt box (the footer's mode-label site), or of the permission-mode line
 * when the status line leaves no room beside it (see place.ts). ▲ scrolls the conversation to
 * the prompt you sent before the one on screen, ▼ to the next one, and past
 * the last prompt to the bottom. ↩ presses Enter in the prompt box.
 * Clicking needs fullscreen rendering ("tui": "fullscreen").
 *
 * The order of prompts comes from the session's transcript file, because the
 * screen only draws the rows near the viewport. Where you are comes from the
 * `onScreen` the engine reports on each message it draws. `$.ui.scroll` moves
 * a transcript row only while answering your own input, which a press is.
 */

// A message row the engine refuses to scroll to (rewound away, or not drawn as
// a message) is skipped; this caps how many a press tries before giving up.
const MAX_TRIES = 5
// The suffix the engine has used for a uuid it shortened (see keyOf).
const SHORT_SUFFIX = '-000000000000'
// The longest wait for a jump's first scroll to draw before the second (see jump).
const HEADER_CATCH_UP_MAX_MS = 100
// The refusal for an id the engine has nothing drawn under (seen live).
const UNKNOWN_ID = 'nothing drawn under that requestId'
// Origins of rows you typed; a row drawn with any other origin is not a jump
// target, save a prompt this mod's ↩ sent.
const YOUR_ORIGINS = new Set(['composer', 'bridge', 'unclassified'])
const isYours = (origin: { kind: string; name?: string }) =>
  YOUR_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.name === MOD_NAME)

let transcript: string | undefined
let offset = 0 // bytes of the transcript already read
let dropping = false // inside one line longer than a read (4 MiB): skip to its end
let rows: Row[] = []
let refreshing: Promise<void> = Promise.resolve()
const reports = new Map<string, Report>() // on-screen reports by rowKey
const skipped = new Set<string>() // keys of rows that are not your prompts, or that refused a scroll
let lastTopKey: string | undefined
let pinned: Pin | undefined // the row the last jump went to (see whereNow)
let drawn: { key: string; resolve: () => void } | undefined // a jump waiting for its row to be drawn

function follow(path: string | undefined) {
  if (!path || path === transcript) return
  // /clear and /resume start a new transcript; the old rows are not on screen.
  transcript = path
  offset = 0
  dropping = false
  rows = []
  reports.clear()
  skipped.clear()
  lastTopKey = undefined
  pinned = undefined
}

// Reads the transcript lines added since the last read. Calls queue, so two
// presses never read the same bytes twice.
function refresh($: EngineInterface): Promise<void> {
  refreshing = refreshing
    .then(async () => {
      const path = transcript
      if (!path) return
      for (;;) {
        const run = await $.process.run(['tail', '-c', `+${offset + 1}`, path])
        if (run.exitCode !== 0 || path !== transcript) return
        const read = readChunk(run.stdout, dropping, Boolean(run.isStdoutTruncated))
        rows.push(...read.rows)
        offset += new TextEncoder().encode(read.used).length
        dropping = read.dropping
        if (!read.more) return
      }
    })
    .catch(() => undefined)
  return refreshing
}

async function jump($: EngineInterface, direction: 'up' | 'down') {
  await refresh($)
  const candidates = rows.filter(row => !skipped.has(rowKey(row)))
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const lastTop = candidates.findIndex(row => rowKey(row) === lastTopKey)
    const shown = whereNow(candidates, reports, pinned)
    const target = pickJump(candidates, shown, direction, lastTop < 0 ? undefined : lastTop)
    await debug($, () => ({
      direction,
      now: Date.now(),
      pinned: pinned && { index: candidates.findIndex(row => rowKey(row) === pinned!.key), time: pinned.time },
      shown: [...shown].map(([key, at]) => [candidates.findIndex(row => rowKey(row) === key), at]),
      reports: [...reports].map(([key, r]) => [candidates.findIndex(row => rowKey(row) === key), r.at, r.time]).sort((a, b) => (a[0] as number) - (b[0] as number)),
      target: target && { index: candidates.findIndex(row => row.id === target.id), block: target.block },
    }))
    if (!target) return
    const row = candidates.find(candidate => candidate.id === target.id)!
    const ids = landingIds(candidates, row)
    if (!row.scrollId) ids.push(keyOf(row.id) + SHORT_SUFFIX)
    for (const requestId of ids) {
      const isDrawn = new Promise<void>(resolve => (drawn = { key: keyOf(requestId), resolve }))
      const result = await $.ui.scroll({ to: { requestId }, block: target.block })
      // Any refusal but an unknown id (the window moved meanwhile, a hook kept
      // it) ends this press and skips nothing; press again.
      if (result.deny && result.deny !== UNKNOWN_ID) return
      if (!result.deny) {
        lastTopKey = rowKey(row)
        const isRowItself = requestId === (row.scrollId ?? row.id) || requestId.endsWith(SHORT_SUFFIX)
        const landing = isRowItself ? undefined : keyOf(requestId) // the reply or tool row after a prompt
        pinned = { key: lastTopKey, block: target.block, time: Date.now(), landing }
        // The sticky header lags one step behind a scroll a mod makes (seen:
        // header "india" over hotel's reply). The same scroll again, once the
        // first has drawn, brings it up to date; it moves nothing itself. Too
        // early (0 ms) leaves the header stale; a fixed 60 ms showed the stale
        // frame long enough to see, so wait for the row's own draw report.
        await Promise.race([isDrawn, $.clock.sleep(HEADER_CATCH_UP_MAX_MS)])
        drawn = undefined
        await $.ui.scroll({ to: { requestId }, block: target.block })
        return
      }
    }
    skipped.add(rowKey(row))
    candidates.splice(
      candidates.findIndex(row => row.id === target.id),
      1,
    )
  }
}

// ↩ presses a real Enter where it can: on Windows (WSL included) through
// PowerShell's SendKeys, about half a second after the click, so pastes,
// images, bash mode and prompts typed mid-turn all go as Enter sends them. The
// key lands in the focused window, the terminal you just clicked; a press from
// Remote Control never takes this way. Elsewhere, or when the key did not
// send the draft, the mod sends it itself.
const PRESS_ENTER = ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).SendKeys('~')"]
// How long the box may keep the draft after the press before the key counts as
// missed: Enter empties it at once when it lands here.
const ENTER_SETTLE_MS = 1000
const ENTER_POLL_MS = 100

async function send($: EngineInterface, surface: string) {
  const { text } = await $.prompt.read()
  if (!text.trim()) return
  if (surface === 'terminal') {
    await $.process.run(PRESS_ENTER, { timeoutMs: 5000 }).catch(() => undefined)
    if (await enterTook($, text)) return
  }
  await sendDraft($, text)
}

// Whether the key sent the draft is read from the box, not from PowerShell's
// exit: exit 0 can mean the key went to another window, and a timeout can come
// after the key already sent the draft. A box that still holds the same draft
// a second on means nothing took it; any other text (sent, or you typed) means
// the mod must not send it again.
async function enterTook($: EngineInterface, text: string) {
  for (let waited = 0; ; waited += ENTER_POLL_MS) {
    if ((await $.prompt.read()).text !== text) return true
    if (waited >= ENTER_SETTLE_MS) return false
    await $.clock.sleep(ENTER_POLL_MS)
  }
}

// Sends the draft as your own words. The box is emptied first, as Enter does,
// and the draft put back, with a toast saying why, if the submit fails or a
// hook drops it. A plugin's prompt starts a turn of its own once the session
// is idle, so one sent mid-turn waits for the turn to end rather than joining it.
async function sendDraft($: EngineInterface, text: string) {
  const reason = heldBack(text)
  if (reason) return $.ui.toast(`↩ didn't send: ${reason}`)
  await $.prompt.fill({ text: '', mode: 'replace' })
  const command = commandOf(text)
  const sent = await (command ? $.command.run(command).then(() => ({ drop: undefined })) : $.prompt.submit({ text, asUser: true })).catch(
    (error: unknown) => ({ drop: String(error) }),
  )
  if (sent.drop === undefined) return
  await $.prompt.fill({ text, mode: 'replace' })
  $.ui.toast(`↩ didn't send: ${sent.drop}`)
}

// The footer's last props, from the terminal's SessionMode and PromptHint
// draws: each site's pick of a row needs the other's text too.
const footer: { columns?: number; modes: string; hint: string } = { modes: '', hint: '' }
let status: StatusRows | undefined
let statusReadAt = -Infinity
let rereading = false
let placed: Place = 'status'
// How often the status line's saved widths are read again, at most.
const STATUS_REREAD_MS = 1000

async function readStatus($: EngineInterface) {
  const home = await $.env.get('HOME')
  if (!home) return undefined
  const text = await $.fs.read(statusFile(home, await $.session.id())).catch(() => undefined)
  return text === undefined ? undefined : readStatusRows(text)
}

const buttonCells = () => (rows.some(row => row.isPrompt) ? 9 : 3)

// The row the buttons go on now. Widths fitted to another width (the status
// line has not run since a resize) are read again a second later. A change of
// row redraws both sites, since each draws from the other's last props.
async function placeNow($: EngineInterface): Promise<Place> {
  if (Date.now() - statusReadAt >= STATUS_REREAD_MS) {
    statusReadAt = Date.now()
    status = await readStatus($).catch(() => undefined)
  }
  if (status && footer.columns !== undefined && status.cols !== footer.columns && !rereading) {
    rereading = true
    void $.clock.sleep(STATUS_REREAD_MS).then(() => {
      rereading = false
      return placeNow($)
    })
  }
  const place = placeButtons({ ...footer, status, buttons: buttonCells() })
  if (place !== placed) {
    placed = place
    void $.ui.invalidate('ui.render')
  }
  return place
}

// ↩ shows from the start; ▲ ▼ once there is a prompt to jump to.
function buttons($: EngineInterface, Button: ReturnType<EngineInterface['ui']['resolve']>['Button'], surface: string) {
  return [
    <Button key="prompt-send" label=" ↩ " plain onPress={() => send($, surface)} />,
    ...(rows.some(row => row.isPrompt)
      ? [
          <Button key="prompt-up" label=" ▲ " plain onPress={() => jump($, 'up')} />,
          <Button key="prompt-down" label=" ▼ " plain onPress={() => jump($, 'down')} />,
        ]
      : []),
  ]
}

// JUMP_TO_PROMPTS_DEBUG=<file> appends one JSON line per press: what the mod
// thought was on screen and where it went. Off when unset.
const debugLines: string[] = []
async function debug($: EngineInterface, entry: () => unknown) {
  try {
    const file = await $.env.get('JUMP_TO_PROMPTS_DEBUG')
    if (!file) return
    debugLines.push(JSON.stringify(entry()))
    await $.fs.write(file, debugLines.join('\n') + '\n')
  } catch {
    // A debug log that fails must not cancel the press.
  }
}

// Only the terminal's reports count: a phone or desktop attached through
// Remote Control draws the same rows with its own viewport.
function track(surface: string, requestId: string, onScreen: Shown | null | undefined) {
  if (surface !== 'terminal' || onScreen === undefined) return // undefined: the surface does not say
  const key = keyOf(requestId)
  if (onScreen && key === drawn?.key) drawn.resolve()
  if (!onScreen) {
    reports.delete(key)
    // You scrolled the jump's row away. Landing below a prompt takes the prompt
    // row off screen in the jump's own redraw, which must not count.
    const isPinnedRow = key === pinned?.key || key === pinned?.landing
    if (isPinnedRow && Date.now() > pinned!.time + JUMP_SETTLE_MS) pinned = undefined
    return
  }
  // A redraw that shows the same part again is not a move; keep its old time
  // so it cannot pass for the newest burst (see onScreenNow).
  // Same for a row that only grew below the screen (a reply streaming in).
  const old = reports.get(key)
  if (old && old.at.first === onScreen.first && old.at.last === onScreen.last) {
    if (old.at.of !== onScreen.of) reports.set(key, { at: onScreen, time: old.time })
    return
  }
  reports.set(key, { at: onScreen, time: Date.now() })
}

async function redrawAfterRefresh($: EngineInterface) {
  await refresh($)
  await $.ui.invalidate('ui.render')
}

// After a reload of this mod no classic.SessionStart comes, so find the
// transcript by the session's id (the file's name) under the projects folder.
async function findTranscript($: EngineInterface) {
  const id = await $.session.id()
  const home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const found = await $.process.run(['find', `${home}/projects`, '-maxdepth', '2', '-name', `${id}.jsonl`])
  return found.stdout.split('\n')[0] || undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!transcript) follow(await findTranscript($).catch(() => undefined))
    void redrawAfterRefresh($)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SessionStart', async ($, e, next) => {
    follow(e.transcript_path)
    void redrawAfterRefresh($)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.UserPromptSubmit', async ($, e, next) => {
    follow(e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => {
    follow(e.transcript_path)
    void redrawAfterRefresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!isYours(e.props.origin)) skipped.add(keyOf(e.requestId))
    track(e.surface, e.requestId, e.props.onScreen)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    track(e.surface, e.requestId, e.props.onScreen)
    return next(e)
  }).catch(($, e, next) => next(e))
  // Tool calls are drawn under their tool_use id (rowKey of a tool row).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    track(e.surface, e.requestId, e.props.onScreen)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Both footer sites always draw a tree of ours: $.ui.invalidate only redraws
  // instances this mod has drawn, so passing once left a new session without
  // buttons after its first turn (seen live).

  // SessionMode is the footer's mode labels at the right end of the first row
  // under the prompt box. The box's own border (where "ultracode" shows) has no
  // render site, so this is the closest place a mod can draw. Clicks reach it.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const modes = await next(e)
    if (e.surface === 'terminal') {
      footer.columns = e.viewport?.columns
      footer.modes = e.props.modes.join(' & ')
      if ((await placeNow($)) === 'hint') return <Box flexDirection="row">{modes}</Box>
    }
    return (
      <Box flexDirection="row">
        {modes}
        {buttons($, Button, e.surface)}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // PromptHint is the permission-mode line. Wrapping the engine's line leaves
  // it as drawn, and anything beside it drops to a row of its own; a tree
  // without it replaces the line, which the engine still prefixes with the
  // mode label. Its pills are then plain text, and another hook's `tail` is
  // not drawn, so the line is only replaced while the buttons are on it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    footer.columns = e.viewport?.columns
    footer.hint = e.props.hint
    const line = await next(e)
    const columns = e.viewport?.columns
    if ((await placeNow($)) !== 'hint' || columns === undefined) return <Box>{line}</Box>
    return (
      <Box flexDirection="row">
        <Text dimColor wrap="truncate">
          {e.props.hint}
        </Text>
        <Box width={hintGap(columns, e.props.hint, buttonCells())} />
        {buttons($, Button, e.surface)}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
