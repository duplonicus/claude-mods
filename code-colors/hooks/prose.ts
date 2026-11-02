/**
 * prose.ts: the pure half of drawing a reply's prose. Splits the Markdown
 * between code blocks into blocks (paragraphs, lists, headings, rules) and
 * each line into inline runs (bold, italic, inline code, links). Blocks this
 * does not draw (tables, quotes, HTML, other fences, indented code) are left
 * whole for the engine's own renderer. No `$`; register.tsx draws it.
 */

// Reply prose, from the default palette: bold in the keyword orange, inline code in
// the name pink (the engine draws it in the theme's `permission` blue), list
// markers and headings in the number gold.
export const PROSE = { bold: '#FFB454', code: '#FF7A95', link: '#5FD7D7', marker: '#FFD08A', heading: '#FFD08A', rule: 'inactive' } as const
// The flow format's three header labels, each its own color: TL;DR in the code
// palette's comment green, the status
// line's `high` effort teal (ansi 80), and red for
// the line you act on. Links take the teal too.
export const LABEL_COLORS: Record<string, string> = { 'TL;DR': '#26A269', 'Needs you': '#E5484D', 'Next from me': '#5FD7D7' }
/** One run of inline text and how it is styled. */
export type Inline = { text: string; code?: true; bold?: true; italic?: true; strike?: true; href?: string; hex?: string }

/** A line of a block: a paragraph line, a list item (its continuation lines joined by `\n`), a heading or a rule. */
export type Row =
  | { kind: 'para'; inline: Inline[] }
  | { kind: 'item'; indent: number; marker: string; ordered: boolean; inline: Inline[] }
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'rule' }

/** Blocks are drawn one blank line apart, as the engine draws paragraphs. */
export type ProseBlock = { kind: 'ours'; rows: Row[] } | { kind: 'engine'; text: string }

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
// A closing run of #s needs a space before it, so "## Learning C#" keeps its #.
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
// Lines the engine draws better than a plain paragraph could: tables, quotes, HTML.
const ENGINE_LINE = /^\s*(\||>|<[A-Za-z!/])/

/** The prose between code blocks as blocks, in order. */
export function proseBlocks(markdown: string): ProseBlock[] {
  const blocks: ProseBlock[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let current: string[] = []
  const flush = () => {
    if (current.length) blocks.push(toBlock(current))
    current = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      // A fence the mod has no lexer for stays inside the prose: the engine draws it whole.
      flush()
      const close = new RegExp(`^\\s{0,3}${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`)
      let end = i + 1
      while (end < lines.length && !close.test(lines[end]!)) end++
      blocks.push({ kind: 'engine', text: lines.slice(i, end + 1).join('\n') })
      i = end
      continue
    }
    if (!line.trim()) flush()
    else current.push(line)
  }
  flush()
  return blocks
}

function toBlock(lines: string[]): ProseBlock {
  const text = lines.join('\n')
  // Indented code, or a table, quote or HTML anywhere in the block: the engine's.
  if (/^( {4}|\t)/.test(lines[0]!) || lines.some(line => ENGINE_LINE.test(line))) return { kind: 'engine', text }
  const rows: Row[] = []
  for (const line of lines) {
    const last = rows.at(-1)
    if (RULE.test(line)) {
      rows.push({ kind: 'rule' })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      rows.push({ kind: 'heading', level: heading[1]!.length, inline: inlineRuns(heading[2]!) })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const marker = item[2]!
      rows.push({ kind: 'item', indent: item[1]!.replace(/\t/g, '    ').length, marker, ordered: /\d/.test(marker), inline: inlineRuns(item[3]!) })
      continue
    }
    // A line after an item continues it (Markdown's lazy continuation); after a paragraph line, a new line of it.
    if (last?.kind === 'item') {
      last.inline = [...last.inline, { text: '\n' }, ...inlineRuns(line.trim())]
      continue
    }
    rows.push({ kind: 'para', inline: inlineRuns(line) })
  }
  return { kind: 'ours', rows }
}

// A bare URL, without the punctuation that usually ends the sentence around it.
const BARE_URL = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]*_]/

/** One line's inline Markdown as styled runs. */
export function inlineRuns(source: string, style: Omit<Inline, 'text'> = {}): Inline[] {
  const runs: Inline[] = []
  let plain = ''
  const push = (run: Inline) => {
    if (plain) runs.push(...withHex({ ...style, text: plain }))
    plain = ''
    runs.push(...withHex(run))
  }
  let i = 0
  while (i < source.length) {
    const rest = source.slice(i)
    const before = source[i - 1] ?? ' '
    let match: RegExpExecArray | null
    if ((match = /^\\([!-/:-@[-`{-~])/.exec(rest))) {
      plain += match[1]
      i += match[0].length
    } else if ((match = /^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      const code = match[2]!
      push({ ...style, text: /^ .* $/.test(code) ? code.slice(1, -1) : code, code: true })
      i += match[0].length
    } else if ((match = /^\[([^\]\n]+)\]\(<?([^)\s>]+)>?\)/.exec(rest))) {
      for (const run of inlineRuns(match[1]!, { ...style, href: match[2]! })) push(run)
      i += match[0].length
    } else if ((match = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) {
      push({ ...style, text: match[1]!, href: match[1]! })
      i += match[0].length
    } else if (!/\w/.test(before) && (match = BARE_URL.exec(rest))) {
      push({ ...style, text: match[0], href: match[0] })
      i += match[0].length
    } else if ((match = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)) && (match[1] === '**' || !/\w/.test(before))) {
      for (const run of inlineRuns(match[2]!, { ...style, bold: true })) push(run)
      i += match[0].length
    } else if ((match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) {
      for (const run of inlineRuns(match[1]!, { ...style, strike: true })) push(run)
      i += match[0].length
    } else if ((match = /^([*_])(?=[^\s*_])([\s\S]*?[^\s\\])\1(?![*_])/.exec(rest)) && (match[1] === '*' || (!/\w/.test(before) && !/\w/.test(source[i + match[0].length] ?? ' ')))) {
      for (const run of inlineRuns(match[2]!, { ...style, italic: true })) push(run)
      i += match[0].length
    } else {
      plain += source[i]
      i++
    }
  }
  if (plain) runs.push(...withHex({ ...style, text: plain }))
  return runs
}

// `#FFB454` or `#f80` as a color: six hex digits, or three with a letter among
// them, so an issue number like #123 stays text.
const HEX = /(?<![\w&#])#(?:[0-9a-fA-F]{6}|(?=[0-9]*[a-fA-F])[0-9a-fA-F]{3})(?![\w-])/g

/** A run cut so each hex color code in it is a run of its own, drawn in that color. Links stay whole. */
function withHex(run: Inline): Inline[] {
  if (run.href || run.hex) return [run]
  const out: Inline[] = []
  let at = 0
  for (const match of run.text.matchAll(HEX)) {
    if (match.index > at) out.push({ ...run, text: run.text.slice(at, match.index) })
    const digits = match[0].slice(1)
    const full = digits.length === 3 ? [...digits].map(d => d + d).join('') : digits
    out.push({ ...run, text: match[0], hex: `#${full.toUpperCase()}` })
    at = match.index + match[0].length
  }
  if (!out.length) return [run]
  if (at < run.text.length) out.push({ ...run, text: run.text.slice(at) })
  return out
}

/** Relative luminance (WCAG) of a `#RRGGBB` color, 0 for black to 1 for white. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** The bold label a line starts with (`**TL;DR**`, `**Needs you**:`), or undefined. */
export function leadLabel(inline: readonly Inline[]): string | undefined {
  const first = inline[0]
  return first?.bold && !first.code && !first.href ? first.text.replace(/[:\s]+$/, '') : undefined
}
