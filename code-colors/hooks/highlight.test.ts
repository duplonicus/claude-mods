import { expect, test } from 'claude-code/testing'

import { colorsLine, DEFAULT_PALETTE, MAX_COLORED_LINE, MAX_SLOW_COLORED_LINE, PALETTES, splitFences, tokenize } from './highlight'
import { LANGUAGES, type Lang } from './languages'

const kindOf = (source: string, lang: 'rust' | 'python', word: string) =>
  tokenize(source, lang).find(token => token.text === word)?.kind

test('keywords, defined names and types get separate kinds', () => {
  const line = 'pub struct FileItem { pub name: String, pub is_dir: bool }'
  expect(kindOf(line, 'rust', 'pub')).toBe('keyword')
  expect(kindOf(line, 'rust', 'FileItem')).toBe('name')
  expect(kindOf(line, 'rust', 'bool')).toBe('type')
  expect(kindOf(line, 'rust', 'String')).toBe('type')
  expect(kindOf('def is_iso(self): return ".iso"', 'python', 'is_iso')).toBe('function')
})

test("the default palette is the Ubuntu Readable scheme", () => {
  expect(DEFAULT_PALETTE).toBe('ubuntu')
  expect(PALETTES.ubuntu.keyword).toBe('#FFB454')
  expect(PALETTES.ubuntu.type).toBe('#3EE0B4')
})

test('a python fence becomes a code segment, prose around it stays prose', () => {
  const segments = splitFences('before\n```python\nclass Mount: pass\n```\nafter')
  expect(segments.map(segment => segment.kind)).toEqual(['prose', 'code', 'prose'])
})

const shape = (markdown: string) => splitFences(markdown).map(segment => (segment.kind === 'code' ? `code:${segment.lang}:${segment.source}` : `prose:${segment.text}`))

test('a bare fence, a text fence and a diff fence are code; a palette after the tag still counts', () => {
  expect(shape('```\nerror: x\n```')).toEqual(['code:output:error: x'])
  expect(shape('```text\ny\n```')).toEqual(['code:output:y'])
  expect(shape('```diff\n-a\n+b\n```')).toEqual(['code:diff:-a\n+b'])
  expect(splitFences('```ts modern\nconst a = 1\n```')).toEqual([{ kind: 'code', lang: 'ts', source: 'const a = 1', palette: 'modern' }])
})

test("the closing fence of a tag we don't know opens nothing", () => {
  const unknown = '```c#\nvar x = 1;\n```\nNow run:\n```bash\nnpm start\n```'
  expect(shape(unknown)).toEqual(['prose:```c#\nvar x = 1;\n```\nNow run:\n', 'code:bash:npm start'])
})

test('a fence inside a longer fence stays in it, whole, for the engine', () => {
  const wrapper = '````markdown\nPaste:\n```\nnpm test\n```\n````'
  expect(shape(wrapper)).toEqual([`prose:${wrapper}`])
  const tagged = '````\n```bash\nnpm test\n```\n````\nafter'
  expect(shape(tagged)).toEqual([`prose:${tagged}`])
})

test('an empty fence closes on the next line and pairs with nothing later', () => {
  expect(shape('```\n```\nmid\n```bash\nls\n```')).toEqual(['code:output:', 'prose:mid\n', 'code:bash:ls'])
})

test('an unclosed fence stays prose, and a tag named like an Object method is no language', () => {
  expect(shape('```\nstreaming')).toEqual(['prose:```\nstreaming'])
  expect(shape('```constructor\nx\n```')).toEqual(['prose:```constructor\nx\n```'])
})

test('a long line is colored up to its language\'s limit, and every language has one', () => {
  const short = 'x'.repeat(MAX_SLOW_COLORED_LINE)
  const long = 'x'.repeat(MAX_COLORED_LINE)
  for (const lang of Object.keys(LANGUAGES) as Lang[]) {
    expect(colorsLine(short, lang)).toBe(true)
    expect(colorsLine(`${long}x`, lang)).toBe(false)
    // One or the other limit, nothing between: a language is measured as fast or it keeps the short one.
    expect(colorsLine(`${short}x`, lang)).toBe(colorsLine(long, lang))
  }
  // What a command prints, and the TOML and JSON it prints, take the long limit; shell and Markdown do not.
  for (const lang of ['output', 'ini', 'json', 'yaml', 'diff'] as const) expect(colorsLine(long, lang)).toBe(true)
  for (const lang of ['bash', 'markdown', 'ts', 'batch', 'powershell', 'html', 'css'] as const) expect(colorsLine(`${short}x`, lang)).toBe(false)
  // Colored at the limit, the text is still all there.
  expect(tokenize(long, 'output').map(token => token.text).join('')).toBe(long)
})
