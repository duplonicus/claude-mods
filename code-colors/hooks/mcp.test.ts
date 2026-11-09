import { expect, test } from 'claude-code/testing'

import { leadingJson, MAX_MCP_CHARS, mcpBlocks } from './mcp'
import { MAX_COLORED_LINES } from './shell'

// The shape of a Claude Docs read, cut down: a notice block, then JSON with prose after it.
const DOCS_READ = [
  { type: 'text', text: '<artifact-content-authored-by-others/>\nThis result includes Artifact content written by people other than the user.' },
  { type: 'text', text: '{"verdict":"allow","rev":392,"data":{"hits":1,"complete":true},"frame":{"url":"https://claude.ai/artifact/x"}}\n\nThis doc takes suggestions ("tighten", "improve").' },
]

test('a Claude Docs read: each block its own, the JSON laid out, the prose after it as output', () => {
  expect(mcpBlocks(DOCS_READ)).toEqual([
    [{ lang: 'output', text: DOCS_READ[0]!.text }],
    [
      {
        lang: 'json',
        text: '{\n  "verdict": "allow",\n  "rev": 392,\n  "data": {\n    "hits": 1,\n    "complete": true\n  },\n  "frame": {\n    "url": "https://claude.ai/artifact/x"\n  }\n}',
      },
      { lang: 'output', text: '\nThis doc takes suggestions ("tighten", "improve").' },
    ],
  ])
})

test('a string result is one block; plain text is output', () => {
  expect(mcpBlocks('{"results": []}')).toEqual([[{ lang: 'json', text: '{\n  "results": []\n}' }]])
  expect(mcpBlocks('No nodes found.')).toEqual([[{ lang: 'output', text: 'No nodes found.' }]])
})

test('JSON is laid out from its own characters: big numbers, repeated keys and escapes come out as sent', () => {
  expect(leadingJson('{"id":12345678901234567890,"a":1,"a":2}')?.laidOut).toBe('{\n  "id": 12345678901234567890,\n  "a": 1,\n  "a": 2\n}')
  expect(leadingJson('{"s":"a, b: {c} [d] \\"e\\""}')?.laidOut).toBe('{\n  "s": "a, b: {c} [d] \\"e\\""\n}')
  expect(leadingJson('[ {} , [ ] ]')?.laidOut).toBe('[\n  {},\n  []\n]')
  // Already indented: the same layout.
  expect(leadingJson('{\n    "a": [\n        1\n    ]\n}')?.laidOut).toBe('{\n  "a": [\n    1\n  ]\n}')
})

test('a bracket that opens prose or broken JSON is not JSON', () => {
  expect(leadingJson('[link](x) and more')).toBeUndefined()
  expect(leadingJson('{"a": 1')).toBeUndefined()
  expect(leadingJson('{"a": "unclosed}')).toBeUndefined()
  expect(mcpBlocks('[link](x) and more')).toEqual([[{ lang: 'output', text: '[link](x) and more' }]])
})

test('images, odd shapes, escapes and empty results stay the engine\'s', () => {
  expect(mcpBlocks([{ type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'text', text: '{"a":1}' }])).toBeUndefined()
  expect(mcpBlocks(null)).toBeUndefined()
  expect(mcpBlocks({ a: 1 })).toBeUndefined()
  expect(mcpBlocks([])).toBeUndefined()
  expect(mcpBlocks('  \n')).toBeUndefined()
  expect(mcpBlocks('\u001b[31mred')).toBeUndefined()
  expect(mcpBlocks('x'.repeat(MAX_MCP_CHARS + 1))).toBeUndefined()
})

test('the line cap counts every block; the rest is plain', () => {
  const long = Array.from({ length: MAX_COLORED_LINES - 2 }, (_, i) => `line ${i}`).join('\n')
  const blocks = mcpBlocks([{ type: 'text', text: long }, { type: 'text', text: 'a\nb\nc\nd' }])!
  expect(blocks[0]!.map(span => span.lang)).toEqual(['output'])
  expect(blocks[1]).toEqual([{ lang: 'output', text: 'a\nb' }, { text: 'c\nd' }])
})

test('Windows line endings are plain newlines', () => {
  expect(mcpBlocks('{"a":1}\r\n\r\ndone')).toEqual([[{ lang: 'json', text: '{\n  "a": 1\n}' }, { lang: 'output', text: '\ndone' }]])
})
