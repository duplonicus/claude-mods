import { expect, test } from 'claude-code/testing'

import { MOD_NAME, keyOf, landingIds, onScreenNow, parseChunk, pickJump, readChunk, rowOf, whereNow, type Report, type Row, type Shown } from './rows'

// Invented uuids in the transcript's shape.
const id = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`
const prompt = (n: number): Row => ({ id: id(n), isPrompt: true })
const reply = (n: number): Row => ({ id: id(n), isPrompt: false })
// p1 r2 r3 p4 r5 p6 r7
const ROWS = [prompt(1), reply(2), reply(3), prompt(4), reply(5), prompt(6), reply(7)]
const showing = (...entries: [number, Shown][]) => new Map(entries.map(([n, at]) => [keyOf(id(n)), at]))
const whole = { first: 0, last: 3, of: 4 }

test('typed prompts are prompts; tool results, meta rows and engine notices are not rows', () => {
  expect(rowOf({ type: 'user', uuid: 'u1', message: { content: 'fix the bug' } })).toEqual({ id: 'u1', isPrompt: true })
  expect(rowOf({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'see image' }, { type: 'image' }] } })?.isPrompt).toBe(true)
  expect(rowOf({ type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result' }] } })).toBeUndefined()
  expect(rowOf({ type: 'user', uuid: 'u4', isMeta: true, message: { content: 'reminder' } })).toBeUndefined()
  expect(rowOf({ type: 'user', uuid: 'u5', message: { content: '<task-notification>done</task-notification>' } })).toBeUndefined()
  expect(rowOf({ type: 'user', uuid: 'u6', isSidechain: true, message: { content: 'agent prompt' } })).toBeUndefined()
  expect(rowOf({ type: 'user', uuid: 'u7', message: { content: '<command-name>/clear</command-name>' } })?.isPrompt).toBe(true)
})

test("a reply's text blocks and tool calls are rows; thinking is not", () => {
  expect(rowOf({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Done.' }] } })).toEqual({ id: 'a1', isPrompt: false })
  expect(rowOf({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'toolu_1' }] } })).toEqual({ id: 'a2', isPrompt: false, scrollId: 'toolu_1' })
  expect(rowOf({ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'thinking' }] } })).toBeUndefined()
})

test('a half-written last line is left for the next read', () => {
  const full = JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } })
  const chunk = `${full}\nnot json\n{"type":"user","uuid":"u2"`
  const { rows, consumed } = parseChunk(chunk)
  expect(rows.map(row => row.id)).toEqual(['u1'])
  expect(consumed).toBe(full.length + 'not json\n'.length + 1)
})

test('a shortened uuid from the engine matches the full one', () => {
  expect(keyOf('1a2b3c4d-5e6f-4a7b-8c9d-000000000000')).toBe(keyOf('1a2b3c4d-5e6f-4a7b-8c9d-0123456789ab'))
})

test('up from the middle of a reply goes to the prompt that started it', () => {
  expect(pickJump(ROWS, showing([5, whole]), 'up')).toEqual({ id: id(4), block: 'start' })
})

test('up from a prompt already at the top goes to the one before it', () => {
  expect(pickJump(ROWS, showing([4, whole], [5, whole]), 'up')).toEqual({ id: id(1), block: 'start' })
})

test('up from a prompt whose head is scrolled away shows that prompt first', () => {
  expect(pickJump(ROWS, showing([4, { first: 2, last: 6, of: 7 }]), 'up')).toEqual({ id: id(4), block: 'start' })
})

test('up from the first prompt has nowhere to go', () => {
  expect(pickJump(ROWS, showing([1, whole], [2, whole]), 'up')).toBeUndefined()
})

test('down goes to the next prompt, then to the bottom', () => {
  expect(pickJump(ROWS, showing([2, whole]), 'down')).toEqual({ id: id(4), block: 'start' })
  expect(pickJump(ROWS, showing([6, whole]), 'down')).toEqual({ id: id(7), block: 'end' })
  expect(pickJump(ROWS, showing([6, whole], [7, whole]), 'down')).toBeUndefined()
})

test('with no message on screen it falls back to the last jump, else the bottom', () => {
  expect(pickJump(ROWS, new Map(), 'up', 3)).toEqual({ id: id(1), block: 'start' })
  expect(pickJump(ROWS, new Map(), 'down', 3)).toEqual({ id: id(6), block: 'start' })
  expect(pickJump(ROWS, new Map(), 'up')).toEqual({ id: id(6), block: 'start' })
  expect(pickJump(ROWS, new Map(), 'down')).toBeUndefined()
})

// Reports at a given time (ms).
const at = (time: number, ...ns: number[]) => ns.map(n => [keyOf(id(n)), { at: whole, time }] as [string, Report])

test('only the newest burst counts; stale rows a long jump passed over are ignored', () => {
  // r2, r3 reported long ago; p6 and r7 in the newest redraw.
  const reports = new Map<string, Report>([...at(1000, 2, 3), ...at(5000, 6), ...at(5010, 7)])
  expect([...onScreenNow(ROWS, reports).keys()]).toEqual([keyOf(id(6)), keyOf(id(7))])
  expect(pickJump(ROWS, onScreenNow(ROWS, reports), 'up')).toEqual({ id: id(4), block: 'start' })
  expect(onScreenNow(ROWS, new Map()).size).toBe(0)
})

test('after a jump the target is the top, even at the end where it could not reach the top edge', () => {
  // Jumped up to p4 at t=9000 near the end: nothing on screen moved after it.
  const reports = new Map<string, Report>([...at(5000, 5, 6, 7)])
  const shown = whereNow(ROWS, reports, { key: keyOf(id(4)), block: 'start' as const, time: 9000 })
  expect(pickJump(ROWS, shown, 'up')).toEqual({ id: id(1), block: 'start' })
  expect(pickJump(ROWS, shown, 'down')).toEqual({ id: id(6), block: 'start' })
})

test("the jump's own redraw does not release the pin; a later change above it does", () => {
  const pin = { key: keyOf(id(4)), block: 'start' as const, time: 9000 }
  // Rows above p4 redrawn 100 ms after the jump: still the jump's own redraw.
  expect([...whereNow(ROWS, new Map(at(9100, 2, 3)), pin).keys()]).toEqual([keyOf(id(4))])
  // A change a second later: you scrolled, so the newest burst decides.
  expect([...whereNow(ROWS, new Map(at(10000, 2, 3)), pin).keys()]).toEqual([keyOf(id(2)), keyOf(id(3))])
  // A change below the pinned prompt (new output streaming in) keeps it.
  expect([...whereNow(ROWS, new Map(at(10000, 7)), pin).keys()]).toEqual([keyOf(id(4))])
})

test('down at the bottom does nothing, even with the last prompt below the top', () => {
  // r5 at the top, p6 and r7 fully shown: the end, nothing left to scroll to.
  expect(pickJump(ROWS, showing([5, whole], [6, whole], [7, whole]), 'down')).toBeUndefined()
  // r7 only partly shown: p6 is still a real step down.
  expect(pickJump(ROWS, showing([5, whole], [6, whole], [7, { first: 0, last: 2, of: 9 }]), 'down')).toEqual({ id: id(6), block: 'start' })
})

test('after a jump to the end, down stays put and up uses the newest burst for the top', () => {
  // Jumped to the end (r7) at 9000; the redraw at 9050 reported only r5 as the top edge.
  const pin = { key: keyOf(id(7)), block: 'end' as const, time: 9000 }
  const shown = whereNow(ROWS, new Map([...at(9050, 5), ...at(3000, 7)]), pin)
  expect(pickJump(ROWS, shown, 'down')).toBeUndefined()
  expect(pickJump(ROWS, shown, 'up')).toEqual({ id: id(4), block: 'start' })
})

test('a jump to a prompt lands on the row after it first, so the sticky header shows that prompt', () => {
  const tool: Row = { id: id(8), isPrompt: false, scrollId: 'toolu_8' }
  const rows = [prompt(1), tool, prompt(3), prompt(4), reply(5)]
  expect(landingIds(rows, rows[0]!)).toEqual(['toolu_8', id(1)])
  expect(landingIds(rows, rows[2]!)).toEqual([id(4), id(3)]) // back to back: land on the next prompt's row
  expect(landingIds(rows, rows[3]!)).toEqual([id(5), id(4)])
  expect(landingIds(rows, rows[4]!)).toEqual([id(5)]) // an end jump lands on the row itself
})

test('a pin that landed below its prompt lets go when that landing row moves', () => {
  // Jumped to p4, landed on r5 at 9000.
  const pin = { key: keyOf(id(4)), block: 'start' as const, time: 9000, landing: keyOf(id(5)) }
  expect([...whereNow(ROWS, new Map(at(9100, 5)), pin).keys()]).toEqual([keyOf(id(4))]) // the jump's own redraw
  expect([...whereNow(ROWS, new Map(at(10000, 5)), pin).keys()]).toEqual([keyOf(id(5))]) // you scrolled
  // Scrolled a little inside p4's turn: up goes back to p4, not past it.
  expect(pickJump(ROWS, whereNow(ROWS, new Map(at(10000, 5)), pin), 'up')).toEqual({ id: id(4), block: 'start' })
})

test("a tool row's reports match it by its tool_use id", () => {
  const rows: Row[] = [prompt(1), { id: id(2), isPrompt: false, scrollId: 'toolu_01AbCdEfGhIjKlMnOpQrSt' }, prompt(3)]
  const shown = onScreenNow(rows, new Map([[keyOf('toolu_01AbCdEfGhIjKlMnOpQrSt'), { at: whole, time: 5 }]]))
  expect(pickJump(rows, shown, 'up')).toEqual({ id: id(1), block: 'start' })
  expect(pickJump(rows, shown, 'down')).toEqual({ id: id(3), block: 'start' })
})

test('origin decides what you typed: skills you ran count, auto-run skills and interrupt lines do not', () => {
  const user = (content: string, origin?: { kind: string } | null) => rowOf({ type: 'user', uuid: 'u', origin, message: { content } })
  expect(user('<command-message>critique</command-message>\n<command-name>/critique</command-name>', { kind: 'human' })?.isPrompt).toBe(true)
  expect(user('<command-message>workflow-authoring</command-message>', null)).toBeUndefined()
  expect(user('[Request interrupted by user for tool use]')).toBeUndefined()
  expect(user('fix the bug', { kind: 'task-notification' })).toBeUndefined()
  expect(user('<command-name>/effort</command-name>', null)?.isPrompt).toBe(true) // stored without an origin
})

test("a prompt this mod's ↩ sent is yours; another plugin's is not", () => {
  const user = (origin: { kind: string; name?: string }) => rowOf({ type: 'user', uuid: 'u', origin, message: { content: 'fix the bug' } })
  expect(user({ kind: 'plugin', name: MOD_NAME })?.isPrompt).toBe(true)
  expect(user({ kind: 'plugin', name: 'other-mod' })).toBeUndefined()
  expect(user({ kind: 'plugin' })).toBeUndefined()
  const queued = rowOf({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', origin: { kind: 'plugin', name: MOD_NAME } } })
  expect(queued).toEqual({ id: 'q1', isPrompt: true })
})

test('a prompt sent while Claude was working (queued_command) is a prompt, keyed by its own uuid', () => {
  const queued = (kind: string, commandMode?: string) =>
    rowOf({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode, origin: { kind } } })
  expect(queued('human', 'prompt')).toEqual({ id: 'q1', isPrompt: true })
  expect(queued('human')).toEqual({ id: 'q1', isPrompt: true })
  expect(queued('task-notification', 'prompt')).toBeUndefined()
  expect(queued('human', 'bash')).toBeUndefined()
})

test('a line longer than one read is dropped, not a dead stop', () => {
  const line = (n: number) => JSON.stringify({ type: 'user', uuid: `u${n}`, origin: { kind: 'human' }, message: { content: 'hi' } })
  // The read holds only the start of a huge line.
  let read = readChunk('{"type":"user","message":{"content":"' + 'x'.repeat(50), false, true)
  expect(read).toEqual({ rows: [], used: read.used, dropping: true, more: true })
  expect(read.used.length).toBe(87)
  // The next read is still inside it.
  read = readChunk('x'.repeat(40), true, true)
  expect(read.dropping).toBe(true)
  // Then its end, and a normal line after it.
  read = readChunk(`xx"}}\n${line(2)}\n`, true, false)
  expect(read.rows.map(row => row.id)).toEqual(['u2'])
  expect(read.dropping).toBe(false)
  expect(read.more).toBe(false)
})

test('down from the last prompt with its reply running off the screen goes to the bottom', () => {
  const rows = [prompt(1), reply(2)]
  expect(pickJump(rows, showing([1, whole], [2, { first: 0, last: 30, of: 200 }]), 'down')).toEqual({ id: id(2), block: 'end' })
})

test('only rows set the newest time: a report from a skipped row does not hide the edges', () => {
  const reports = new Map<string, Report>([...at(5000, 4, 5), [keyOf('99999999-zzzz-4zzz-8zzz-000000000099'), { at: whole, time: 9000 }]])
  expect([...onScreenNow(ROWS, reports).keys()]).toEqual([keyOf(id(4)), keyOf(id(5))])
})
