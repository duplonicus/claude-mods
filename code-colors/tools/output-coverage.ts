// What the Bash output coloring does on real transcripts: how much of the text gets a color, whether every
// line joins back to what the command printed, and what a row costs. Parses only; runs no command.
// bun tools/output-coverage.ts [days]
import { readFileSync, readdirSync, statSync } from 'fs'
import { tokenize } from '../hooks/highlight'
import { bashRow, commandTokens, splitCommand, type GrepLine } from '../hooks/shell'

const days = Number(process.argv[2] ?? 3)
const root = `${process.env['HOME']}/.claude/projects`
const cutoff = Date.now() - days * 864e5
const files: string[] = []
for (const dir of readdirSync(root)) {
  let names: string[] = []
  try {
    names = readdirSync(`${root}/${dir}`)
  } catch {
    continue
  }
  for (const name of names) {
    const path = `${root}/${dir}/${name}`
    if (name.endsWith('.jsonl') && statSync(path).mtimeMs > cutoff && statSync(path).size > 50000) files.push(path)
  }
}

const count = (into: Record<string, number>, key: string) => (into[key] = (into[key] ?? 0) + 1)
const rows: Record<string, number> = {}
const lineLangs: Record<string, number> = {}
const noColor: string[] = []
const lossy: string[] = []
const times: { ms: number; command: string; bytes: number }[] = []
const lossyCommands: string[] = []
const stringChars = { string: 0, other: 0 }
const commandMs: number[] = []
let chars = 0
let coloredChars = 0

function draw(lines: readonly GrepLine[], stdout: string, command: string) {
  const joined = lines.map(line => line.prefix + line.text).join('\n')
  if (joined !== stdout) lossy.push(command.slice(0, 100))
  let colored = 0
  for (const line of lines) {
    count(lineLangs, line.lang ?? 'none')
    chars += line.prefix.length + line.text.length
    if (!line.lang) continue
    for (const token of tokenize(line.text, line.lang)) {
      if (token.kind !== 'plain' && token.kind !== 'punct') colored += token.text.length
    }
  }
  coloredChars += colored
  if (!colored && stdout.trim()) noColor.push(stdout.slice(0, 90).replace(/\n/g, ' | '))
}

for (const file of files) {
  const calls = new Map<string, string>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string') calls.set(block.id, block.input.command)
      if (block.type !== 'tool_result' || block.is_error || !calls.has(block.tool_use_id)) continue
      const command = calls.get(block.tool_use_id)!
      const commandStart = performance.now()
      for (const part of splitCommand(command)) {
        if (!part.lang) continue
        const tokens = commandTokens(part.text, part.lang)
        if (tokens.map(token => token.text).join('') !== part.text) lossyCommands.push(command.slice(0, 100))
        for (const token of tokens) {
          stringChars[token.kind === 'string' ? 'string' : 'other'] += token.text.length
        }
      }
      commandMs.push(performance.now() - commandStart)
      const result = entry.toolUseResult
      if (typeof result?.stdout !== 'string' || !result.stdout) continue
      const start = performance.now()
      const row = bashRow({ input: { command }, isRunning: false, isErrored: false, isInterrupted: false, output: result })
      const output = row?.output
      const lines = output?.grep ?? output?.lines
      if (lines) draw(lines, result.stdout.replace(/\r\n/g, '\n'), command)
      times.push({ ms: performance.now() - start, command: command.slice(0, 80), bytes: result.stdout.length })
      count(rows, !row ? 'engine draws it' : output?.lang ? 'whole output in a language' : output?.grep ? 'grep lines' : output?.lines ? 'output lines' : 'other')
    }
  }
}

times.sort((a, b) => b.ms - a.ms)
const sum = times.reduce((total, time) => total + time.ms, 0)
console.log({
  transcripts: files.length,
  rows,
  lineLangs,
  coloredShare: `${((100 * coloredChars) / chars).toFixed(1)}% of ${chars} chars`,
  rowsWithNoColor: noColor.length,
  lossyRows: lossy.length,
  msPerRow: { mean: +(sum / times.length).toFixed(3), p99: +times[Math.floor(times.length * 0.01)]!.ms.toFixed(2), worst: times.slice(0, 3) },
})
commandMs.sort((a, b) => b - a)
console.log({
  commands: commandMs.length,
  lossyCommands: lossyCommands.length,
  stringChars,
  commandMs: { mean: +(commandMs.reduce((total, ms) => total + ms, 0) / commandMs.length).toFixed(3), p99: +commandMs[Math.floor(commandMs.length * 0.01)]!.toFixed(2), worst: +commandMs[0]!.toFixed(2) },
})
console.log('no color, sample:', noColor.slice(0, 25))
console.log('lossy, sample:', lossy.slice(0, 10))
