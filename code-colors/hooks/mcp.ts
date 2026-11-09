/**
 * mcp.ts: the pure half of coloring an MCP tool's result (`mcp__*` rows, the
 * claude.ai connectors and local servers alike). The stored result is a string
 * or a list of content blocks; each text block is drawn under its own `⎿`, as
 * the engine draws them. A block that starts with a JSON value (most servers
 * answer that way, often with prose after it) gets the value laid out with a
 * two-space indent, as the engine lays it out, then the rest as output.
 */

import { capped } from './fetch'
import { lf, MAX_COLORED_LINES, type OutputSpan } from './shell'

// Past this a block is left plain: laying out a huge answer on the render path would stall the redraw.
export const MAX_MCP_CHARS = 1_000_000

/** The result's text blocks in their colors, one span list per block. Undefined to leave the row the engine's. */
export function mcpBlocks(output: unknown): OutputSpan[][] | undefined {
  const texts = textBlocks(output)
  if (!texts?.length) return undefined
  const blocks = texts.map(blockSpans)
  if (blocks.every(block => !block.some(span => span.lang))) return undefined
  return capBlocks(blocks)
}

/** The texts of a string result or a list of text blocks; undefined when any block is not text (an image the engine draws). */
function textBlocks(output: unknown): string[] | undefined {
  if (typeof output === 'string') return [output]
  if (!Array.isArray(output)) return undefined
  const texts: string[] = []
  for (const block of output) {
    if (typeof block !== 'object' || block === null) return undefined
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type !== 'text' || typeof text !== 'string') return undefined
    texts.push(text)
  }
  return texts
}

function blockSpans(raw: string): OutputSpan[] {
  const text = lf(raw)
  if (!text.trim() || text.length > MAX_MCP_CHARS || text.includes('\u001b')) return [{ text }]
  const json = leadingJson(text)
  if (!json) return [{ lang: 'output', text: text.replace(/^\n+|\n+$/g, '') }]
  // The text after it keeps its own spacing: `}\n\nprose` draws a blank line between them.
  const rest = text.slice(json.end).replace(/^\n/, '').replace(/\n+$/, '')
  return [{ lang: 'json', text: json.laidOut }, ...(rest.trim() ? [{ lang: 'output' as const, text: rest }] : [])]
}

/**
 * The JSON object or array the text starts with, laid out two spaces deep, and
 * where it ends. Laid out from its own characters, not parsed and printed: a
 * number past 2^53 or a repeated key comes out as the server sent it.
 */
export function leadingJson(text: string): { laidOut: string; end: number } | undefined {
  const start = text.search(/\S/)
  if (start < 0 || (text[start] !== '{' && text[start] !== '[')) return undefined
  let depth = 0
  let end = -1
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      i = stringEnd(text, i)
      if (i < 0) return undefined
    } else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) return undefined
  const source = text.slice(start, end)
  try {
    JSON.parse(source)
  } catch {
    return undefined // a bracket that opens prose, or broken JSON: drawn as output
  }
  return { laidOut: layOut(source), end }
}

/** The index of the quote that closes the string opened at `open`; -1 when none does. */
function stringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return -1
}

/** Valid JSON re-indented two spaces deep, `key: value` with one space, empty `{}` and `[]` kept whole. */
function layOut(source: string): string {
  let out = ''
  let depth = 0
  const newline = () => '\n' + '  '.repeat(depth)
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (c === '"') {
      const close = stringEnd(source, i)
      out += source.slice(i, close + 1)
      i = close
    } else if (c === '{' || c === '[') {
      let next = i + 1 // a scan, not slice-and-search: a copy per bracket would be quadratic on a big answer
      while (next < source.length && /\s/.test(source[next]!)) next++
      if (source[next] === (c === '{' ? '}' : ']')) {
        out += c + source[next]
        i = next
      } else {
        depth++
        out += c + newline()
      }
    } else if (c === '}' || c === ']') {
      depth--
      out += newline() + c
    } else if (c === ',') out += ',' + newline()
    else if (c === ':') out += ': '
    else if (!/\s/.test(c)) out += c
  }
  return out
}

/** Past MAX_COLORED_LINES across all blocks the rest is plain, each block keeping its own gutter. */
function capBlocks(blocks: OutputSpan[][]): OutputSpan[][] {
  let left = MAX_COLORED_LINES
  return blocks.map(block => {
    const lines = block.reduce((n, span) => n + span.text.split('\n').length, 0)
    const out = capped(block, left)
    left = Math.max(left - lines, 0)
    return out
  })
}
