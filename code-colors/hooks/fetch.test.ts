import { expect, test } from 'claude-code/testing'

import { fetchSpans } from './fetch'
import { MAX_COLORED_LINES } from './shell'

test('a fetched page is Markdown, its front matter YAML', () => {
  expect(fetchSpans('# Title\n\n- item')).toEqual([{ lang: 'markdown', text: '# Title\n\n- item' }])
  expect(fetchSpans('---\nlayout: Conceptual\nmonikers:\n- a\n---\n\n# Manage billing\n\nText')).toEqual([
    { lang: 'yaml', text: '---\nlayout: Conceptual\nmonikers:\n- a\n---' },
    { lang: 'markdown', text: '\n# Manage billing\n\nText' },
  ])
  // A rule inside the page is not front matter.
  expect(fetchSpans('# T\n---\nx: 1\n---')?.map(span => span.lang)).toEqual(['markdown'])
})

test('a JSON answer is JSON; a page that only starts with a bracket stays Markdown', () => {
  expect(fetchSpans('{"a": [1, 2]}')).toEqual([{ lang: 'json', text: '{"a": [1, 2]}' }])
  expect(fetchSpans('[link](x) and more')?.[0]?.lang).toBe('markdown')
})

test('empty or escaped text stays the engine\'s; a long page is colored up to the cap', () => {
  expect(fetchSpans('  \n')).toBeUndefined()
  expect(fetchSpans('\u001b[31mred')).toBeUndefined()
  const long = Array.from({ length: MAX_COLORED_LINES + 5 }, (_, i) => `line ${i}`).join('\n')
  const spans = fetchSpans(long)!
  expect(spans.map(span => [span.lang, span.text.split('\n').length])).toEqual([['markdown', MAX_COLORED_LINES], [undefined, 5]])
  // The cap counts front matter and page together.
  const fronted = fetchSpans(`---\na: 1\n---\n${long}`)!
  expect(fronted.map(span => span.lang)).toEqual(['yaml', 'markdown', undefined])
  expect(fronted.filter(span => span.lang).reduce((n, span) => n + span.text.split('\n').length, 0)).toBe(MAX_COLORED_LINES)
})

test('Windows line endings are drawn as plain newlines', () => {
  expect(fetchSpans('# T\r\n\r\nText')).toEqual([{ lang: 'markdown', text: '# T\n\nText' }])
  expect(fetchSpans('---\r\na: 1\r\n---\r\n# T')?.map(span => span.text)).toEqual(['---\na: 1\n---', '# T'])
})
