/**
 * Builds the Code Colors Picker page (index.html) from template.html, with
 * every preview drawn by the mod's own code: the lexers, the reply prose
 * parser, the grep splitter and the diff builder run over the samples below,
 * so the page shows what the mod draws, token for token.
 *
 * Run: bun docs/picker/build.ts   (from code-colors/), then publish index.html.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CHANGED_WORD_TINT, DIFF_TINT, diffRows, summarize } from '../../hooks/diff'
import { PALETTES, splitFences, toLines, tokenize, type Lang, type Token } from '../../hooks/highlight'
import { LABEL_COLORS, leadLabel, PROSE, proseBlocks, type Inline } from '../../hooks/prose'
import { grepLines, splitCommand } from '../../hooks/shell'

type Seg = [string, string]
type Line = { s: Seg[]; c?: string; h?: number }

const here = dirname(new URL(import.meta.url).pathname)
// Claude Code's result gutter is U+23BF, which no web monospace font has: drawn as U+2514, as Windows Terminal shows it.
const GUTTER = '  └  '
const UNDER = '     '

const tokenSegs = (tokens: readonly Token[], extra = ''): Seg[] =>
  tokens.map(({ kind, text, isChanged }) => [[`k-${kind}`, extra, isChanged ? 'changed' : ''].filter(Boolean).join(' '), text])

const codeLines = (source: string, lang: Lang, indent = ''): Line[] =>
  toLines(source, lang).map(tokens => ({ s: [['', indent], ...tokenSegs(tokens)] }))

// --- A reply, drawn as the mod draws reply prose and code blocks -------------

const LABEL_CLASS: Record<string, string> = { 'TL;DR': 'p-tldr', 'Needs you': 'p-needs', 'Next from me': 'p-next' }

function runSegs(runs: readonly Inline[]): Seg[] {
  const label = leadLabel(runs)
  return runs.map((run, i): Seg => {
    if (run.hex) return [`hex:${run.hex}${run.bold ? ' b' : ''}`, run.text]
    const classes = [
      run.code ? 'p-code' : run.href ? 'p-link' : i === 0 && label ? (LABEL_CLASS[label] ?? 'p-bold') : run.bold ? 'p-bold' : '',
      run.bold ? 'b' : '',
      run.italic ? 'i' : '',
      run.strike ? 's' : '',
    ]
    return [classes.filter(Boolean).join(' '), run.text]
  })
}

function replyLines(markdown: string): Line[] {
  const lines: Line[] = []
  const blocks: Line[][] = []
  for (const segment of splitFences(markdown)) {
    if (segment.kind === 'code') {
      blocks.push(codeLines(segment.source, segment.lang))
      continue
    }
    for (const block of proseBlocks(segment.text.trim())) {
      if (block.kind === 'engine') continue // the samples hold none: the engine's own drawing is not the mod's to show
      blocks.push(
        block.rows.map((row): Line => {
          switch (row.kind) {
            case 'rule':
              return { s: [['dim', '─'.repeat(240)]], c: 'rule' }
            case 'heading':
              return { s: runSegs(row.inline).map(([cls, text]) => [`p-heading b ${cls}`, text]) }
            case 'para':
              return { s: runSegs(row.inline) }
            case 'item': {
              const marker = row.ordered ? `${row.marker} ` : '• '
              return { s: [['', ' '.repeat(row.indent)], ['p-marker', marker], ...runSegs(row.inline)], h: row.indent + marker.length }
            }
          }
        }),
      )
    }
  }
  blocks.forEach((block, i) => {
    if (i > 0) lines.push({ s: [['', '']] })
    block.forEach((line, j) => {
      const lead: Seg = i === 0 && j === 0 ? ['bullet', '● '] : ['', '  ']
      lines.push({ ...line, s: [lead, ...line.s], h: (line.h ?? 0) + 2 })
    })
  })
  return lines
}

const REPLY = `**TL;DR** — The picker now covers replies, Bash rows, grep, Fetch and all 16 languages. On \`main\`, 53 tests pass.
**Needs you** — pick the label colors; the default stays #26A269 unless you say otherwise.
**Next from me** — publish it and link it in [ARTIFACTS.md](https://example.com/artifacts).

---

## What changed

The mod draws **bold** in one color, \`inline code\` in another, and *italics* as italics.
- grep rows: prefixes dim, code in its file's language
- Fetch pages: front matter as YAML, the rest as Markdown
  - nested items keep their own marker
1. numbered steps keep their number
2. and wrapped lines hang under the text

\`\`\`ts
export async function load(path: string): Promise<FileItem[]> {
  const res = await fetch(\`/api/files?path=\${path}\`)
  if (res.status !== 200) return [] // empty folder
  return res.json()
}
\`\`\``

// --- Tool rows: Bash (command, grep, cat), Fetch -------------------------------

function header(tool: string, args: Seg[]): Line {
  return { s: [['bullet-ok', '● '], ['b', tool], ['', '('], ...args, ['', ')']] }
}

function commandSegs(command: string): Seg[] {
  return splitCommand(command).flatMap(part => (part.lang ? tokenSegs(tokenize(part.text, part.lang)) : [['', part.text] as Seg]))
}

/** A tool row's header; a command that spans lines (a heredoc) continues under it, indented as the engine does. */
function headerLines(tool: string, command: string): Line[] {
  const lines: Seg[][] = [[]]
  for (const [cls, text] of commandSegs(command)) {
    text.split('\n').forEach((piece, i) => {
      if (i > 0) lines.push([['', '  ']])
      if (piece) lines.at(-1)!.push([cls, piece])
    })
  }
  lines.at(-1)!.push(['', ')'])
  return lines.map((segs, i) => ({ s: i === 0 ? [['bullet-ok', '● '], ['b', tool], ['', '('], ...segs] : segs }))
}

const under = (lines: Line[]): Line[] => lines.map((line, i) => ({ ...line, s: [['dim', i === 0 ? GUTTER : UNDER], ...line.s], h: (line.h ?? 0) + 5 }))

function bashGrep(command: string, stdout: string): Line[] {
  const lines = grepLines(command, stdout) ?? []
  return [
    ...headerLines('Bash', command),
    ...under(lines.map(line => ({ s: [['dim', line.prefix], ...(line.lang ? tokenSegs(tokenize(line.text, line.lang)) : [['', line.text] as Seg])] }))),
  ]
}

const API_TS = `export async function load(path: string) {
  const res = await fetch(\`/api/files?path=\${path}\`)
  if (res.status !== 200) return []`
const GREP_CMD = 'cd ~/app && grep -rn "fetch(" src | head -3'
const GREP_OUT = `src/api.ts:2:  const res = await fetch(\`/api/files?path=\${path}\`)
src/sync.py:14:    resp = await client.fetch(url, timeout=30)
src/db.sql:8:SELECT id, name FROM files WHERE path = $1;`

const NOTES_MD = `# Release notes
Bold is **orange**, inline code is \`pink\`, links go [here](https://example.com).
- one line per change`

const HEREDOC = `python3 - <<'EOF'
import json, pathlib
print(len(json.loads(pathlib.Path("data.json").read_text())))
EOF`

const FETCH_PAGE = `---
title: Manage recurring billing
ms.date: 2026-09-03
recommendations: false
---

# Manage recurring billing
1. Go to the **Billing** page and select \`Edit recurring billing\`.`

function fetchRow(): Line[] {
  const [front, page] = FETCH_PAGE.split(/(?<=---)\n\n/)
  return [
    header('Fetch', [['', 'url: "https://learn.microsoft.com/…/renew-your-subscription"']]),
    { s: [['dim', GUTTER], ['', 'Received '], ['b', '6.7KB'], ['', ' (200 OK)']] },
    ...codeLines(front!, 'yaml'),
    { s: [['', '']] },
    ...codeLines(page!, 'markdown'),
  ]
}

const TOOLS: Line[] = [
  ...bashGrep(GREP_CMD, GREP_OUT),
  // A mixed chain: each printed file is found in the output and drawn in its language.
  ...headerLines('Bash', 'sed -n 1,3p src/api.ts; cat NOTES.md'),
  ...under([...codeLines(API_TS, 'ts'), ...codeLines(NOTES_MD, 'markdown')]),
  ...headerLines('Bash', HEREDOC),
  ...under([{ s: [['', '412']] }]),
  ...fetchRow(),
]

// --- An Edit diff --------------------------------------------------------------

function editRows(): Line[] {
  const hunks = [{
    oldStart: 12, oldLines: 4, newStart: 12, newLines: 5,
    lines: [
      ' export async function load(path: string) {',
      '-  const res = await fetch(`/files?path=${path}`)',
      '+  const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`)',
      '+  // a missing folder answers 404',
      '   if (res.status !== 200) return []',
      '   return res.json()',
    ],
  }]
  const rows = diffRows(hunks, 'ts')
  const width = Math.max(...rows.map(row => (row.kind === 'gap' ? 0 : String(row.lineNo).length)))
  const SIGN = { add: '+', remove: '-', context: ' ' } as const
  return [
    header('Update', [['b', 'src/api.ts']]),
    { s: [['dim', GUTTER], ['', summarize(rows)]] },
    ...rows.map((row): Line => {
      if (row.kind === 'gap') return { s: [['dim', `      ${' '.repeat(width)} ...`]] }
      const tint = row.kind === 'context' ? '' : `w-${row.kind}`
      return {
        c: row.kind === 'context' ? undefined : `d-${row.kind}`,
        s: [['', '      '], ['dim', `${String(row.lineNo).padStart(width)} ${SIGN[row.kind]} `], ...tokenSegs(row.tokens).map(([cls, text]): Seg => [cls.includes('changed') && tint ? `${cls} ${tint}` : cls, text])],
      }
    }),
  ]
}

// --- Every language the mod has a lexer for -------------------------------------

const SAMPLES: [Lang, string, string][] = [
  ['ts', 'TypeScript', `interface FileItem { name: string; size?: number }
export const isIso = (f: FileItem): boolean => f.name.endsWith('.iso')
const MAX = 300 // lines colored before plain`],
  ['python', 'Python', `@dataclass
class FileItem:
    name: str
    size: int | None = None  # bytes

    def is_iso(self) -> bool:
        return self.name.lower().endswith(".iso")`],
  ['rust', 'Rust', `pub struct FileItem { pub name: String, pub size: Option<u64> }

impl FileItem {
    fn is_iso(&self) -> bool { self.name.ends_with(".iso") } // case-sensitive
}`],
  ['bash', 'Bash', `for f in ~/dev/*/NOW.md; do
  [ -s "$f" ] && echo "$(basename "$(dirname "$f")"): $(wc -l < "$f") lines"
done # 2>/dev/null`],
  ['sql', 'SQL', `-- files changed this week
SELECT path, COUNT(*) AS edits
FROM changes WHERE at > NOW() - INTERVAL '7 days'
GROUP BY path ORDER BY edits DESC LIMIT 10;`],
  ['surql', 'SurrealQL', `-- open threads past their review date
SELECT text, project FROM entry
WHERE kind = 'thread' AND review_by < time::now()
FETCH project;`],
  ['powershell', 'PowerShell', `# register the nightly task
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument '-File C:\\jobs\\nightly.ps1'
Register-ScheduledTask -TaskName 'Nightly' -Action $action -Force | Out-Null`],
  ['batch', 'Batch', `@echo off
rem copy the build to the share
for %%f in (dist\\*.zip) do copy /y "%%f" \\\\nas\\builds\\
if errorlevel 1 exit /b 1`],
  ['c', 'C / C++', `#include <stdio.h>
// count lines on stdin
int main(void) {
    int c, n = 0;
    while ((c = getchar()) != EOF) if (c == '\\n') n++;
    printf("%d\\n", n);
    return 0;
}`],
  ['hcl', 'Terraform', `resource "aws_s3_bucket" "backups" {
  bucket = "demo-backups"
  # keep 30 days of versions
  lifecycle_rule { enabled = true }
}`],
  ['yaml', 'YAML', `services:
  ollama:
    image: ollama/ollama:0.5.4  # pinned
    ports: ["11434:11434"]
    restart: unless-stopped`],
  ['ini', 'TOML / INI', `[project]
name = "demo-helper"
version = "0.4.2"
requires-python = ">=3.12"  # uv picks it up`],
  ['json', 'JSON', `{
  "name": "code-colors",
  "version": "0.9.0",
  "private": true,
  "languages": 16
}`],
  ['markdown', 'Markdown', `## Next
- flip the repo **public** after the review
- run \`claude plugin test\` before pushing
> see [NOW.md](NOW.md)`],
  ['html', 'HTML', `<!-- the picker's preview -->
<pre class="term" id="reply" aria-label="Reply preview"></pre>
<button type="button" class="ghost">Reset</button>`],
  ['css', 'CSS', `:root { --term-bg: #300A24; }
pre.term {
  background: var(--term-bg);
  font: 17px/1.5 "Ubuntu Mono", monospace;
}`],
]

// --- Colors the mod uses today, and the presets ---------------------------------

const TEXT = '#FFFFFF'
const presets = Object.fromEntries(
  (['ubuntu', 'github', 'modern', 'minimal'] as const).map(name => {
    const palette = PALETTES[name]
    const code = Object.fromEntries((['keyword', 'name', 'type', 'function', 'string', 'number', 'comment'] as const).map(kind => [kind, palette[kind] ?? TEXT]))
    return [name, code]
  }),
)

const DATA = {
  presets,
  prose: { bold: PROSE.bold, code: PROSE.code, link: PROSE.link, marker: PROSE.marker, heading: PROSE.heading, tldr: LABEL_COLORS['TL;DR'], needs: LABEL_COLORS['Needs you'], next: LABEL_COLORS['Next from me'] },
  diff: { add: DIFF_TINT.add, remove: DIFF_TINT.remove, addWord: CHANGED_WORD_TINT.add, removeWord: CHANGED_WORD_TINT.remove },
  scenes: { reply: replyLines(REPLY), tools: TOOLS, edit: editRows() },
  languages: SAMPLES.map(([lang, label, source]) => ({ lang, label, lines: codeLines(source, lang) })),
}

const template = readFileSync(join(here, 'template.html'), 'utf8')
const json = JSON.stringify(DATA).replace(/</g, '\\u003c')
writeFileSync(join(here, 'index.html'), template.replace('/*DATA*/null', json))
console.log(`index.html: ${DATA.scenes.reply.length} reply lines, ${DATA.scenes.tools.length} tool lines, ${DATA.languages.length} languages`)
