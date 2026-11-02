import { expect, test } from 'claude-code/testing'

import { inlineRuns, leadLabel, luminance, proseBlocks } from './prose'

test('inline code, bold, italic, strike and links become runs', () => {
  expect(inlineRuns('run `npm test` now')).toEqual([{ text: 'run ' }, { text: 'npm test', code: true }, { text: ' now' }])
  expect(inlineRuns('**TL;DR** — done')).toEqual([{ text: 'TL;DR', bold: true }, { text: ' — done' }])
  expect(inlineRuns('**bold `code` here**')).toEqual([
    { text: 'bold ', bold: true }, { text: 'code', bold: true, code: true }, { text: ' here', bold: true },
  ])
  expect(inlineRuns('*it* and _also_ and ~~gone~~')).toEqual([
    { text: 'it', italic: true }, { text: ' and ' }, { text: 'also', italic: true }, { text: ' and ' }, { text: 'gone', strike: true },
  ])
  expect(inlineRuns('see [docs](https://x.dev/a) or https://y.dev/b.')).toEqual([
    { text: 'see ' }, { text: 'docs', href: 'https://x.dev/a' }, { text: ' or ' }, { text: 'https://y.dev/b', href: 'https://y.dev/b' }, { text: '.' },
  ])
})

test('what is not Markdown stays plain', () => {
  expect(inlineRuns('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4' }])
  expect(inlineRuns('snake_case_name and file_path')).toEqual([{ text: 'snake_case_name and file_path' }])
  expect(inlineRuns('\\*not italic\\*')).toEqual([{ text: '*not italic*' }])
  expect(inlineRuns('a ` lone backtick')).toEqual([{ text: 'a ` lone backtick' }])
  expect(inlineRuns('``code with ` inside``')).toEqual([{ text: 'code with ` inside', code: true }])
})

test('a reply in the flow format: header lines, a rule, a paragraph and a list', () => {
  const reply = '**TL;DR** — x.\n**Needs you** — none\n\n---\n\nIt draws:\n- one\n  - nested `a`\n2. two\ncontinued'
  const blocks = proseBlocks(reply)
  expect(blocks.map(block => block.kind)).toEqual(['ours', 'ours', 'ours'])
  const [header, rule, body] = blocks as Extract<(typeof blocks)[number], { kind: 'ours' }>[]
  expect(header!.rows.map(row => (row.kind === 'para' ? leadLabel(row.inline) : row.kind))).toEqual(['TL;DR', 'Needs you'])
  expect(rule!.rows).toEqual([{ kind: 'rule' }])
  expect(body!.rows.map(row => (row.kind === 'item' ? [row.indent, row.marker, row.ordered] : row.kind))).toEqual([
    'para', [0, '-', false], [2, '-', false], [0, '2.', true],
  ])
  // A line after an item continues it.
  expect(body!.rows.at(-1)).toMatchObject({ inline: [{ text: 'two' }, { text: '\n' }, { text: 'continued' }] })
})

test('headings are ours; tables, quotes, HTML, fences and indented code are the engine\'s', () => {
  expect(proseBlocks('## Next\nText')).toMatchObject([{ kind: 'ours', rows: [{ kind: 'heading', level: 2 }, { kind: 'para' }] }])
  expect(proseBlocks('Intro\n\n| a | b |\n| - | - |\n\n> quoted')).toMatchObject([
    { kind: 'ours' }, { kind: 'engine', text: '| a | b |\n| - | - |' }, { kind: 'engine', text: '> quoted' },
  ])
  expect(proseBlocks('Before\n```go\nfunc main() {}\n\nx\n```\nAfter')).toEqual([
    { kind: 'ours', rows: [{ kind: 'para', inline: [{ text: 'Before' }] }] },
    { kind: 'engine', text: '```go\nfunc main() {}\n\nx\n```' },
    { kind: 'ours', rows: [{ kind: 'para', inline: [{ text: 'After' }] }] },
  ])
  expect(proseBlocks('    indented code')[0]?.kind).toBe('engine')
  expect(proseBlocks('<details>x</details>')[0]?.kind).toBe('engine')
})

test('a rule is three or more of one mark; a list item is not a rule', () => {
  expect(proseBlocks('***')[0]).toEqual({ kind: 'ours', rows: [{ kind: 'rule' }] })
  expect(proseBlocks('- - -')[0]).toEqual({ kind: 'ours', rows: [{ kind: 'rule' }] })
  expect(proseBlocks('- x')[0]).toMatchObject({ rows: [{ kind: 'item' }] })
})

test('hex color codes are runs of their own, in that color; issue numbers and anchors are not', () => {
  expect(inlineRuns('bold is #FFB454 now')).toEqual([{ text: 'bold is ' }, { text: '#FFB454', hex: '#FFB454' }, { text: ' now' }])
  expect(inlineRuns('`#ff7a95` and **#f80**')).toEqual([
    { text: '#ff7a95', code: true, hex: '#FF7A95' }, { text: ' and ' }, { text: '#f80', bold: true, hex: '#FF8800' },
  ])
  expect(inlineRuns('issue #123, #48636, page#abcdef, #FFB454AA, &#x27;')).toEqual([{ text: 'issue #123, #48636, page#abcdef, #FFB454AA, &#x27;' }])
  expect(inlineRuns('[see](https://x.dev/#FFB454)')).toEqual([{ text: 'see', href: 'https://x.dev/#FFB454' }])
})

test('luminance runs from black to white', () => {
  expect(luminance('#000000')).toBe(0)
  expect(luminance('#FFFFFF')).toBeGreaterThan(0.999)
  expect(luminance('#300A24')).toBeLessThan(0.06)
  expect(luminance('#26A269')).toBeGreaterThan(0.06)
})

test('a heading keeps a # that is part of it; only a spaced closing run is dropped', () => {
  const heading = (line: string) => {
    const [block] = proseBlocks(line) as unknown as [{ rows: [{ inline: { text: string }[] }] }]
    return block.rows[0].inline.map(run => run.text).join('')
  }
  expect(heading('## Learning C#')).toBe('Learning C#')
  expect(heading('# Issue #12')).toBe('Issue #12')
  expect(heading('## Title ##')).toBe('Title')
  expect(heading('### F# and C# ###  ')).toBe('F# and C#')
})
