/**
 * shell.ts: the pure half of coloring Bash rows. Splits a command into the
 * shell part and its heredoc bodies (each in the language of the program that
 * reads it), and guesses the language of a command's output from the files it
 * prints. No `$`, no IO; register.tsx reads the printed files and draws it.
 */

import { diffRows, isHunk, type DiffRow } from './diff'
import { tokenize, type Token } from './highlight'
import { fileLang, langFromPath, type Lang } from './languages'

export type CommandPart = { lang: Lang | undefined; text: string }

// `<<EOF`, `<<-'EOF'`, `<< "EOF"`: the body starts on the next line. Not a `<<<` here-string.
const HEREDOC = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/g

// The program before `<<` on its line decides how its body is colored.
const PROGRAM_LANGS: Record<string, Lang> = {
  python: 'python', python3: 'python', uv: 'python', node: 'ts', bun: 'ts', deno: 'ts',
  psql: 'sql', sqlite3: 'sql', bash: 'bash', sh: 'bash', zsh: 'bash',
  pwsh: 'powershell', powershell: 'powershell', 'powershell.exe': 'powershell', 'pwsh.exe': 'powershell',
}

function heredocLang(lineBefore: string): Lang | undefined {
  // Only the command the `<<` belongs to: in `find > list.txt; python3 - <<EOF`
  // the redirect is another command's.
  const own = lineBefore.split(/&&|\|\||[;|]/).at(-1) ?? ''
  // `cat > notes.py <<'EOF'` writes a file: its extension says.
  const target = /(?:^|\s)>{1,2}\s*([^\s<>|&;]+)/.exec(own)
  if (target?.[1]) return langFromPath(target[1])
  const program = /(?:^|\s)([\w.-]+)(?:\s+[^\s<>|&;]+)*\s*$/.exec(own)?.[1]
  return program ? PROGRAM_LANGS[program] : undefined
}

// A string shorter than this and with no pipe stays one color (`'EOF'`, `"--- now"`); one longer than the other isn't split, to keep a redraw cheap.
const MIN_EXPANDED_STRING = 20
const MAX_EXPANDED_STRING = 2000
const QUOTED = /^([A-Za-z$]*)("""|'''|["'`])([\s\S]*)\2$/
// `python3 -c`, `bash -c`, `powershell.exe -Command`, flags between them too: the string is that program's code.
const CODE_FLAG = /(?:^|[\s;&|(])(?:[^\s;&|(]*\/)?([\w.-]+)(?:\s+-\S+(?:\s+[^\s-]\S*)?)*\s+-(?:\w*c|e|Command)\s+$/
// What `echo`, `printf` and a commit's `-m` take is prose, even with a semicolon in it.
const PROSE_BEFORE = /(?:^|[\s;&|(])(?:echo|printf)(?:\s+-\S+)*\s+$|\s(?:-m|--message)[\s=]$/
const SHELL_SHAPE = /\s\|\s|&&|;\s/

/** The language to draw a string's inside in, from the language around it and the text before it; `undefined` keeps the string whole. */
function stringLang(inner: string, before: string, lang: Lang): Lang | undefined {
  const program = lang === 'bash' ? CODE_FLAG.exec(before)?.[1] : undefined
  if (program && Object.hasOwn(PROGRAM_LANGS, program)) return PROGRAM_LANGS[program]
  if (!inner.includes('|') && !(/\s/.test(inner) && inner.length >= MIN_EXPANDED_STRING)) return undefined
  return lang === 'bash' && !PROSE_BEFORE.test(before) && SHELL_SHAPE.test(inner) ? 'bash' : 'output'
}

/**
 * A command's tokens, with the inside of a long string drawn by its shape
 * rather than all in the string color: a quoted command as a command, code
 * after `-c` in its language, a sentence as output. The quotes keep the string
 * color. Joined, the texts are `source` exactly.
 */
export function commandTokens(source: string, lang: Lang): Token[] {
  const tokens = tokenize(source, lang)
  // Output has no quotes to go inside, and Markdown's strings are code fences, not quotes.
  if (lang === 'output' || lang === 'markdown') return tokens
  let at = 0
  return tokens.flatMap(token => {
    const before = source.slice(Math.max(0, at - 80), at)
    at += token.text.length
    if (token.kind !== 'string' || token.text.length > MAX_EXPANDED_STRING) return [token]
    const quoted = QUOTED.exec(token.text)
    const inner = quoted?.[3]
    const innerLang = inner && stringLang(inner, before, lang)
    if (!quoted || !inner || !innerLang) return [token]
    return [{ kind: 'string' as const, text: quoted[1]! + quoted[2]! }, ...commandTokens(inner, innerLang), { kind: 'string' as const, text: quoted[2]! }]
  })
}

/**
 * The command in parts: shell text as `bash`, each heredoc body in its own
 * language (`undefined`: plain). Joined, the texts are the command exactly.
 */
export function splitCommand(command: string): CommandPart[] {
  const parts: CommandPart[] = []
  let shellFrom = 0
  for (let at = 0; ; ) {
    HEREDOC.lastIndex = at
    const marker = HEREDOC.exec(command)
    if (!marker) break
    const lineStart = command.lastIndexOf('\n', marker.index) + 1
    const bodyStart = command.indexOf('\n', marker.index)
    if (bodyStart < 0) break
    const delimiter = marker[3]!
    const trims = marker[1] === '-'
    // The body ends at a line that is the delimiter alone (tabs before it with `<<-`).
    let end = bodyStart + 1
    let bodyEnd = -1
    while (end <= command.length) {
      const lineEnd = command.indexOf('\n', end)
      const line = command.slice(end, lineEnd < 0 ? command.length : lineEnd)
      if ((trims ? line.replace(/^\t+/, '') : line) === delimiter) {
        bodyEnd = end
        break
      }
      if (lineEnd < 0) break
      end = lineEnd + 1
    }
    if (bodyEnd < 0) break // unterminated: leave the rest to the shell lexer
    // The delimiter line is plain: the shell lexer would color `EOF` as a command.
    const delimiterEnd = bodyEnd + (trims ? command.slice(bodyEnd).search(/[^\t]/) : 0) + delimiter.length
    parts.push({ lang: 'bash', text: command.slice(shellFrom, bodyStart + 1) })
    parts.push({ lang: heredocLang(command.slice(lineStart, marker.index)), text: command.slice(bodyStart + 1, bodyEnd) })
    parts.push({ lang: undefined, text: command.slice(bodyEnd, delimiterEnd) })
    shellFrom = delimiterEnd
    at = delimiterEnd
  }
  parts.push({ lang: 'bash', text: command.slice(shellFrom) })
  return parts.filter(part => part.text)
}

// Commands that print a file as it is; the output is then in the file's language.
const PRINTERS = new Set(['cat', 'head', 'tail', 'sed', 'bat', 'batcat', 'nl'])
// Commands that print nothing of their own before a printer runs.
const SILENT = new Set(['cd', 'pushd', 'export', 'set'])
// What may follow a printer in a pipe without changing what kind of text it is.
const FILTERS = new Set(['head', 'tail'])

const words = (stage: string) => stage.trim().split(/\s+/).filter(Boolean).map(word => word.replace(/^(['"])(.*)\1$/, '$2'))

/** The files one printer stage prints, or undefined when it is not a plain print of files. */
function printedFiles(stage: string[]): string[] | undefined {
  const [program, ...args] = stage
  if (!program || !PRINTERS.has(program)) return undefined
  const files: string[] = []
  let skipNext = false
  let sedScript = program === 'sed'
  for (const arg of args) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (/^\d*[<>]+&?$/.test(arg)) {
      skipNext = true // `2> /dev/null`: the next word is the redirect's target
      continue
    }
    if (/^\d*[<>]/.test(arg)) continue // `2>/dev/null`, `2>&1`
    if (arg.startsWith('-')) {
      if (/^-[nc]$/.test(arg) && (program === 'head' || program === 'tail')) skipNext = true // `head -n 40`; `cat -n` takes none
      if (program === 'sed' && arg !== '-n') return undefined // -i, -e and friends change the text
      continue
    }
    if (sedScript) {
      if (!/^[\d,$]*p$/.test(arg)) return undefined // only `sed -n 10,40p`
      sedScript = false
      continue
    }
    if (/^[+-]?\d+$/.test(arg)) continue
    files.push(arg)
  }
  if (program === 'sed' && !args.includes('-n')) return undefined
  return files
}

/** A stage that only drops, reorders or shortens lines, so what comes out is still the same kind of text. */
function keepsLines([program, ...args]: string[]): boolean {
  if (!program) return false
  if (FILTERS.has(program) || program === 'tac' || program === 'sort') return true
  if (program === 'cut') return args.some(arg => /^-[cb]/.test(arg))
  if (program === 'uniq') return !args.some(arg => /^-[a-zA-Z]*c/.test(arg))
  if (program === 'sed') return args.includes('-n') && args.some(arg => /^[\d,$]+p$/.test(arg))
  if (GREPS.has(program)) return !args.some(arg => /^-[a-zA-Z]*[clLoq]/.test(arg) || /^--(?:count|files|only-matching|quiet)/.test(arg))
  return false
}

const isAssignment = (word: string) => /^[A-Za-z_]\w*=/.test(word)

/** A segment that prints nothing: `cd x`, `export A=1`, `T=a.ts`. */
const isSilent = (stages: string[][]) => stages.length === 1 && (SILENT.has(stages[0]![0]!) || stages[0]!.every(isAssignment))

/** The command's segments with `$X` filled in from plain assignments before it (`T=a.ts; grep -n x $T`). */
function commandSegments(command: string): string[][][] {
  const values = new Map<string, string>()
  return quotedSegments(command).map(stages => {
    const filled = stages.map(stage => stage.map(word => word.replace(/\$(?:(\w+)|\{(\w+)\})/g, (whole, bare?: string, braced?: string) => values.get(bare ?? braced ?? '') ?? whole)))
    if (filled.length && isSilent(filled)) {
      for (const word of filled[0]!) if (isAssignment(word)) values.set(word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1))
    }
    return filled
  })
}

/**
 * The language a command's output is in: when every part that prints is a
 * plain print of files of one language (`cat a.py`, `sed -n 1,40p x.ts | head`,
 * `cd repo && cat b.py`). Anything else (a grep, a build) is undefined.
 */
export function outputLang(command: string): Lang | undefined {
  if (/<</.test(command) || /[`]|\$\(/.test(command)) return undefined
  let lang: Lang | undefined
  for (const stages of commandSegments(command)) {
    const first = stages[0]
    if (!first?.length) continue
    if (isSilent(stages)) continue
    const files = printedFiles(first)
    if (!files?.length) return undefined
    if (!stages.slice(1).every(keepsLines)) return undefined
    for (const file of files) {
      const fileLang = langFromPath(file)
      if (!fileLang || (lang && fileLang !== lang)) return undefined
      lang = fileLang
    }
  }
  return lang
}

/** Which lines of a file a print shows: `from`..`to` (1-based, inclusive) or the `last` few. */
export type LinePick = { from: number; to: number } | { last: number }

/** One file a part of a mixed command prints as it is, to be found in the output by its text. */
export type FilePrint = { path: string; dir?: string; lang: Lang; picks: LinePick[] }

/** The lines one print stage shows: [] for all, undefined when it changes the text or the count can't be read. */
function stagePicks(stage: string[]): LinePick[] | undefined {
  const [program, ...args] = stage
  const rest = args.filter(arg => !/^\d*[<>]/.test(arg))
  if (program === 'cat') return rest.some(arg => arg.startsWith('-')) ? undefined : []
  if (program === 'sed') {
    const script = rest.find(arg => !arg.startsWith('-'))
    const range = /^(\d+)(?:,(\d+|\$))?p$/.exec(script ?? '')
    if (!range) return undefined
    const from = Number(range[1])
    return [{ from, to: range[2] === '$' ? Infinity : range[2] ? Number(range[2]) : from }]
  }
  if (program !== 'head' && program !== 'tail') return undefined
  let count = '10'
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '-n') count = rest[++i] ?? ''
    else if (/^-n[+-]?\d+$/.test(arg)) count = arg.slice(2)
    else if (/^-\d+$/.test(arg)) count = arg.slice(1)
    else if (arg.startsWith('-')) return undefined // -c, -f, -q: not whole lines of one file
  }
  if (!/^\+?\d+$/.test(count)) return undefined
  if (program === 'head') return count.startsWith('+') ? undefined : [{ from: 1, to: Number(count) }]
  return count.startsWith('+') ? [{ from: Number(count.slice(1)), to: Infinity }] : [{ last: Number(count) }]
}

/**
 * The files a mixed command prints as they are (`git status; cat NOW.md`,
 * `sed -n 1,22p a.ts; grep x b.ts`), in order, each with the lines it shows
 * and the folder a `cd` before it moved to. The text is then looked for in the
 * output, so a guess that is wrong only leaves that part plain.
 */
export function filePrints(command: string): FilePrint[] {
  if (/<</.test(command) || /[`]|\$\(/.test(command)) return []
  const prints: FilePrint[] = []
  let dir: string | undefined
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const stages = segment.split('|').map(words)
    const first = stages[0]
    if (!first?.length) continue
    if (stages.length === 1 && (first[0] === 'cd' || first[0] === 'pushd')) {
      const target = first[1]
      dir = target && !target.startsWith('-') ? (dir && !/^[~/]/.test(target) ? `${dir}/${target}` : target) : undefined
      continue
    }
    const files = printedFiles(first)
    const lang = files?.length === 1 ? langFromPath(files[0]!) : undefined
    if (!lang) continue
    const picks = stages.map(stagePicks)
    if (picks.some(pick => !pick) || stages.slice(1).some(stage => !FILTERS.has(stage[0] ?? ''))) continue
    prints.push({ path: files![0]!, ...(dir ? { dir } : {}), lang, picks: picks.flat() as LinePick[] })
  }
  return prints
}

/** The text a print of `file` shows, without the trailing newline the engine trims. */
export function printedText(file: string, picks: readonly LinePick[]): string {
  let lines = lf(file).split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const pick of picks) lines = 'last' in pick ? (pick.last ? lines.slice(-pick.last) : []) : lines.slice(pick.from - 1, pick.to)
  return lines.join('\n').trimEnd()
}

/** Windows line endings as `\n`: a `\r` left in a line draws an extra blank line (seen on a CRLF page). */
export const lf = (text: string) => text.replace(/\r\n/g, '\n')

// Past this many lines the output is drawn plain: a huge `cat` must not stall a redraw.
export const MAX_COLORED_LINES = 300

/**
 * The output cut where each printed text is found whole, in command order and
 * starting on a line of its own: those spans in their language, the rest plain.
 * Undefined when none is found.
 */
export function printSpans(stdout: string, prints: readonly { lang: Lang; text: string }[]): OutputSpan[] | undefined {
  const spans: OutputSpan[] = []
  let at = 0
  let coloredLines = 0
  for (const { lang, text } of prints) {
    if (!text.trim()) continue
    let found = stdout.indexOf(text, at)
    while (found >= 0) {
      const end = found + text.length
      if ((found === 0 || stdout[found - 1] === '\n') && (end === stdout.length || stdout[end] === '\n')) break
      found = stdout.indexOf(text, found + 1)
    }
    if (found < 0) continue
    const lines = text.split('\n').length
    if (coloredLines + lines > MAX_COLORED_LINES) break
    coloredLines += lines
    const before = stdout.slice(at, found).replace(/\n$/, '')
    if (before) spans.push({ text: before })
    spans.push({ lang, text })
    at = found + text.length + (stdout[found + text.length] === '\n' ? 1 : 0)
  }
  if (!spans.some(span => span.lang)) return undefined
  if (at < stdout.length) spans.push({ text: stdout.slice(at) })
  return spans
}

export type OutputSpan = { lang?: Lang; text: string }

export type BashOutput = {
  lang: Lang | undefined
  colored: string
  rest?: string
  color?: 'error' | 'inactive'
  /** A mixed command's output: the printed files' parts in their language, the rest plain (drawn instead of `colored`). */
  spans?: OutputSpan[]
  /** A grep's output: each line's `path:12:` prefix dim, its text in its file's language (drawn instead of `colored`). */
  grep?: GrepLine[]
  /** Any other command's output, line by line (drawn instead of `colored`, unless `spans` found printed files). */
  lines?: GrepLine[]
}

/** One line of grep output: the prefix grep adds (file, line number, separator), then the line in its file's language. */
export type GrepLine = { prefix: string; lang?: Lang; text: string }

const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg'])
// Options that take a value: as the next word, or joined (`-A14`, `--context=3`).
const GREP_VALUE_SHORT = new Set(['A', 'B', 'C', 'e', 'f', 'm', 'd', 'D', 'g', 't', 'T', 'j', 'M'])
const GREP_VALUE_LONG = new Set([
  '--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--include', '--exclude',
  '--exclude-dir', '--glob', '--type', '--type-not', '--max-columns', '--threads',
])

type GrepCall = { files: string[]; numbered: boolean; named: boolean }

/** A command's segments (split at `&&`, `||`, `;`, newlines), each its pipe stages as words, quotes kept together and taken off. */
function quotedSegments(command: string): string[][][] {
  const segments: string[][][] = []
  let stages: string[][] = []
  let word: string[] = []
  let current = ''
  let inWord = false
  let quote: string | undefined
  const endWord = () => {
    if (inWord) word.push(current)
    current = ''
    inWord = false
  }
  const endStage = () => {
    endWord()
    stages.push(word)
    word = []
  }
  const endSegment = () => {
    endStage()
    segments.push(stages.filter(stage => stage.length))
    stages = []
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) current += command[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inWord = true
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i]
      inWord = true
    } else if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      endSegment()
      i++
    } else if (ch === ';' || ch === '\n') endSegment()
    else if (ch === '|') endStage()
    else if (/\s/.test(ch)) endWord()
    else {
      current += ch
      inWord = true
    }
  }
  endSegment()
  return segments
}

/** One grep or rg stage's files and how it prefixes lines; undefined for counts, file lists and quiet runs, which print no lines of code. */
function grepStage(first: string[]): GrepCall | undefined {
  const isRg = first[0] === 'rg'
  const operands: string[] = []
  const flags = new Set<string>()
  let patternGiven = false
  for (let i = 1; i < first.length; i++) {
    const arg = first[i]!
    if (/^\d*[<>]/.test(arg)) {
      if (/^\d*[<>]+&?$/.test(arg)) i++ // `2> /dev/null`
      continue
    }
    if (arg === '--') {
      operands.push(...first.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [name] = arg.split('=')
      if (name === '--regexp' || name === '--file') patternGiven = true
      if (GREP_VALUE_LONG.has(name!) && !arg.includes('=')) i++
      flags.add(name!)
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      for (let c = 1; c < arg.length; c++) {
        const flag = arg[c]!
        flags.add(flag)
        if (flag === 'e' || flag === 'f') patternGiven = true
        if (GREP_VALUE_SHORT.has(flag)) {
          if (c === arg.length - 1) i++
          break
        }
      }
      continue
    }
    operands.push(arg)
  }
  if (['c', 'l', 'L', 'q', '--count', '--files-with-matches', '--files-without-match', '--files', '--quiet', '--json'].some(flag => flags.has(flag))) return undefined
  const files = patternGiven ? operands : operands.slice(1)
  const recursive = flags.has('r') || flags.has('R') || flags.has('--recursive') || flags.has('--dereference-recursive')
  const oneFile = files.length === 1 && !recursive && langFromPath(files[0]!) !== undefined
  const named = flags.has('H') || flags.has('--with-filename') || (!oneFile && !flags.has('h') && !flags.has('--no-filename') && !(isRg && flags.has('I')))
  const numbered = flags.has('n') || flags.has('--line-number')
  return { files, numbered, named }
}

/** A grep or rg alone in the command (after `cd`s, piped only through stages that keep its lines). */
function grepCall(command: string): GrepCall | undefined {
  if (/<</.test(command) || /[`]|\$\(/.test(command)) return undefined
  let call: GrepCall | undefined
  for (const stages of commandSegments(command)) {
    const first = stages[0]
    if (!first?.length) continue
    if (isSilent(stages)) continue
    if (call || !GREPS.has(first[0]!) || !stages.slice(1).every(keepsLines)) return undefined
    call = grepStage(first)
    if (!call) return undefined
  }
  return call
}

/** `path:12:text` or `path-12-text` (context), or `path:text` when not `numbered`; a path may hold `-` itself, so try each cut. */
function pathLine(line: string, numbered: boolean): GrepLine | undefined {
  for (const cut of line.matchAll(/[:-]/g)) {
    const at = cut.index
    const lang = langFromPath(line.slice(0, at))
    if (!lang) continue
    const sep = line[at]!
    const rest = line.slice(at + 1)
    if (!numbered) return { prefix: line.slice(0, at + 1), lang, text: rest }
    const number = new RegExp(`^(\\d+)\\${sep}`).exec(rest)
    if (number) return { prefix: line.slice(0, at + 1 + number[0].length), lang, text: rest.slice(number[0].length) }
  }
  return undefined
}

// A line longer than this is drawn plain: a minified file on one line must not stall a redraw.
const MAX_COLORED_LINE = 2000

const asOutput = (line: string): GrepLine => (line.length > MAX_COLORED_LINE ? { prefix: '', text: line } : { prefix: '', lang: 'output', text: line })

/**
 * A grep's output line by line: the prefix it adds dim, the rest in its file's
 * language (`124:const x`, `hooks/a.ts-12-  y`). Undefined unless the command
 * is a grep and some line was found in a language.
 */
export function grepLines(command: string, stdout: string): GrepLine[] | undefined {
  const call = grepCall(command)
  if (!call) return undefined
  const single = call.named ? undefined : langFromPath(call.files[0] ?? '')
  const lines = stdout.split('\n')
  if (lines.length > MAX_COLORED_LINES) return undefined
  const out = lines.map((line): GrepLine | undefined => {
    if (line === '--') return { prefix: line, text: '' }
    if (!call.named) {
      const numbered = call.numbered ? /^(\d+[:-])([\s\S]*)$/.exec(line) : null
      return numbered ? { prefix: numbered[1]!, lang: single, text: numbered[2]! } : { prefix: '', lang: single, text: line }
    }
    return pathLine(line, call.numbered)
  })
  // Lines that aren't code of a known file (a .txt among the .py) are still output.
  return out.some(line => line?.lang) ? out.map((line, i) => line ?? asOutput(lines[i]!)) : undefined
}

/** What one part of a chain prints, when that can be told: lines of one file's language, numbered or not. */
type Producer = { lang?: Lang; numbered?: boolean }

/** The commands between two `echo`s of a chain, which is how far their lines can be told from the next ones'. */
type Section = { echo?: string; producers: Producer[] }

function chainSections(command: string): { sections: Section[]; namedUnnumbered: boolean } {
  const sections: Section[] = [{ producers: [] }]
  let namedUnnumbered = false
  if (/<</.test(command) || /[`]|\$\(/.test(command)) return { sections, namedUnnumbered }
  for (const stages of commandSegments(command)) {
    const first = stages[0]
    if (!first?.length || isSilent(stages)) continue
    if (first[0] === 'echo' && stages.length === 1) {
      const text = first.slice(1).filter(word => !/^-[neE]+$/.test(word)).join(' ')
      if (text && !text.includes('$') && !first.some(word => /^\d*[<>]/.test(word))) sections.push({ echo: text, producers: [] })
      continue
    }
    const kept = stages.slice(1).every(keepsLines)
    const grep = kept && GREPS.has(first[0]!) ? grepStage(first) : undefined
    const files = kept ? printedFiles(first) : undefined
    let producer: Producer = {}
    if (grep?.named) namedUnnumbered ||= !grep.numbered
    else if (grep) producer = { lang: langFromPath(grep.files[0] ?? ''), numbered: grep.numbered }
    else if (files?.length === 1) producer = { lang: langFromPath(files[0]!) }
    sections.at(-1)!.producers.push(producer)
  }
  return { sections, namedUnnumbered }
}

const DIFF_LINE = /^(?:[ +\-\\]|@@|index |new file|deleted file|similarity|rename |old mode|new mode|Binary )/

// A grep in the command that reads files: `git grep`, `xargs grep`, quoted or by its path too. One right after a
// pipe only filters and adds no prefix. Without any, `a.py:12: error: x` is a compiler's line, not code.
const GREP_IN_COMMAND = /(?<!\|&?[\s\\]*)(?:^|[\s;&("'/])(?:[ef]?grep|rg)\s/

/**
 * Any command's output line by line. What is known keeps its language: grep
 * lines in a chain (a `path:12:` prefix anywhere; a bare `12:` where the `echo`s
 * show which grep it came from), diffs, `$ command` lines, JSON. The rest is
 * drawn as output (languages.ts), past MAX_COLORED_LINES plain. Output cut into
 * spans passes one `position` through them, so an `echo` is counted once.
 */
export function outputLines(command: string, stdout: string, position = { section: 0 }): GrepLine[] {
  const { sections, namedUnnumbered } = chainSections(command)
  const grepRan = GREP_IN_COMMAND.test(command)
  const all = stdout.split('\n')
  const lines = all.slice(0, MAX_COLORED_LINES)
  let wholeJson = false
  if (/^\s*[{[]/.test(stdout) && stdout.length < MAX_READ_JSON) {
    try {
      JSON.parse(stdout)
      wholeJson = true
    } catch {}
  }
  let inDiff = false
  const out = lines.map((line, i): GrepLine => {
    if (line.length > MAX_COLORED_LINE) return { prefix: '', text: line }
    if (wholeJson) return { prefix: '', lang: 'json', text: line }
    const echoed = sections.findIndex((section, index) => index > position.section && section.echo === line)
    if (echoed >= 0) {
      position.section = echoed
      inDiff = false
      return asOutput(line)
    }
    if (/^(?:diff --git |@@ -\d)/.test(line) || (line.startsWith('--- ') && all[i + 1]?.startsWith('+++ '))) inDiff = true
    else if (inDiff && line && !DIFF_LINE.test(line)) inDiff = false
    if (inDiff) return { prefix: '', lang: 'diff', text: line }

    const prefixed = grepRan ? pathLine(line, !namedUnnumbered) : undefined
    if (prefixed && !/\s/.test(prefixed.prefix)) return prefixed
    const { producers } = sections[position.section]!
    if (line === '--' && producers.some(producer => producer.lang)) return { prefix: line, text: '' }
    const numberedLangs = new Set(producers.filter(producer => producer.numbered).map(producer => producer.lang))
    const numberedLang = numberedLangs.size === 1 ? [...numberedLangs][0] : undefined
    const number = numberedLang && /^(\d+[:-])([\s\S]*)$/.exec(line)
    if (number) return { prefix: number[1]!, lang: numberedLang, text: number[2]! }
    const only = producers.length === 1 ? producers[0] : undefined
    if (only?.lang && !only.numbered) return { prefix: '', lang: only.lang, text: line }

    if (line.startsWith('$ ')) return { prefix: '$ ', lang: 'bash', text: line.slice(2) }
    if (/^\s*"[^"\n]*"\s*:/.test(line) || isJsonLine(line)) return { prefix: '', lang: 'json', text: line }
    return asOutput(line)
  })
  return all.length > lines.length ? [...out, { prefix: '', text: all.slice(lines.length).join('\n') }] : out
}

// Past this an output isn't parsed to see whether it is JSON.
const MAX_READ_JSON = 1_000_000

function isJsonLine(line: string): boolean {
  if (!/^\s*[{[].*[}\]],?\s*$/.test(line)) return false
  try {
    JSON.parse(line.replace(/,\s*$/, ''))
    return true
  } catch {
    return false
  }
}

/** One file the command changed, as the engine heads it: "Updated <path> (+1 -0)". */
export type FileEdit = { verb: 'Updated' | 'Created'; filePath: string; added: number; removed: number; rows: DiffRow[] }

/** Each part is one `⎿` block of the row, in the engine's order. */
export type BashRow = {
  /** `running`: the engine's grey, held steady (the engine blinks it). */
  bullet: 'success' | 'error' | 'running'
  command: CommandPart[]
  /** `colored` in `lang` (plain when undefined), then `rest` plain; `color` for a plain whole. Absent when it is empty and other blocks follow. */
  output?: BashOutput
  /** "Shell cwd was reset to …", after a `cd` out of the session's folders. */
  cwdNote?: string
  edits: FileEdit[]
  /** The engine's line after the diffs, or alone when it has none to show. */
  editNote?: string
}

// Result fields the engine draws something of its own for (a git summary, a
// background notice, a saved-output note): those rows stay its.
const ENGINE_DRAWN = [
  'backgroundTaskId', 'persistedOutputPath', 'gitOperation', 'returnCodeInterpretation',
  'structuredContent', 'timedOutAfterMs', 'backgroundCwdHint', 'rawOutputPath',
] as const

// The engine's own wording under a Bash row's diff (seen in a capture, 2.1.312).
export const EDIT_NOTES = {
  files: '(files that changed while this command ran, by the command or by another process; a convenience view, not a review or audit of the command)',
  unavailable: '(file diff unavailable for this command)',
  shared: '(another command ran in this repository at the same time; a change made by either may show under either result)',
}

const CWD_RESET = /^\n?(Shell cwd was reset to [^\n]+)$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * The files a command changed and the note under them, or undefined for a
 * record the engine draws in a way not seen yet (skipped, more files than
 * shown, a deletion, files with the shared note).
 */
function readEditDiff(record: unknown): { edits: FileEdit[]; editNote?: string } | undefined {
  if (record === undefined) return { edits: [] }
  if (!isRecord(record) || !Array.isArray(record['files']) || record['skipped'] || record['moreFiles']) return undefined
  const files: unknown[] = record['files']
  const edits: FileEdit[] = []
  for (const file of files) {
    if (!isRecord(file) || typeof file['filePath'] !== 'string' || file['deleted']) return undefined
    const hunks: unknown = file['hunks']
    if (!Array.isArray(hunks) || !hunks.every(isHunk)) return undefined
    const lines = hunks.flatMap(hunk => hunk.lines)
    edits.push({
      verb: file['created'] ? 'Created' : 'Updated',
      filePath: file['filePath'],
      added: lines.filter(line => line.startsWith('+')).length,
      removed: lines.filter(line => line.startsWith('-')).length,
      rows: diffRows(hunks, fileLang(file['filePath'])),
    })
  }
  if (edits.length) return record['shared'] || record['unavailable'] ? undefined : { edits, editNote: EDIT_NOTES.files }
  if (record['unavailable']) return { edits, editNote: EDIT_NOTES.unavailable }
  if (record['shared']) return { edits, editNote: EDIT_NOTES.shared }
  return undefined
}

/**
 * What a Bash row in full draws, or undefined to leave the row to the engine:
 * an interrupted run, an image, terminal escapes, or any result the engine
 * draws extra parts for. A running one is its header alone.
 */
export function bashRow(props: { input: unknown; isRunning: boolean; isErrored: boolean; isInterrupted: boolean; output?: unknown }): BashRow | undefined {
  const command = (props.input as { command?: unknown } | undefined)?.command
  // While the model is still writing the call, the command is missing or empty.
  if (typeof command !== 'string' || !command || props.isInterrupted) return undefined
  const parts = splitCommand(command)
  // A running row is its header alone; the ctrl+b hint under it is a row of its own (seen in a capture).
  // So is a call not started yet (PreToolUse hooks, a permission prompt): filmed white for ~0.5 s before this.
  if (props.isRunning || (props.output === undefined && !props.isErrored)) return { bullet: 'running', command: parts, edits: [] }
  if (props.output === undefined) return undefined
  if (props.isErrored) {
    // The text the model read, "Error: Exit code 2" and what followed; the engine draws it whole in red.
    if (typeof props.output !== 'string' || props.output.includes('\u001b')) return undefined
    return { bullet: 'error', command: parts, output: { lang: undefined, colored: lf(props.output), color: 'error' }, edits: [] }
  }
  const result = props.output as Record<string, unknown>
  if (typeof result !== 'object' || result === null || typeof result['stdout'] !== 'string') return undefined
  if (result['isImage'] || result['interrupted'] || ENGINE_DRAWN.some(field => result[field] !== undefined)) return undefined
  // The only stderr seen apart from stdout is the engine's own cwd note; anything else stays its.
  const stderr = typeof result['stderr'] === 'string' ? result['stderr'] : ''
  const cwdNote = CWD_RESET.exec(stderr)?.[1]
  if (stderr && !cwdNote) return undefined
  const diff = readEditDiff(result['bashEditDiff'])
  if (!diff) return undefined
  const stdout = lf(result['stdout'])
  if (stdout.includes('\u001b')) return undefined
  const row = { bullet: 'success' as const, command: parts, ...(cwdNote ? { cwdNote } : {}), ...diff }
  if (!stdout) return cwdNote || diff.editNote ? row : { ...row, output: { lang: undefined, colored: '(No output)', color: 'inactive' } }
  const lang = outputLang(command)
  const grep = lang ? undefined : grepLines(command, stdout)
  if (grep) return { ...row, output: { lang: undefined, colored: stdout, grep } }
  return { ...row, output: lang ? drawnOutput(stdout, lang) : { lang: undefined, colored: stdout, lines: outputLines(command, stdout) } }
}

function drawnOutput(stdout: string, lang: Lang): BashOutput {
  const lines = stdout.split('\n')
  if (lines.length <= MAX_COLORED_LINES) return { lang, colored: stdout }
  return { lang, colored: lines.slice(0, MAX_COLORED_LINES).join('\n'), rest: lines.slice(MAX_COLORED_LINES).join('\n') }
}
