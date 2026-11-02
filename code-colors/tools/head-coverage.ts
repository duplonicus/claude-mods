// How Bash rows piped through `head` get colored, on real transcripts. Parses only; runs no command.
// bun tools/head-coverage.ts
import { readFileSync, readdirSync, statSync } from 'fs'
import { filePrints, grepLines, outputLang } from '../hooks/shell'

const root = `${process.env['HOME']}/.claude/projects`
const cutoff = Date.now() - 3 * 864e5
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
const plain: Record<string, number> = {}

function whyPlain(command: string) {
  const segments = command.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(s => s && !/^(cd|export|pushd|set)\b/.test(s) && !/^\w+=/.test(s))
  if (segments.length > 1) return 'several commands in the chain'
  const stages = (segments[0] ?? '').split('|')
  return stages.length > 2 ? 'one command, extra pipe stage' : 'one command, not a print or grep'
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
      const stdout = entry.toolUseResult?.stdout
      if (!/\|\s*head\b/.test(command) || typeof stdout !== 'string' || !stdout) continue
      if (outputLang(command)) count(rows, 'colored: whole output')
      else if (grepLines(command, stdout)) count(rows, 'colored: grep lines')
      else if (filePrints(command).length) count(rows, 'maybe: file print in a chain, if its text is found')
      else {
        count(rows, 'plain')
        count(plain, whyPlain(command))
      }
    }
  }
}

console.log({ transcripts: files.length, rows, plain })
