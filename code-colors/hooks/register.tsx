import type { ElementTable, Register, RenderElement, RenderNode } from 'claude-code'

import { CHANGED_WORD_TINT, DIFF_TINT, diffRows, readNewFile, readPatch, shownPath, summarize, type DiffRow, type NewFile } from './diff'
import { DEFAULT_PALETTE, PALETTE, PALETTES, splitFences, tokenize, toLines, type Lang, type PaletteName, type Token } from './highlight'
import { fileLang } from './languages'
import { LABEL_COLORS, leadLabel, luminance, PROSE, proseBlocks, type Inline, type ProseBlock, type Row } from './prose'
import { fetchSpans } from './fetch'
import { mcpBlocks } from './mcp'
import type { Part } from './running'
import { glyphs } from './spinner'
import { ThoughtMeter } from './thinking'
import { bashRow, commandTokens, filePrints, outputLines, printedText, printSpans, type BashOutput, type FileEdit, type GrepLine, type OutputSpan } from './shell'

/**
 * code-colors: draws code in Claude's replies and in Edit/Write diffs with our
 * own palette (anthropics/claude-code#48636): "Ubuntu Readable" by default,
 * or the palette named after a fence's language (```ts modern). Languages are in
 * languages.ts (SQL, TS/JS/JSX, Python, Rust, Terraform/HCL).
 *
 * Replies: code blocks are ours, and so is plain prose (paragraphs, lists,
 * headings, rules, with bold, italic, inline code and links; prose.ts). What
 * prose.ts leaves (tables, quotes, HTML, other fences) and a summary's prose
 * are drawn by the engine through `next`.
 * Diffs: the Edit/Write diff and its summary line are ours, on delta's faint
 * diff backgrounds, changed words on a slightly stronger tint.
 * Bash rows: the command (heredoc bodies in their own language), its output
 * (printed files and greps in their language, in a chain too, anything else as
 * output: shell.ts `outputLines`), the engine's cwd note, and
 * the diff of files it changed, drawn as the Edit diffs are. Only rows drawn in
 * full (verbose or ctrl+o) are ours, a running one turning and shimmering like
 * the spinner (running.tsx); a backgrounded or git row stays the engine's.
 * Thinking: while the spinner says Claude is thinking, its word is a rainbow
 * flowing at the speed the thinking streams in (rainbow.tsx, thinking.ts).
 * Render-only: nothing stored is changed.
 */

const CODE_INDENT = 2 // lines up with the prose after the reply bullet
// The engine's reply bullet, in the theme's text color (seen in a capture).
const REPLY_BULLET = '● '

// A rule is drawn this long and cut at the edge.
const RULE_WIDTH = 400
const MAX_ITEM_INDENT = 8
// Below this a hex code's own color is too dark to read on the default purple (#300A24 is 0.007).
const MIN_HEX_LUMINANCE = 0.06

// Calls drawn inside a ToolGroup, by tool_use_id. Such a row draws its result
// inline; a call outside any group draws it in a ToolResult of its own after
// the row (Edit rows, seen with a probe), so redrawing it in the ToolUse too
// would draw it twice. The group is raised before its rows (seen every time).
const grouped = new Set<string>()
// Bash calls whose row this mod drew whole, output included. The ctrl+o view
// folds nothing, so there the same row also gets a ToolResult: that one is
// left empty rather than drawing the output twice (seen in ctrl+o).
const bashDrawnWhole = new Set<string>()
// The same for a new file's Write row drawn whole in a group.
const newFileDrawnWhole = new Set<string>()
// The same for a grouped Edit diff or MCP result drawn inline under the engine's header.
const resultDrawnInline = new Set<string>()
// A mixed command's output cut into its printed files' spans, by tool_use_id
// (null: none found). Read once, so a file changed later doesn't uncolor the row.
const mixedSpans = new Map<string, OutputSpan[] | null>()
const MIXED_SPANS_KEPT = 500
// A printed file bigger than this is left plain, unread: reading and splitting
// a large transcript or dump on the render path would stall the redraw, and
// MAX_COLORED_LINES only cuts after the read.
export const MAX_READ_BYTES = 2_000_000

type SpanReader = {
  fs: { read: (path: string) => Promise<string>; stat: (path: string) => Promise<{ size: number }> }
  env: { get: (name: string) => Promise<string | undefined> }
}

/** The spans of a mixed command's output, reading each printed file once per row. */
export async function readSpans($: SpanReader, id: string, command: string, stdout: string) {
  const known = mixedSpans.get(id)
  if (known !== undefined) return known ?? undefined
  const prints = filePrints(command)
  if (!prints.length) return undefined
  const home = (await $.env.get('HOME')) ?? ''
  const resolve = (path: string) => (path === '~' || path.startsWith('~/') ? home + path.slice(1) : path)
  const texts = await Promise.all(
    prints.map(async ({ path, dir, lang, picks }) => {
      const full = path.startsWith('/') || path.startsWith('~') || !dir ? resolve(path) : `${resolve(dir)}/${path}`
      const stat = await $.fs.stat(full).catch(() => undefined) // follows a link: its target's size
      const file = stat && stat.size > MAX_READ_BYTES ? undefined : await $.fs.read(full).catch(() => undefined)
      return { lang, text: typeof file === 'string' ? printedText(file, picks) : '' }
    }),
  )
  const spans = printSpans(stdout, texts)
  if (mixedSpans.size >= MIXED_SPANS_KEPT) mixedSpans.clear()
  mixedSpans.set(id, spans ?? null)
  return spans
}

// How fast thinking streams in, per agent; the session's own is MAIN_AGENT.
const thoughts = new ThoughtMeter()
const MAIN_AGENT = 'main'
// The word each spinner drew last, by the spinner's requestId: a rainbow's poll is answered with it.
const spinnerWords = new Map<string, string>()
const RAINBOW_KEY = 'thinking-rainbow'
// A spinner is drawn under its agent's id; one with no thinking of its own counted is the session's.
const agentOf = (requestId: string) => (thoughts.has(requestId) ? requestId : MAIN_AGENT)

// CODE_COLORS_DEBUG=<file> appends one JSON line per Edit, Write or MCP row drawn: which hook saw it and what it held. Off when unset.
const debugLines: string[] = []
async function debug($: { env: { get: (name: string) => Promise<string | undefined> }; fs: { write: (path: string, text: string) => Promise<void> } }, entry: () => unknown) {
  try {
    const file = await $.env.get('CODE_COLORS_DEBUG')
    if (!file) return
    debugLines.push(JSON.stringify(entry()))
    await $.fs.write(file, debugLines.join('\n') + '\n')
  } catch {
    // A debug log that fails must not cancel the row.
  }
}

/** What a result held, without its text. */
const outputShape = (output: unknown) =>
  typeof output === 'object' && output !== null ? Object.entries(output).map(([key, value]) => `${key}:${key === 'type' ? String(value) : Array.isArray(value) ? `array(${value.length})` : typeof value}`) : typeof output

export const register: Register = on => {
  // The model's response as it streams: thinking is measured and every chunk
  // passed on untouched, so nothing shown or recorded changes.
  on('turn.step', async function* ($, e, next) {
    const agent = e.agentId ?? MAIN_AGENT
    for await (const chunk of next(e)) {
      if (chunk.kind === 'thinking') thoughts.add(agent, chunk.text.length, Date.now())
      yield chunk
    }
  })

  // While Claude thinks, the spinner's word is a rainbow flowing at the
  // thinking's speed (rainbow.tsx), laid over the engine's word: the engine
  // keeps its glyph, ellipsis, timer and token count, which no prop carries.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.mode !== 'thinking' || e.props.message !== null) return next(e)
    const { Box, Client } = $.ui.resolve(e)
    const line = await next(e)
    spinnerWords.set(e.requestId, e.props.word)
    return (
      <Box flexDirection="column">
        {line}
        <Box position="absolute" top={1} left={2}>
          <Client key={RAINBOW_KEY} module="./rainbow.tsx" props={{ word: e.props.word, rate: thoughts.rate(agentOf(e.requestId), Date.now()) }} />
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // A rainbow's tick asks for the current thinking speed.
  on('ui.message', async ($, e, next) => {
    if (e.element !== RAINBOW_KEY) return next(e)
    const word = spinnerWords.get(e.requestId)
    if (word === undefined) return next(e)
    return { props: { word, rate: thoughts.rate(agentOf(e.requestId), Date.now()) } }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const segments = splitFences(e.props.text)
    // A summary keeps the engine's prose; code in it is still ours.
    const drawsProse = !e.props.isSummary
    if (!drawsProse && !segments.some(segment => segment.kind === 'code')) return next(e)

    const { Box, Text, Link } = $.ui.resolve(e)
    const codeBlock = (source: string, lang: Lang, paletteName: PaletteName) => (
      <Box flexDirection="column">
        {toLines(source, lang).map(tokens => (
          <Text>
            {tokens.length === 0
              ? ' '
              : tokens.map(({ kind, text }) => {
                  const color = PALETTES[paletteName][kind]
                  return color ? <Text color={color}>{text}</Text> : text
                })}
          </Text>
        ))}
      </Box>
    )
    const inline = (runs: readonly Inline[]) => {
      const label = leadLabel(runs)
      return runs.map((run, i) => {
        const labelColor = i === 0 && label ? LABEL_COLORS[label] : undefined
        // A hex code in its own color; one too dark to read on the background is a swatch behind the text.
        const dark = run.hex !== undefined && luminance(run.hex) < MIN_HEX_LUMINANCE
        const color = run.hex && !dark ? run.hex : run.code ? PROSE.code : run.href ? PROSE.link : (labelColor ?? (run.bold ? PROSE.bold : undefined))
        const styled = color || dark || run.bold || run.italic || run.strike
        const text = styled ? (
          <Text {...(color ? { color } : {})} {...(dark ? { backgroundColor: run.hex, color: 'text' } : {})} {...(run.bold ? { bold: true } : {})} {...(run.italic ? { italic: true } : {})} {...(run.strike ? { strikethrough: true } : {})}>
            {run.text}
          </Text>
        ) : (
          run.text
        )
        return run.href ? <Link href={run.href}>{text}</Link> : text
      })
    }
    const row = (r: Row) => {
      switch (r.kind) {
        case 'rule':
          // Wrapped and clipped to its first line: cut at the edge with no `…`.
          return (
            <Box height={1} overflow="hidden">
              <Text color={PROSE.rule}>{'─'.repeat(RULE_WIDTH)}</Text>
            </Box>
          )
        case 'heading':
          return <Text bold color={PROSE.heading}>{inline(r.inline)}</Text>
        case 'para':
          return <Text>{inline(r.inline)}</Text>
        case 'item':
          return (
            <Box flexDirection="row" paddingLeft={Math.min(r.indent, MAX_ITEM_INDENT)}>
              <Text color={PROSE.marker}>{r.ordered ? `${r.marker} ` : '• '}</Text>
              <Box flexShrink={1}>
                <Text>{inline(r.inline)}</Text>
              </Box>
            </Box>
          )
      }
    }
    // Ours are drawn beside the reply bullet (first) or under its text, as the engine lays out prose,
    // each a line below what is above it: the engine's own blocks carry that margin themselves
    // (seen in a probe: a rowGap drew two blank lines above an engine table).
    const placed = (node: RenderNode, isFirst: boolean) =>
      isFirst ? (
        <Box flexDirection="row" marginTop={1}>
          <Text color="text">{REPLY_BULLET}</Text>
          <Box flexDirection="column" flexShrink={1}>
            {node}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={CODE_INDENT} marginTop={1}>
          {node}
        </Box>
      )

    const children: RenderNode[] = []
    for (const segment of segments) {
      const isFirst = e.props.isFirstOfReply && children.length === 0
      if (segment.kind === 'code') {
        children.push(placed(codeBlock(segment.source, segment.lang, segment.palette ?? DEFAULT_PALETTE), isFirst))
        continue
      }
      const text = segment.text.trim()
      if (!text) continue
      const blocks: ProseBlock[] = drawsProse ? proseBlocks(text) : [{ kind: 'engine', text }]
      for (const block of blocks) {
        const isFirstOfReply = e.props.isFirstOfReply && children.length === 0
        if (block.kind === 'engine') children.push(await next({ ...e, props: { ...e.props, text: block.text, isFirstOfReply } }))
        else children.push(placed(<Box flexDirection="column">{block.rows.map(row)}</Box>, isFirstOfReply))
      }
    }
    return <Box flexDirection="column">{children}</Box>
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    for (const call of e.props.calls) if (call.tool_use_id) grouped.add(call.tool_use_id) // absent on an older desktop host
    return next(e)
  }).catch(($, e, next) => next(e))

  // A Bash row in full is drawn whole here: header and output, as a grouped row
  // draws it (every Bash row seen in the main view was grouped).
  on('ui.render', { component: 'ToolUse', props: { tool: 'Bash' } }, async ($, e, next) => {
    const row = e.surface === 'terminal' && e.props.isExpanded === true ? bashRow(e.props) : undefined
    if (!row || e.surface !== 'terminal') {
      bashDrawnWhole.delete(e.props.tool_use_id)
      return next(e)
    }
    // A running row has no result yet; its ToolResult (ctrl+o) comes once it is done.
    if (row.bullet === 'running') bashDrawnWhole.delete(e.props.tool_use_id)
    else bashDrawnWhole.add(e.props.tool_use_id)
    if (row.bullet === 'success' && row.output && !row.output.lang && !row.output.color) {
      const command = (e.props.input as { command: string }).command
      const spans = await readSpans($, e.props.tool_use_id, command, row.output.colored)
      if (spans) row.output = { ...row.output, spans }
    }

    const { Box, Text, Client } = $.ui.resolve(e)
    const colored = (tokens: readonly Token[]) => coloredTokens(Text, tokens)
    // A running row turns and shimmers like the spinner (running.tsx); a done
    // one is still, its bullet green or red.
    const header =
      row.bullet === 'running' ? (
        <Client
          key={`running-${e.props.tool_use_id}`}
          module="./running.tsx"
          props={{ glyphs: glyphs(await $.env.get('TERM').catch(() => undefined)), name: 'Bash', parts: row.command.flatMap(commandParts) }}
        />
      ) : (
        <Box flexDirection="row">
          <Text color={row.bullet}>{BULLET}</Text>
          <Box flexDirection="column" flexShrink={1}>
            <Text>
              <Text bold>Bash</Text>(
              {row.command.flatMap(part => (part.lang ? colored(commandTokens(part.text, part.lang)) : [part.text]))})
            </Text>
          </Box>
        </Box>
      )
    const drawnLines = (lines: readonly GrepLine[]) =>
      lines.map(line => (
        <Text>
          {line.prefix ? <Text color={RESULT_GUTTER_COLOR}>{line.prefix}</Text> : ''}
          {line.lang && line.text ? coloredTokens(Text, tokenize(line.text, line.lang)) : line.text || (line.prefix ? '' : ' ')}
        </Text>
      ))
    const position = { section: 0 }
    const output = (out: BashOutput) =>
      out.grep
        ? drawnLines(out.grep)
        : out.spans
        ? out.spans.flatMap(span => (span.lang ? spanLines(Text, [span]) : drawnLines(outputLines((e.props.input as { command: string }).command, span.text, position))))
        : out.lines
        ? drawnLines(out.lines)
        : out.lang
        ? [
            ...toLines(out.colored, out.lang).map(tokens => <Text>{tokens.length === 0 ? ' ' : colored(tokens)}</Text>),
            ...(out.rest ? [<Text>{out.rest}</Text>] : []),
          ]
        : [<Text {...(out.color ? { color: out.color } : {})}>{out.colored}</Text>]
    // One `⎿` block: the gutter, then its lines wrapping beside it.
    const block = (key: string, children: RenderNode[]) => (
      <Box key={key} flexDirection="row">
        <Text color={RESULT_GUTTER_COLOR}>{RESULT_GUTTER}</Text>
        <Box flexDirection="column" flexShrink={1}>
          {children}
        </Box>
      </Box>
    )
    const edit = (file: FileEdit, i: number) => (
      <Box key={`edit-${i}`} flexDirection="column">
        {block(`head-${i}`, [
          <Text>
            {file.verb} <Text bold>{file.filePath}</Text> <Text color={RESULT_GUTTER_COLOR}>{`(+${file.added} -${file.removed})`}</Text>
          </Text>,
        ])}
        <Box flexDirection="column" paddingLeft={BASH_DIFF_INDENT}>
          {diffLines({ Box, Text }, file.rows)}
        </Box>
      </Box>
    )

    // A line above, as the engine's own row draws (its margin goes with the row it replaces).
    return (
      <Box flexDirection="column" marginTop={1}>
        {header}
        {row.output && block('output', output(row.output))}
        {row.cwdNote && block('cwd', [<Text color={RESULT_GUTTER_COLOR}>{row.cwdNote}</Text>])}
        {row.edits.map(edit)}
        {row.editNote && block('note', [<Text color={RESULT_GUTTER_COLOR}>{row.editNote}</Text>])}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // A grouped Edit/Write row draws its result inline: the diff is drawn here,
  // under the engine's header and its emptied result line.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (traced(e.props.tool)) await debug($, () => ({ at: 'ToolUse', tool: e.props.tool, id: e.props.tool_use_id, surface: e.surface, isExpanded: e.props.isExpanded, isRunning: e.props.isRunning, isErrored: e.props.isErrored, grouped: grouped.has(e.props.tool_use_id), output: outputShape(e.props.output) }))
    if (e.surface !== 'terminal' || e.props.isErrored || !FILE_EDIT_TOOLS.has(e.props.tool)) return next(e)
    if (!grouped.has(e.props.tool_use_id)) return next(e) // its result is a ToolResult, below
    // A new file in a group (a Write into the session's own scratchpad, seen in a capture): the engine
    // has no empty result to draw under its header, as it has for a patch, so the whole row is drawn here.
    const created = e.props.tool === 'Write' ? readNewFile(e.props.output, e.props.isExpanded === true) : undefined
    if (created) {
      const { Box, Text, Link } = $.ui.resolve(e)
      newFileDrawnWhole.add(e.props.tool_use_id)
      const cwd = await Promise.resolve($.session.cwd()).catch(() => undefined)
      const path = shownPath(created.filePath, cwd, e.props.isExpanded === true)
      // A line above, as the engine's own row draws.
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Text color="success">{BULLET}</Text>
            <Box flexDirection="column" flexShrink={1}>
              <Text>
                <Text bold>Write</Text>(<Link href={fileUrl(created.filePath)}>{path}</Link>)
              </Text>
            </Box>
          </Box>
          {newFileBlock({ Box, Text, Link }, created, path)}
        </Box>
      )
    }
    const patch = readPatch(e.props.output)
    const lang = patch && fileLang(patch.filePath)
    if (!patch || !lang) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const rows = diffRows(patch.hunks, lang)
    // The engine draws the header from an output with no patch; its result row is then left empty.
    const output = { ...(e.props.output as Record<string, unknown>), structuredPatch: [] }
    const engineRow = await next({ ...e, props: { ...e.props, output } })
    resultDrawnInline.add(e.props.tool_use_id)

    return (
      <Box flexDirection="column">
        {engineRow}
        <Box flexDirection="column" paddingLeft={DIFF_INDENT}>
          <Box position="absolute" top={-1} left={SUMMARY_COLUMN}>
            <Text>{summarize(rows).split(/(\d+)/).map(part => (/^\d+$/.test(part) ? <Text bold>{part}</Text> : part))}</Text>
          </Box>
          {diffLines({ Box, Text }, rows)}
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) => {
    await debug($, () => ({ at: 'ToolUse failed', tool: e.props.tool, id: e.props.tool_use_id, error: String(next.error) }))
    return next(e)
  })

  // A grouped MCP row draws its result inline (every MCP row seen in a probe was
  // grouped): the engine draws the header, whose title no prop carries, from an
  // emptied result, and the blocks are drawn under it.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !e.props.tool.startsWith('mcp__') || e.props.isErrored || e.props.isInterrupted || e.props.isRunning || e.props.isExpanded !== true) return next(e)
    if (!grouped.has(e.props.tool_use_id)) return next(e) // its result is a ToolResult, below
    const blocks = mcpBlocks(e.props.output)
    if (!blocks) return next(e)
    const { Box } = $.ui.resolve(e)
    const header = await next({ ...e, props: { ...e.props, output: [] } })
    resultDrawnInline.add(e.props.tool_use_id)
    return (
      <Box flexDirection="column">
        {header}
        {mcpGutters($.ui.resolve(e), blocks)}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolResult', props: { tool: 'Bash' } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !bashDrawnWhole.has(e.props.tool_use_id)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  }).catch(($, e, next) => next(e))

  // A standalone Edit/Write row (not in a group) draws its result here: the
  // summary line and the diff, in place of the engine's.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (traced(e.props.tool)) await debug($, () => ({ at: 'ToolResult', tool: e.props.tool, id: e.props.tool_use_id, surface: e.surface, isExpanded: e.props.isExpanded, isErrored: e.props.isErrored, output: outputShape(e.props.output) }))
    if (e.surface !== 'terminal' || e.props.isErrored || !FILE_EDIT_TOOLS.has(e.props.tool)) return next(e)
    const { Box, Text, Link } = $.ui.resolve(e)
    // Drawn already in its grouped row: ctrl+o raises this ToolResult for it too.
    if (newFileDrawnWhole.has(e.props.tool_use_id) || resultDrawnInline.has(e.props.tool_use_id)) return <Box />
    // A new file has no patch: its lines, numbered, under the engine's "Wrote" line.
    const created = e.props.tool === 'Write' ? readNewFile(e.props.output, e.props.isExpanded === true) : undefined
    if (created) {
      const cwd = await Promise.resolve($.session.cwd()).catch(() => undefined)
      return newFileBlock({ Box, Text, Link }, created, shownPath(created.filePath, cwd, e.props.isExpanded === true))
    }
    const patch = readPatch(e.props.output)
    const lang = patch && fileLang(patch.filePath)
    if (!patch || !lang) return next(e)

    const rows = diffRows(patch.hunks, lang)
    // The engine draws no gutter around a ToolResult a hook answers: it is drawn here.
    return (
      <Box flexDirection="row">
        <Text color={RESULT_GUTTER_COLOR}>{RESULT_GUTTER}</Text>
        <Box flexDirection="column" flexShrink={1}>
          <Text>{summarize(rows).split(/(\d+)/).map(part => (/^\d+$/.test(part) ? <Text bold>{part}</Text> : part))}</Text>
          {diffLines({ Box, Text }, rows)}
        </Box>
      </Box>
    )
  }).catch(async ($, e, next) => {
    await debug($, () => ({ at: 'ToolResult failed', tool: e.props.tool, id: e.props.tool_use_id, error: String(next.error) }))
    return next(e)
  })

  // A Fetch result in full: the engine's "Received …" line, then the page in
  // its colors where the engine draws it plain (a standalone row's ToolResult,
  // seen with a probe; the text starts at the left edge, as the engine's does).
  on('ui.render', { component: 'ToolResult', props: { tool: 'WebFetch' } }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored || e.props.isExpanded !== true) return next(e)
    const output = e.props.output as Record<string, unknown> | undefined
    const result = output?.['result']
    const spans = typeof result === 'string' ? fetchSpans(result) : undefined
    if (!spans) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // The engine's line with an empty page; its own `⎿` comes with it (seen with a probe).
    const received = await next({ ...e, props: { ...e.props, output: { ...output, result: '' } } })
    return (
      <Box flexDirection="column">
        {received}
        {spanLines(Text, spans)}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // An MCP tool's result in full (claude.ai connectors and local servers): each
  // text block under its own `⎿`, a leading JSON value laid out and colored, the
  // text after it as output. Regular mode's cut-down result stays the engine's.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isErrored || e.props.isExpanded !== true || !e.props.tool.startsWith('mcp__')) return next(e)
    const blocks = mcpBlocks(e.props.output)
    if (!blocks) return next(e)
    const { Box } = $.ui.resolve(e)
    if (resultDrawnInline.has(e.props.tool_use_id)) return <Box /> // its grouped row drew it; ctrl+o raises this too
    // The engine draws no gutter around a ToolResult a hook answers: it is drawn here.
    return mcpGutters($.ui.resolve(e), blocks)
  }).catch(($, e, next) => next(e))
}

/** An MCP result's text blocks, each under its own `⎿`, as the engine draws them. */
function mcpGutters({ Box, Text }: Pick<ElementTable<'terminal'>, 'Box' | 'Text'>, blocks: readonly (readonly OutputSpan[])[]): RenderElement {
  return (
    <Box flexDirection="column">
      {blocks.map(spans => (
        <Box flexDirection="row">
          <Text color={RESULT_GUTTER_COLOR}>{RESULT_GUTTER}</Text>
          <Box flexDirection="column" flexShrink={1}>
            {spanLines(Text, spans)}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write'])
/** The rows CODE_COLORS_DEBUG logs: Edit, Write and MCP tools. */
const traced = (tool: string) => FILE_EDIT_TOOLS.has(tool) || tool.startsWith('mcp__')

/** A piece of a command as the running row's surface module takes it: plain data, in the palette's colors. */
function commandParts(part: { text: string; lang?: Lang }): Part[] {
  if (!part.lang) return [{ text: part.text }]
  return commandTokens(part.text, part.lang).map(({ kind, text }) => {
    const color = PALETTE[kind]
    return color ? { text, color } : { text }
  })
}

/** Tokens in the palette's colors; a kind with no color stays plain text. */
function coloredTokens(Text: ElementTable<'terminal'>['Text'], tokens: readonly Token[]): RenderNode[] {
  return tokens.map(({ kind, text }) => {
    const color = PALETTE[kind]
    return color ? <Text color={color}>{text}</Text> : text
  })
}

/** Spans of output, one Text per line where a span has a language, plain spans whole. */
function spanLines(Text: ElementTable<'terminal'>['Text'], spans: readonly OutputSpan[]): RenderNode[] {
  return spans.flatMap(span =>
    span.lang
      ? toLines(span.text, span.lang).map(tokens => <Text>{tokens.length === 0 ? ' ' : coloredTokens(Text, tokens)}</Text>)
      : [<Text>{span.text}</Text>],
  )
}

/** A diff's lines on delta's tints, numbered, changed words on a stronger tint: Edit/Write rows and Bash rows alike. */
// The engine links a file's path this way (seen in a capture).
const fileUrl = (path: string) => `file://${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`

/** A new file's `⎿` block: the engine's "Wrote" line, then its lines, numbered. */
function newFileBlock({ Box, Text, Link }: Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Link'>, created: NewFile, path: string): RenderElement {
  const width = String(created.rows.length).length
  return (
    <Box flexDirection="row">
      <Text color={RESULT_GUTTER_COLOR}>{RESULT_GUTTER}</Text>
      <Box flexDirection="column" flexShrink={1}>
        <Text>
          Wrote <Text bold>{String(created.total)}</Text> {created.total === 1 ? 'line' : 'lines'} to{' '}
          <Link href={fileUrl(created.filePath)}>
            <Text bold>{path}</Text>
          </Link>
        </Text>
        {created.rows.map(({ lineNo, tokens }) => (
          <Box flexDirection="row" paddingLeft={1}>
            <Text color={RESULT_GUTTER_COLOR}>{`${String(lineNo).padStart(width)} `}</Text>
            <Box flexShrink={1}>
              <Text>{tokens.length ? coloredTokens(Text, tokens) : ' '}</Text>
            </Box>
          </Box>
        ))}
        {created.hidden > 0 && <Text color={RESULT_GUTTER_COLOR}>{`… +${created.hidden} lines`}</Text>}
      </Box>
    </Box>
  )
}

function diffLines({ Box, Text }: Pick<ElementTable<'terminal'>, 'Box' | 'Text'>, rows: DiffRow[]): RenderNode[] {
  const gutter = Math.max(...rows.map(row => (row.kind === 'gap' ? 0 : String(row.lineNo).length)))
  const tokenText = (row: Exclude<DiffRow, { kind: 'gap' }>) =>
    row.tokens.map(({ kind, text, isChanged }) => {
      const color = PALETTE[kind]
      const word = isChanged && row.kind !== 'context' ? CHANGED_WORD_TINT[row.kind] : undefined
      if (!color && !word) return text
      return <Text {...(color ? { color } : {})} {...(word ? { backgroundColor: word } : {})}>{text}</Text>
    })
  return rows.map(row => {
    if (row.kind === 'gap') return <Text dimColor>{' '.repeat(gutter)} ...</Text>
    const tint = row.kind === 'context' ? undefined : DIFF_TINT[row.kind]
    return (
      <Box flexGrow={1} {...(tint ? { backgroundColor: tint } : {})}>
        <Text>
          <Text dimColor>{`${String(row.lineNo).padStart(gutter)} ${DIFF_SIGN[row.kind]} `}</Text>
          {tokenText(row)}
        </Text>
      </Box>
    )
  })
}

// The engine's own Bash row, copied cell for cell (seen in a capture): `● ` and `  ⎿  `.
const BULLET = '● '
const RESULT_GUTTER = '  ⎿\u00a0 '
const RESULT_GUTTER_COLOR = 'inactive'
// A Bash diff's lines start under the path, as the engine's do (seen in a capture).
const BASH_DIFF_INDENT = 5

const DIFF_INDENT = 4 // lines up with the engine's result text under the tool row

/** Where the engine wrote "Added 1 line" after the row's corner glyph: the summary is painted over that empty row. */
const SUMMARY_COLUMN = 5

const DIFF_SIGN: Record<'add' | 'remove' | 'context', string> = { add: '+', remove: '-', context: ' ' }
