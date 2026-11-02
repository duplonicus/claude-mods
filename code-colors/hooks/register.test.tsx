import { expect, test, type TestBody } from 'claude-code/testing'
import { readNewFile, shownPath } from './diff'
import { MAX_READ_BYTES, readSpans } from './register'
import { bashRow } from './shell'

// Each test's own `ui.render` hook stands for the engine beneath the mod.
const engine = (on: Parameters<TestBody>[1]) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

const PLUGIN = 'code-colors'

const bash = (id: string, command: string) => ({
  plugin: PLUGIN,
  component: 'ToolUse',
  requestId: id,
  surface: 'terminal',
  props: {
    tool_use_id: id, tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: true,
    output: { stdout: 'x = 1', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
  },
} as const)

const result = (id: string, tool: string, output: unknown) =>
  ({ plugin: PLUGIN, component: 'ToolResult', requestId: id, surface: 'terminal', props: { tool_use_id: id, tool, output, isErrored: false, isExpanded: true } }) as const

const EDIT_OUTPUT = {
  filePath: '/r/server.ts', oldString: '3000', newString: '8080', originalFile: '', replaceAll: false, userModified: false,
  structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-  return 3000', '+  return 8080'] }],
}

test('a Bash row drawn whole leaves its ToolResult empty, so ctrl+o shows the output once', async ($, on) => {
  engine(on)
  const row = await $.ui.mount(bash('toolu_a', 'cat a.py'))
  expect((await row.find({ type: 'Text', text: /^Bash/ }))?.text).toBe('Bash(cat a.py)')
  // A blank line above, as the engine's own row has.
  expect(((await row.drawn()) as { props: { marginTop?: number } }).props.marginTop).toBe(1)
  await row.unmount()
  const below = await $.ui.mount(result('toolu_a', 'Bash', bash('toolu_a', 'cat a.py').props.output))
  expect(await below.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  await below.unmount()
})

const withStdout = (id: string, command: string, stdout: string) => {
  const row = bash(id, command)
  return { ...row, props: { ...row.props, output: { ...row.props.output, stdout } } }
}

test("a chain's output is colored: grep lines in their file's language, the rest as output", async ($, on) => {
  engine(on)
  const stdout = '--- now\npackage:com.google.android.tts\n12:def x():\nnothing to see here'
  const row = await $.ui.mount(withStdout('toolu_g', 'echo "--- now"; pm list; grep -n x a.py | cut -c1-90', stdout))
  expect((await row.find({ type: 'Text', text: /^package$/ }))?.props).toMatchObject({ color: '#3EE0B4' })
  expect((await row.find({ type: 'Text', text: /^com\.google\.android\.tts$/ }))?.props).toMatchObject({ color: '#68FDFA' })
  expect((await row.find({ type: 'Text', text: /^def$/ }))?.props).toMatchObject({ color: '#FFB454' })
  expect((await row.find({ type: 'Text', text: /^12:$/ }))?.props).toMatchObject({ color: 'inactive' })
  expect(await row.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  await row.unmount()
})

test("a chain's printed file is still found, leaving the output around it as spans to color", async () => {
  const reader = { fs: { read: async () => 'x = 1\n', stat: async () => ({ size: 6 }) }, env: { get: async () => '/home/u' } }
  const spans = await readSpans(reader, 'toolu_h', 'pm list; cat /r/a.py', 'package:com.x\nx = 1\nerror: y')
  expect(spans).toEqual([{ text: 'package:com.x' }, { lang: 'python', text: 'x = 1' }, { text: 'error: y' }])
})

test("an errored row stays the error's color, whole", async ($, on) => {
  engine(on)
  const failed = bash('toolu_i', 'pm list')
  const row = await $.ui.mount({ ...failed, props: { ...failed.props, isErrored: true, output: 'Error: Exit code 1\ncom.x error' } })
  expect((await row.find({ type: 'Text', text: /com\.x error/ }))?.props).toMatchObject({ color: 'error' })
  await row.unmount()
})

const created = (filePath: string, content: string) => ({ type: 'create', filePath, content, structuredPatch: [], originalFile: null, userModified: false })
const writeResult = (id: string, output: unknown, isExpanded: boolean) => {
  const row = result(id, 'Write', output)
  return { ...row, props: { ...row.props, isExpanded } }
}

test('a new file drawn in full is in the palette, numbered, with the engine\'s header', async ($, on) => {
  engine(on)
  const row = await $.ui.mount(writeResult('toolu_w', created('/r/a.py', 'def f():\n    return "x"\n'), true))
  expect(await row.find({ type: 'Text', text: /^Wrote 2 lines to/ })).toBeDefined()
  expect((await row.find({ type: 'Text', text: /^\/r\/a\.py$/ }))?.props).toMatchObject({ bold: true })
  expect((await row.find({ type: 'Link' }))?.props).toMatchObject({ href: 'file:///r/a.py' })
  expect((await row.find({ type: 'Text', text: /^def$/ }))?.props).toMatchObject({ color: '#FFB454' })
  expect((await row.find({ type: 'Text', text: /^"x"$/ }))?.props).toMatchObject({ color: '#E5484D' })
  expect((await row.find({ type: 'Text', text: /^1 $/ }))?.props).toMatchObject({ color: 'inactive' })
  expect((await row.find({ type: 'Text', text: /^2 $/ }))).toBeDefined()
  expect(await row.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  await row.unmount()
})

test('regular mode shows the first 10 lines and how many more, as the engine does', async ($, on) => {
  engine(on)
  const content = Array.from({ length: 25 }, (_, i) => `v${i + 1} = ${i + 1}`).join('\n') + '\n'
  const row = await $.ui.mount(writeResult('toolu_x', created('/r/b.py', content), false))
  expect(await row.find({ type: 'Text', text: /^Wrote 25 lines to/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /^10 $/ })).toBeDefined()
  expect(await row.find({ type: 'Text', text: /^11 $/ })).toBeUndefined()
  expect((await row.find({ type: 'Text', text: /^… \+15 lines$/ }))?.props).toMatchObject({ color: 'inactive' })
  await row.unmount()
  const all = await $.ui.mount(writeResult('toolu_y', created('/r/b.py', content), true))
  expect(await all.find({ type: 'Text', text: /^25 $/ })).toBeDefined()
  expect(await all.find({ type: 'Text', text: /\+15 lines/ })).toBeUndefined()
  await all.unmount()
})

test('a new file of no known language is drawn as output; one line says line', async ($, on) => {
  engine(on)
  const row = await $.ui.mount(writeResult('toolu_z', created('/r/notes.txt', 'error: see /a/b.py\n'), true))
  expect(await row.find({ type: 'Text', text: /^Wrote 1 line to/ })).toBeDefined()
  expect((await row.find({ type: 'Text', text: /^error$/ }))?.props).toMatchObject({ color: '#E5484D' })
  await row.unmount()
})

test("an empty new file, an unchanged overwrite, an errored Write and a language we have no lexer for stay the engine's", async ($, on) => {
  engine(on)
  for (const output of [created('/r/e.py', ''), { ...created('/r/e.py', 'x\n'), type: 'update' }, created('/r/main.go', 'func main() {}\n'), created('/r/Dockerfile', 'FROM x\n')]) {
    const row = await $.ui.mount(writeResult('toolu_e1', output, true))
    expect(await row.find({ type: 'Text', text: /engine/ })).toBeDefined()
    await row.unmount()
  }
  const failed = writeResult('toolu_e2', created('/r/e.py', 'x\n'), true)
  const row = await $.ui.mount({ ...failed, props: { ...failed.props, isErrored: true } })
  expect(await row.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await row.unmount()
})

test('an Edit to a file of no known language is in the palette too', async ($, on) => {
  engine(on)
  const output = { ...EDIT_OUTPUT, filePath: '/r/notes.txt', structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-ok', '+error'] }] }
  const row = await $.ui.mount(result('toolu_ed', 'Edit', output))
  expect((await row.find({ type: 'Text', text: /^error$/ }))?.props).toMatchObject({ color: '#E5484D' })
  await row.unmount()
  const go = await $.ui.mount(result('toolu_eg', 'Edit', { ...output, filePath: '/r/main.go' }))
  expect(await go.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await go.unmount()
})

test('a CRLF file has no stray returns and a very long line stays plain', () => {
  expect(readNewFile(created('/r/a.py', 'a = 1\r\nb = 2\r\n'), true)?.total).toBe(2)
  expect(readNewFile(created('/r/a.py', 'a = 1\r\nb = 2\r\n'), true)?.rows[0]?.tokens.map(token => token.text).join('')).toBe('a = 1')
  const long = `x = ${'1'.repeat(3000)}`
  expect(readNewFile(created('/r/a.py', `${long}\n`), true)?.rows[0]?.tokens).toEqual([{ kind: 'plain', text: long }])
  const many = Array.from({ length: 302 }, (_, i) => `v${i} = 1`).join('\n')
  const rows = readNewFile(created('/r/a.py', many), true)?.rows
  expect(rows?.length).toBe(302)
  expect(rows?.[299]?.tokens.length).toBeGreaterThan(1)
  expect(rows?.[300]?.tokens).toEqual([{ kind: 'plain', text: 'v300 = 1' }])
  for (const bad of [undefined, null, 'x', { type: 'create', filePath: 3, content: 'x' }, { type: 'create', filePath: '/a', content: 3 }]) expect(readNewFile(bad, true)).toBeUndefined()
})

const group = (id: string) =>
  ({ plugin: PLUGIN, component: 'ToolGroup', requestId: `group-${id}`, surface: 'terminal', props: { calls: [{ tool_use_id: id, tool: 'Write', input: {} }], isActive: false, isExpanded: true } }) as never

const grouped = (id: string, output: unknown) =>
  ({
    plugin: PLUGIN, component: 'ToolUse', requestId: id, surface: 'terminal',
    props: { tool_use_id: id, tool: 'Write', input: { file_path: '/r/a.py' }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: true, output },
  }) as const

test("a new file in a group (a session's own scratchpad) is drawn whole, in the palette, once", async ($, on) => {
  engine(on)
  const parent = await $.ui.mount(group('toolu_g1'))
  await parent.unmount()
  const row = await $.ui.mount(grouped('toolu_g1', created('/r/a.py', 'class A:\n    x = 1\n')))
  expect(await row.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  expect((await row.find({ type: 'Text', text: /^Write$/ }))?.props).toMatchObject({ bold: true })
  expect((await row.find({ type: 'Link' }))?.props).toMatchObject({ href: 'file:///r/a.py' })
  expect((await row.find({ type: 'Text', text: /^● $/ }))?.props).toMatchObject({ color: 'success' })
  expect(await row.find({ type: 'Text', text: /^Wrote 2 lines to/ })).toBeDefined()
  expect((await row.find({ type: 'Text', text: /^class$/ }))?.props).toMatchObject({ color: '#FFB454' })
  expect(((await row.drawn()) as { props: { marginTop?: number } }).props.marginTop).toBe(1)
  await row.unmount()
  // ctrl+o draws a ToolResult for the same call: it stays empty, not a second copy.
  const below = await $.ui.mount(writeResult('toolu_g1', created('/r/a.py', 'class A:\n    x = 1\n'), true))
  expect(await below.find({ type: 'Text', text: /Wrote/ })).toBeUndefined()
  await below.unmount()
})

test("a grouped Write still running, of a language we have no lexer for, or to a plan file stays the engine's", async ($, on) => {
  engine(on)
  const parent = await $.ui.mount(group('toolu_g2'))
  await parent.unmount()
  for (const output of [undefined, created('/r/main.go', 'x\n'), created('/h/.claude/plans/a.md', '# x\n')]) {
    const row = await $.ui.mount(grouped('toolu_g2', output))
    expect(await row.find({ type: 'Text', text: /engine/ })).toBeDefined()
    await row.unmount()
  }
})

test('a path with a space, # or ? still links to the whole path', async ($, on) => {
  engine(on)
  const row = await $.ui.mount(writeResult('toolu_l', created('/r/my notes#1/what?.py', 'x = 1\n'), true))
  expect((await row.find({ type: 'Link' }))?.props).toMatchObject({ href: 'file:///r/my%20notes%231/what%3F.py' })
  await row.unmount()
})

test('a plan file stays the engine\'s; regular mode shows a path under the session\'s folder as relative', async ($, on) => {
  engine(on)
  const plan = await $.ui.mount(writeResult('toolu_p', created('/home/u/.claude/plans/quiet-otter.md', '# Plan\n'), false))
  expect(await plan.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await plan.unmount()
  expect(shownPath('/r/sub/a.py', '/r', false)).toBe('sub/a.py')
  expect(shownPath('/r/sub/a.py', '/r', true)).toBe('/r/sub/a.py')
  expect(shownPath('/rx/a.py', '/r', false)).toBe('/rx/a.py')
  expect(shownPath('/other/a.py', '/r', false)).toBe('/other/a.py')
  expect(shownPath('/r/a.py', undefined, false)).toBe('/r/a.py')
})

test('a command edit to a text file is in the output colors too', () => {
  const edit = { files: [{ filePath: '/r/notes.txt', hunks: [{ oldStart: 1, newStart: 1, lines: ['-ok', '+error'] }] }] }
  const row = bashRow({ input: { command: 'sed -i s/ok/error/ notes.txt' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: '', stderr: '', bashEditDiff: edit } })
  const added = row?.edits[0]?.rows.find(entry => entry.kind === 'add')
  expect(added && 'tokens' in added ? added.tokens[0]?.kind : undefined).toBe('string')
})

test("a Bash row the mod leaves keeps the engine's ToolResult", async ($, on) => {
  engine(on)
  const running = bash('toolu_b', 'sleep 9')
  const backgrounded = { ...running.props.output, backgroundTaskId: 'b1' }
  const row = await $.ui.mount({ ...running, props: { ...running.props, output: backgrounded } })
  expect((await row.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await row.unmount()
  const below = await $.ui.mount(result('toolu_b', 'Bash', backgrounded))
  expect((await below.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await below.unmount()
})

test('a running Bash row is its header alone, turning and shimmering like the spinner', async ($, on) => {
  engine(on)
  const running = bash('toolu_d', 'for i in 1 2 3; do sleep 1; done')
  const row = await $.ui.mount({ ...running, props: { ...running.props, isRunning: true, output: undefined } })
  const header = { in: 'running-toolu_d' }
  expect((await row.find({ type: 'Text', text: /^Bash/, ...header }))?.text).toBe('Bash(for i in 1 2 3; do sleep 1; done)')
  expect(await row.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: '·', ...header })).toBeDefined()
  await row.advance(1000)
  expect(await row.find({ type: 'Text', text: '✽', ...header })).toBeDefined()
  expect(await row.find({ type: 'Text', text: '·', ...header })).toBeUndefined()
  await row.unmount()
})

test('a finished Bash row is still: no running header, its bullet green', async ($, on) => {
  engine(on)
  const row = await $.ui.mount(bash('toolu_e', 'cat a.py'))
  expect(await row.find({ type: 'Client' })).toBeUndefined()
  expect((await row.find({ type: 'Text', text: '● ' }))?.text).toBe('● ')
  await row.unmount()
})

test('a standalone Edit keeps the engine header and draws its diff once, in the ToolResult', async ($, on) => {
  engine(on)
  const props = { tool_use_id: 'toolu_c', tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false, isExpanded: true, output: EDIT_OUTPUT }
  const row = await $.ui.mount({ plugin: PLUGIN, component: 'ToolUse', requestId: 'toolu_c', surface: 'terminal', props })
  expect(await row.find({ type: 'Text', text: /Added|Removed/ })).toBeUndefined()
  await row.unmount()
  const below = await $.ui.mount(result('toolu_c', 'Edit', EDIT_OUTPUT))
  expect(await below.find({ type: 'Text', text: /engine/ })).toBeUndefined()
  expect((await below.find({ type: 'Text', text: /^Added/ }))?.text).toBe('Added 1 line, removed 1 line')
  await below.unmount()
})

const reply = (id: string, text: string, isFirstOfReply = true) =>
  ({ plugin: PLUGIN, component: 'AssistantMessage', requestId: id, surface: 'terminal', props: { text, isFirstOfReply } }) as const

test('reply prose is ours: the bullet, a colored label, bold in orange, inline code in pink; a table stays the engine\'s', async ($, on) => {
  engine(on)
  const view = await $.ui.mount(reply('m1', '**TL;DR** — run `npm test` **now**.\n\n---\n\n- one\n\n| a | b |\n| - | - |'))
  expect((await view.find({ type: 'Text', text: /^● $/ }))?.text).toBe('● ')
  const label = await view.find({ type: 'Text', text: /^TL;DR$/ })
  expect(label?.props).toMatchObject({ color: '#26A269', bold: true })
  expect((await view.find({ type: 'Text', text: /^npm test$/ }))?.props).toMatchObject({ color: '#FF7A95' })
  expect((await view.find({ type: 'Text', text: /^now$/ }))?.props).toMatchObject({ color: '#FFB454', bold: true })
  expect((await view.find({ type: 'Text', text: /^─+$/ }))?.props).toMatchObject({ color: 'inactive' })
  expect((await view.find({ type: 'Text', text: /^• $/ }))?.text).toBe('• ')
  expect((await view.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await view.unmount()
})

test('a later message of the reply has no bullet; a summary keeps the engine\'s prose', async ($, on) => {
  engine(on)
  const later = await $.ui.mount(reply('m2', 'More text.', false))
  expect(await later.find({ type: 'Text', text: /^● $/ })).toBeUndefined()
  await later.unmount()
  const summary = await $.ui.mount({ ...reply('m3', 'Summary `x`'), props: { text: 'Summary `x`', isFirstOfReply: true, isSummary: true } })
  expect((await summary.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await summary.unmount()
})

const spinner = (mode: 'requesting' | 'responding' | 'thinking' | 'tool-input' | 'tool-use', message: string | null = null) =>
  ({ plugin: PLUGIN, component: 'Spinner', requestId: 'main', surface: 'terminal', props: { word: 'Frolicking', message, suffix: '…', mode } }) as const

test("while Claude thinks, a rainbow of the spinner's word is laid over the engine's line, which stays", async ($, on) => {
  engine(on)
  const line = await $.ui.mount(spinner('thinking'))
  expect((await line.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect((await line.find({ type: 'Text', text: 'Frolicking', in: 'thinking-rainbow' }))?.text).toBe('Frolicking')
  await line.advance(500)
  expect((await line.find({ type: 'Text', text: 'Frolicking', in: 'thinking-rainbow' }))?.text).toBe('Frolicking')
  await line.unmount()
})

test('any other spinner, or one showing a message, is the engine\'s alone', async ($, on) => {
  engine(on)
  for (const props of [spinner('responding'), spinner('tool-use'), spinner('thinking', 'Compacting')]) {
    const line = await $.ui.mount(props)
    expect(await line.find({ type: 'Client' })).toBeUndefined()
    await line.unmount()
  }
})

test('a printed file over the size limit is never read: its row stays plain', async () => {
  const reads: string[] = []
  const reader = (size: number) => ({
    fs: {
      read: async (path: string) => (reads.push(path), 'x = 1\ny = 2\n'),
      stat: async () => ({ size }),
    },
    env: { get: async () => '/home/u' },
  })
  const command = 'tail -n 1 ~/big.py; wc -l ~/big.py'
  expect(await readSpans(reader(MAX_READ_BYTES + 1), 'toolu_big', command, 'y = 2\n1 /home/u/big.py')).toBeUndefined()
  expect(reads).toEqual([])
  expect(await readSpans(reader(100), 'toolu_small', command, 'y = 2\n1 /home/u/big.py')).toBeDefined()
  expect(reads).toEqual(['/home/u/big.py'])
})
