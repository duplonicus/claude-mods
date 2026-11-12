/**
 * diff.ts: the pure half of the diff redraw. Reads an Edit/Write result's
 * `structuredPatch` (validated, since the engine hands it over as `unknown`)
 * and turns it into numbered, tokenized rows for register.tsx to draw.
 */

import { colorsLine, tokenize, toLines, type Lang, type Token } from './highlight'
import { fileLang } from './languages'

export type Hunk = { oldStart: number; newStart: number; lines: string[] }

export type Patch = { filePath: string; hunks: Hunk[] }

export type DiffRow =
  | { kind: 'gap' }
  | { kind: 'add' | 'remove' | 'context'; lineNo: number; tokens: Token[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export function isHunk(value: unknown): value is Hunk {
  return (
    isRecord(value) &&
    typeof value.oldStart === 'number' &&
    typeof value.newStart === 'number' &&
    Array.isArray(value.lines) &&
    value.lines.every(line => typeof line === 'string')
  )
}

/** An Edit/Write result's patch, or `undefined` when it carries none worth drawing. */
export function readPatch(output: unknown): Patch | undefined {
  if (!isRecord(output) || typeof output.filePath !== 'string') return undefined
  const hunks: unknown = output.structuredPatch
  if (!Array.isArray(hunks) || hunks.length === 0 || !hunks.every(isHunk)) return undefined
  return { filePath: output.filePath, hunks }
}

// As the engine's row: this many lines in regular mode, then how many more (seen in a capture, 2.1.314).
const COMPACT_LINES = 10
// Past this many lines a new file is drawn plain, and with a line too long for its language (highlight.ts
// `colorsLine`) all of it: neither must stall a redraw.
const MAX_COLORED_FILE_LINES = 300

export type NewFile = { filePath: string; total: number; rows: { lineNo: number; tokens: Token[] }[]; hidden: number }

// The engine draws a plan file's Write as "Updated plan" and "/plan to preview" (seen in a capture, 2.1.314).
const PLAN_FILE = /[\\/]\.claude[\\/]plans[\\/]/

/** A file's path as the engine's "Wrote" line says it: relative to the session's folder in regular mode (seen in a capture, 2.1.314). */
export const shownPath = (filePath: string, cwd: string | undefined, isExpanded: boolean) =>
  !isExpanded && cwd && filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath

/** A Write that created a file, as the row shows it; `undefined` for anything else, for an empty file (the engine says "No content"), a plan file and a language left to the engine. */
export function readNewFile(output: unknown, isExpanded: boolean): NewFile | undefined {
  if (!isRecord(output) || output.type !== 'create' || typeof output.filePath !== 'string' || typeof output.content !== 'string' || !output.content) return undefined
  if (PLAN_FILE.test(output.filePath)) return undefined
  const lang = fileLang(output.filePath)
  if (!lang) return undefined
  const lines = output.content.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const shown = isExpanded ? lines : lines.slice(0, COMPACT_LINES)
  const colored = shown.slice(0, MAX_COLORED_FILE_LINES)
  const tokens = colored.some(line => !colorsLine(line, lang)) ? [] : toLines(colored.join('\n'), lang)
  const rows = shown.map((line, i) => ({ lineNo: i + 1, tokens: tokens[i] ?? (line ? [{ kind: 'plain' as const, text: line }] : []) }))
  return { filePath: output.filePath, total: lines.length, rows, hidden: lines.length - shown.length }
}

const NO_NEWLINE_MARKER = '\\'

function hunkRows({ oldStart, newStart, lines }: Hunk, lang: Lang | undefined): DiffRow[] {
  let oldLine = oldStart
  let newLine = newStart
  const rows: DiffRow[] = []
  for (const line of lines) {
    const sign = line.charAt(0)
    if (sign === NO_NEWLINE_MARKER) continue
    const text = line.slice(1)
    // A file of no known language is drawn plain, still on the diff tints.
    const tokens = lang ? tokenize(text, lang) : text ? [{ kind: 'plain' as const, text }] : []
    if (sign === '-') rows.push({ kind: 'remove', lineNo: oldLine++, tokens })
    else if (sign === '+') rows.push({ kind: 'add', lineNo: newLine++, tokens })
    else {
      rows.push({ kind: 'context', lineNo: newLine++, tokens })
      oldLine++
    }
  }
  return rows
}

/** Each token split at whitespace, so words are compared without the spaces around them. */
const splitAtWhitespace = (tokens: Token[]): Token[] =>
  tokens.flatMap(({ kind, text }) => text.split(/(\s+)/).filter(Boolean).map(piece => ({ kind, text: piece })))

const isSpace = (token: Token) => !token.text.trim()
const wordKey = (token: Token) => `${token.kind}:${token.text}`

/** The longest common subsequence of two word lists, as the kept indices of each side. */
function commonWords(a: Token[], b: Token[]): [Set<number>, Set<number>] {
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  const at = (i: number, j: number) => lengths[i]?.[j] ?? 0
  const same = (i: number, j: number) => wordKey(a[i] ?? { kind: 'plain', text: '' }) === wordKey(b[j] ?? { kind: 'plain', text: '\0' })
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lengths[i]
    for (let j = b.length - 1; row && j >= 0; j--) row[j] = same(i, j) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  }
  const keptA = new Set<number>()
  const keptB = new Set<number>()
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (same(i, j)) {
      keptA.add(i++)
      keptB.add(j++)
    } else if (at(i + 1, j) >= at(i, j + 1)) i++
    else j++
  }
  return [keptA, keptB]
}

/**
 * Marks the words of `pieces` outside `kept` (indices into its non-space words);
 * a space is marked only between two marked words, so a changed run is one block.
 */
function markChanged(pieces: Token[], kept: Set<number>): Token[] {
  const wordIndex = new Map<number, number>()
  pieces.forEach((piece, i) => !isSpace(piece) && wordIndex.set(i, wordIndex.size))
  const isChangedWord = (i: number) => wordIndex.has(i) && !kept.has(wordIndex.get(i) ?? -1)
  return pieces.map((piece, i) => {
    const changed = isSpace(piece) ? isChangedWord(i - 1) && isChangedWord(i + 1) : isChangedWord(i)
    return changed ? { ...piece, isChanged: true } : piece
  })
}

function markPair(removed: Token[], added: Token[]): [Token[], Token[]] {
  const removedPieces = splitAtWhitespace(removed)
  const addedPieces = splitAtWhitespace(added)
  const [keptRemoved, keptAdded] = commonWords(removedPieces.filter(p => !isSpace(p)), addedPieces.filter(p => !isSpace(p)))
  return [markChanged(removedPieces, keptRemoved), markChanged(addedPieces, keptAdded)]
}

/** Pairs each run of removed lines with the added lines after it and marks the words that differ. */
function markChangedWords(rows: DiffRow[]): DiffRow[] {
  const marked = [...rows]
  for (let start = 0; start < marked.length; start++) {
    let removeEnd = start
    while (marked[removeEnd]?.kind === 'remove') removeEnd++
    let addEnd = removeEnd
    while (marked[addEnd]?.kind === 'add') addEnd++
    const pairs = Math.min(removeEnd - start, addEnd - removeEnd)
    for (let k = 0; k < pairs; k++) {
      const removed = marked[start + k]
      const added = marked[removeEnd + k]
      if (removed?.kind !== 'remove' || added?.kind !== 'add') continue
      const [removedTokens, addedTokens] = markPair(removed.tokens, added.tokens)
      marked[start + k] = { ...removed, tokens: removedTokens }
      marked[removeEnd + k] = { ...added, tokens: addedTokens }
    }
    start = Math.max(start, addEnd - 1)
  }
  return marked
}

/** Rows of every hunk, a `gap` between hunks; each line is tokenized on its own. */
export function diffRows(hunks: Hunk[], lang: Lang | undefined): DiffRow[] {
  return hunks.flatMap((hunk, i) => [...(i > 0 ? [{ kind: 'gap' } as const] : []), ...markChangedWords(hunkRows(hunk, lang))])
}

const lines = (count: number) => `${count} ${count === 1 ? 'line' : 'lines'}`

/** The result's first line, as the engine words it: "Added 1 line, removed 2 lines". */
export function summarize(rows: DiffRow[]): string {
  const added = rows.filter(row => row.kind === 'add').length
  const removed = rows.filter(row => row.kind === 'remove').length
  const parts = [added > 0 ? `added ${lines(added)}` : '', removed > 0 ? `removed ${lines(removed)}` : ''].filter(Boolean)
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Diff line backgrounds: delta's dark-theme defaults (dandavison/delta src/color.rs,
 * DARK_THEME_PLUS_COLOR / DARK_THEME_MINUS_COLOR). WCAG contrast, add / remove line
 * (python3 tools/tints.py [palette]): the modern palette keeps every color >= 4.5:1
 * (lowest comment green, 4.83 / 5.20); the default ubuntu palette does not for strings
 * (#E5484D, 4.12 / 4.43), everything else in it is >= 4.95.
 */
export const DIFF_TINT: Record<'add' | 'remove', string> = { add: '#002800', remove: '#3F0001' }

/**
 * Changed-word background: the strongest pure green/red where every color of the
 * modern palette except comments keeps WCAG contrast >= 4.5:1 on it (comments about
 * 4.0), so the syntax colors are kept. With the ubuntu palette, comments are about 4.1
 * and strings about 3.4 here. Chosen over a stronger tint with white text and over
 * an underline, compared side by side.
 */
export const CHANGED_WORD_TINT: Record<'add' | 'remove', string> = { add: '#003800', remove: '#670000' }
