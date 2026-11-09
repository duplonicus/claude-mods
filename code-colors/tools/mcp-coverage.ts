// What the MCP result coloring does on real transcripts: how many results it draws, why it leaves the rest, whether
// every character survives the layout (whitespace aside), and what a result costs to cut and tokenize. Parses only.
// bun tools/mcp-coverage.ts [days]
import { readFileSync, readdirSync, statSync } from 'fs'
import { toLines } from '../hooks/highlight'
import { mcpBlocks } from '../hooks/mcp'

const days = Number(process.argv[2] ?? 30)
const root = `${process.env['HOME']}/.claude/projects`
const cutoff = Date.now() - days * 864e5
const count = (into: Record<string, number>, key: string) => (into[key] = (into[key] ?? 0) + 1)
const outcome: Record<string, number> = {}
const byServer: Record<string, number> = {}
const spanLangs: Record<string, number> = {}
const lossy: string[] = []
const times: number[] = []
const squash = (text: string) => text.replace(/\s+/g, '')

for (const dir of readdirSync(root)) {
  let names: string[] = []
  try {
    names = readdirSync(`${root}/${dir}`)
  } catch {
    continue
  }
  for (const name of names) {
    const path = `${root}/${dir}/${name}`
    if (!name.endsWith('.jsonl') || statSync(path).mtimeMs < cutoff) continue
    const text = readFileSync(path, 'utf8')
    if (!text.includes('"name":"mcp__')) continue
    const tools = new Map<string, string>()
    for (const line of text.split('\n')) {
      if (!line.includes('mcp__') && !line.includes('tool_result')) continue
      let entry: { message?: { content?: unknown }; toolUseResult?: unknown }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as { type?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean }[]) {
        if (block.type === 'tool_use' && block.name?.startsWith('mcp__')) tools.set(block.id!, block.name)
        if (block.type !== 'tool_result' || !tools.has(block.tool_use_id!) || block.is_error) continue
        const tool = tools.get(block.tool_use_id!)!
        const output = entry.toolUseResult
        const started = performance.now()
        const blocks = mcpBlocks(output)
        for (const spans of blocks ?? []) for (const span of spans) if (span.lang) toLines(span.text, span.lang)
        times.push(performance.now() - started)
        if (!blocks) {
          const why = output == null ? 'no stored result' : Array.isArray(output) && output.some(b => (b as { type?: string })?.type !== 'text') ? 'has an image or other block' : 'empty or plain'
          count(outcome, `engine: ${why}`)
          continue
        }
        count(outcome, 'colored')
        count(byServer, tool.split('__')[1]!)
        for (const spans of blocks) for (const span of spans) count(spanLangs, span.lang ?? 'plain (past the cap)')
        const original = typeof output === 'string' ? output : (output as { text: string }[]).map(b => b.text).join('')
        const drawn = blocks.flatMap(spans => spans.map(span => span.text)).join('')
        if (squash(drawn) !== squash(original)) lossy.push(`${tool}: ${original.slice(0, 80)}`)
      }
    }
  }
}

times.sort((a, b) => a - b)
const mean = times.reduce((a, b) => a + b, 0) / (times.length || 1)
console.log({ days, results: times.length, outcome, byServer, spanLangs, lossy: lossy.length })
console.log(`ms per result: mean ${mean.toFixed(2)}, p99 ${times[Math.floor(times.length * 0.99)]?.toFixed(2)}, worst ${times.at(-1)?.toFixed(2)}`)
for (const line of lossy.slice(0, 10)) console.log('LOSSY', line)
