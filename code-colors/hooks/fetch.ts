/**
 * fetch.ts: the pure half of coloring a Fetch (WebFetch) result in full. The
 * page comes back as Markdown, often under YAML front matter, or as JSON from
 * an API; register.tsx draws it under the engine's "Received …" line.
 */

import { lf, MAX_COLORED_LINES, type OutputSpan } from './shell'

/** The result in its parts: front matter as YAML, the page as Markdown, or the whole as JSON. Undefined to leave it plain. */
export function fetchSpans(text: string): OutputSpan[] | undefined {
  const result = lf(text)
  if (!result.trim() || result.includes('\u001b')) return undefined
  if (/^\s*[[{]/.test(result)) {
    try {
      JSON.parse(result)
      return capped([{ lang: 'json', text: result }])
    } catch {
      // Not JSON after all: Markdown that starts with a bracket.
    }
  }
  const front = /^---\n[\s\S]*?\n---(?=\n|$)/.exec(result)
  if (!front) return capped([{ lang: 'markdown', text: result }])
  const page = result.slice(front[0].length).replace(/^\n/, '')
  return capped([{ lang: 'yaml', text: front[0] }, ...(page ? [{ lang: 'markdown' as const, text: page }] : [])])
}

/** Past MAX_COLORED_LINES the rest is plain: a long page must not stall a redraw. */
function capped(spans: OutputSpan[]): OutputSpan[] {
  const out: OutputSpan[] = []
  let left = MAX_COLORED_LINES
  for (const span of spans) {
    const lines = span.text.split('\n')
    if (lines.length <= left) {
      out.push(span)
      left -= lines.length
      continue
    }
    if (left > 0) out.push({ ...span, text: lines.slice(0, left).join('\n') })
    out.push({ text: lines.slice(Math.max(left, 0)).join('\n') })
    left = 0
  }
  return out.reduce<OutputSpan[]>((merged, span) => {
    const last = merged.at(-1)
    if (last && !last.lang && !span.lang) last.text += '\n' + span.text
    else merged.push(span)
    return merged
  }, [])
}
