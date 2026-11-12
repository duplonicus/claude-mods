// What one very long line costs to color, in every language: is the cost linear, and how bad is the worst
// text? Then what it costs to decide the line's language (shell.ts `outputLines`), and whether the line
// comes back whole. Synthetic lines only; reads no transcript and runs no command.
// bun tools/line-cost.ts [chars]
import { tokenize } from '../hooks/highlight'
import { LANGUAGES, type Lang } from '../hooks/languages'
import { outputLines } from '../hooks/shell'

const size = Number(process.argv[2] ?? 100_000)
// Text a lexer could choke on: one repeated unit, each a different trap (runs of one character, quotes
// that never close, comment openers, nested brackets, minified code, a long word).
const UNITS: Record<string, string> = {
  spaces: ' ',
  tabs: '\t',
  word: 'a',
  digits: '1234567890',
  backslashes: '\\\\',
  slashes: '/',
  dots: '.',
  dashes: '--a=b ',
  colons: 'a:',
  'open double quotes': '"abc ',
  'open single quotes': "'",
  backticks: '`',
  'comment openers': '/* # -- // ',
  brackets: '[{(',
  'angle brackets': '<a b="c">',
  'dollar braces': '${a',
  'minified js': 'function a(b,c){return b.map(d=>d*c+"x").filter(Boolean)};var e={f:1,"g":[2,3]};',
  'toml table': '{ id = "t1", name = "[Research] a: b/c", note = "2026-06-11 x (1) y -> +0.45pct" }, ',
  paths: '/home/a/b/c.ts:12:3 ',
  'path prefixes': 'a/b.ts:',
  'number prefixes': '12:',
}
const line = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
const cost = (text: string, lang: Lang) => {
  const runs: number[] = []
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    tokenize(text, lang)
    runs.push(performance.now() - start)
  }
  return Math.min(...runs)
}

let worst = { ms: 0, lang: '', unit: '' }
console.log(`one line of ${size} chars, best of 3 runs, ms (and the same text at a tenth of the size, to show the growth)`)
for (const lang of Object.keys(LANGUAGES) as Lang[]) {
  let top = { ms: 0, unit: '', tenth: 0 }
  for (const [name, unit] of Object.entries(UNITS)) {
    const ms = cost(line(unit, size), lang)
    if (ms > top.ms) top = { ms, unit: name, tenth: cost(line(unit, size / 10), lang) }
  }
  if (top.ms > worst.ms) worst = { ms: top.ms, lang, unit: top.unit }
  console.log(`${lang.padEnd(11)} worst ${top.ms.toFixed(1).padStart(8)}  (${top.unit}; a tenth: ${top.tenth.toFixed(1)}, growth x${(top.ms / Math.max(top.tenth, 0.01)).toFixed(0)})`)
}
console.log(`worst of all: ${worst.ms.toFixed(1)} ms, ${worst.lang}, ${worst.unit}`)

// Deciding a line's language: every kind of command the classifier treats differently, each trap text.
const COMMANDS = ['ls', 'wc -c a.md && grep -n k a.toml | head', 'ls; grep -rn k src | head', 'sh x', 'git diff']
let slowest = { ms: 0, command: '', unit: '' }
let lossy = 0
for (const command of COMMANDS) {
  for (const [name, unit] of Object.entries(UNITS)) {
    const stdout = `first\n${line(unit, size)}`
    const start = performance.now()
    const drawn = outputLines(command, stdout)
    const ms = performance.now() - start
    if (drawn.map(part => part.prefix + part.text).join('\n') !== stdout) lossy++
    if (ms > slowest.ms) slowest = { ms, command, unit: name }
  }
}
console.log(`deciding a ${size}-char line's language: worst ${slowest.ms.toFixed(1)} ms (${slowest.command}; ${slowest.unit}); lines not returned whole: ${lossy} of ${COMMANDS.length * Object.keys(UNITS).length}`)
