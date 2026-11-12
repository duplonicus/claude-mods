/**
 * highlight.ts: the pure half of code-colors. Splits a reply's markdown into
 * prose and code fences of the languages in languages.ts, tokenizes code with
 * those rules, and holds the palettes. No `$`, no IO; register.tsx draws it.
 */

import { FENCE_LANGS, LANGUAGES, type Lang, type Token, type TokenKind } from './languages'

export type { Lang, Token, TokenKind } from './languages'

export type PaletteName = 'ubuntu' | 'github' | 'modern' | 'minimal'

export type Palette = Record<TokenKind, string | undefined>

export type Segment =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; lang: Lang; source: string; palette?: PaletteName }

/** Token colors; `undefined` keeps the terminal's default color. */
export const PALETTES: Record<PaletteName, Palette> = {
  // The Windows Terminal scheme "Ubuntu Readable" (purple #300A24 background)
  ubuntu: {
    keyword: '#FFB454',
    type: '#3EE0B4',
    name: '#FF7A95',
    string: '#E5484D',
    number: '#FFD08A',
    comment: '#26A269',
    function: '#68FDFA',
    punct: undefined,
    plain: undefined,
  },
  // GitHub Dark: primer/github-vscode-theme src/theme.js, @primer/primitives 7.10.0 dark scale
  github: {
    keyword: '#FF7B72', // red[3]
    type: '#FFA657', // orange[2], entity.name
    name: '#FFA657',
    string: '#A5D6FF', // blue[1]
    number: '#79C0FF', // blue[2], constant
    comment: '#8B949E', // gray[3]
    function: '#D2A8FF', // purple[2]
    punct: undefined,
    plain: undefined,
  },
  // VS Code Default Dark Modern: microsoft/vscode theme-defaults dark_vs.json + dark_plus.json
  modern: {
    keyword: '#569CD6',
    type: '#4EC9B0',
    name: '#4EC9B0',
    string: '#CE9178',
    number: '#B5CEA8',
    comment: '#6A9955',
    function: '#DCDCAA',
    punct: undefined,
    plain: undefined,
  },
  // GitHub Dark hues on keywords, strings and comments only
  minimal: {
    keyword: '#FF7B72',
    type: undefined,
    name: undefined,
    string: '#A5D6FF',
    number: undefined,
    comment: '#8B949E',
    function: undefined,
    punct: undefined,
    plain: undefined,
  },
}

export const DEFAULT_PALETTE: PaletteName = 'ubuntu'

export const PALETTE: Palette = PALETTES[DEFAULT_PALETTE]

const isPaletteName = (name: string): name is PaletteName => Object.hasOwn(PALETTES, name)

// Matches every fence, whatever its tag or length: a fence we leave in the prose must still be passed over
// whole, or its closing line would read as a bare fence opening and a fence inside a longer one as its own.
const FENCE = /^(`{3,})([^\n`]*)\n(?:([\s\S]*?)\n)??\1`*[ \t]*(?:\n|$)/gm

export function splitFences(markdown: string): Segment[] {
  const segments: Segment[] = []
  let proseStart = 0
  for (const match of markdown.matchAll(FENCE)) {
    const [tag = '', palette = ''] = (match[2] ?? '').trim().split(/\s+/)
    const name = tag.toLowerCase()
    const lang = match[1] === '```' && Object.hasOwn(FENCE_LANGS, name) ? FENCE_LANGS[name] : undefined
    if (!lang) continue // its whole fence stays inside the surrounding prose
    const prose = markdown.slice(proseStart, match.index)
    if (prose) segments.push({ kind: 'prose', text: prose })
    const source = match[3] ?? ''
    segments.push(isPaletteName(palette) ? { kind: 'code', lang, source, palette } : { kind: 'code', lang, source })
    proseStart = match.index + match[0].length
  }
  const rest = markdown.slice(proseStart)
  if (rest) segments.push({ kind: 'prose', text: rest })
  return segments
}

function matchAt(source: string, at: number, lang: Lang): Token {
  const { rules, classifyWord } = LANGUAGES[lang]
  for (const { kind, pattern } of rules) {
    pattern.lastIndex = at
    const match = pattern.exec(source)
    if (!match) continue
    const text = match[0]
    if (kind !== 'word') return { kind, text }
    return { kind: classifyWord(text, source.slice(0, at), source.slice(at + text.length)), text }
  }
  return { kind: 'plain', text: source.charAt(at) }
}

// A line past this is drawn plain: a minified file on one line must not stall a redraw. The lexers named
// here cost in step with a line's length (100,000 chars: under 25 ms each); for every other one the cost
// grows with the square (batch: 9 s for the same line), so those, and any language not measured yet, keep
// the short limit. Measured with tools/line-cost.ts.
export const MAX_COLORED_LINE = 100_000
export const MAX_SLOW_COLORED_LINE = 2000
const LINEAR_LEXERS: ReadonlySet<Lang> = new Set<Lang>(['output', 'json', 'ini', 'yaml', 'diff', 'python', 'rust', 'sql', 'hcl', 'surql', 'c'])

/** Whether a line is short enough to color in this language. */
export const colorsLine = (line: string, lang: Lang): boolean => line.length <= (LINEAR_LEXERS.has(lang) ? MAX_COLORED_LINE : MAX_SLOW_COLORED_LINE)

/** Tokens in source order; joined, their texts are `source` exactly. */
export function tokenize(source: string, lang: Lang): Token[] {
  const tokens: Token[] = []
  for (let at = 0; at < source.length; ) {
    const token = matchAt(source, at, lang)
    const last = tokens.at(-1)
    if (token.kind === 'plain' && last?.kind === 'plain') tokens[tokens.length - 1] = { kind: 'plain', text: last.text + token.text }
    else tokens.push(token)
    at += token.text.length
  }
  return tokens
}

/** The tokens of each source line; a token spanning lines is split and keeps its kind. */
export function toLines(source: string, lang: Lang): Token[][] {
  const lines: Token[][] = [[]]
  for (const { kind, text } of tokenize(source, lang)) {
    text.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([])
      if (piece) lines.at(-1)?.push({ kind, text: piece })
    })
  }
  return lines
}
