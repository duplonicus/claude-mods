/**
 * How many real Bash rows code-colors draws, and why the rest stay the
 * engine's. Runs the mod's own bashRow on transcripts.
 * Usage: bun tools/bash-coverage.ts <transcript.jsonl>...
 */
import { readFileSync } from 'node:fs'

import { bashRow } from '../hooks/shell'

const calls = new Map<string, string>() // tool_use id -> command
const counts: Record<string, number> = {}
const examples: Record<string, string[]> = {}
const count = (key: string, command: string) => {
  counts[key] = (counts[key] ?? 0) + 1
  ;(examples[key] ??= []).length < 4 && examples[key]!.push(command.split('\n')[0]!.slice(0, 90))
}

for (const file of process.argv.slice(2)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
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
      if (block.type !== 'tool_result' || !calls.has(block.tool_use_id)) continue
      const command = calls.get(block.tool_use_id)!
      const result = entry.toolUseResult
      // Several results in one entry keep only one toolUseResult; live, each row has its own.
      if (result === undefined) {
        count('unknown: result not in transcript (parallel calls)', command)
        continue
      }
      const isErrored = Boolean(block.is_error)
      const output = isErrored ? (typeof block.content === 'string' ? block.content : JSON.stringify(block.content)) : result
      const row = bashRow({ input: { command }, isRunning: false, isErrored, isInterrupted: Boolean(result?.interrupted), output })
      if (row) {
        if (row.bullet === 'error') count('ours: errored', command)
        else if (row.output?.lang) count(`ours: output colored (${row.output.lang})`, command)
        else if (row.edits.length) count('ours: file diff drawn', command)
        else if (row.editNote) count('ours: edit note only', command)
        else if (row.cwdNote) count('ours: with cwd note', command)
        else count('ours: command colored, output plain', command)
        continue
      }
      const why =
        typeof result !== 'object' || result === null ? 'engine: result not an object'
        : result.interrupted ? 'engine: interrupted'
        : result.backgroundTaskId ? 'engine: backgrounded'
        : result.gitOperation ? 'engine: git commit/push/PR'
        : result.bashEditDiff?.moreFiles ? 'engine: edit diff with more files than shown'
        : result.bashEditDiff?.skipped ? 'engine: edit diff skipped'
        : result.bashEditDiff?.shared && result.bashEditDiff?.files?.length ? 'engine: edit diff with the shared note'
        : result.bashEditDiff?.files?.some((f: any) => f.deleted) ? 'engine: edit diff with a deletion'
        : /^\s*Shell cwd was reset to /.test(result.stderr ?? '') ? 'engine: "Shell cwd was reset" note'
        : result.stderr ? 'engine: stderr kept separate'
        : String(result.stdout ?? '').includes('\u001b') ? 'engine: terminal escapes'
        : 'engine: other'
      count(why, command)
    }
  }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0)
for (const [key, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(5)}  ${((100 * n) / total).toFixed(1).padStart(5)}%  ${key}`)
  for (const example of examples[key]!) console.log(`               ${example}`)
}
console.log(`${String(total).padStart(5)}  total Bash rows`)
