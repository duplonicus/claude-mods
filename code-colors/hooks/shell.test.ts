import { expect, test } from 'claude-code/testing'

import { MAX_COLORED_LINE, tokenize, type Lang } from './highlight'
import { bashRow, commandTokens, EDIT_NOTES, filePrints, grepLines, MAX_COLORED_LINES, outputLang, outputLines, printedText, printSpans, splitCommand } from './shell'

const kinds = (source: string) => tokenize(source, 'bash').filter(token => token.text.trim()).map(token => [token.text.trim(), token.kind])

test('commands, flags, strings, variables and chains get their own kinds', () => {
  expect(kinds('git log --oneline -5 && echo "$HOME" | wc -l # count')).toEqual([
    ['git', 'function'], ['log', 'plain'], ['--oneline', 'type'], ['-5', 'type'], ['&&', 'keyword'],
    ['echo', 'function'], ['"$HOME"', 'string'], ['|', 'keyword'], ['wc', 'function'], ['-l', 'type'], ['# count', 'comment'],
  ])
})

test('an assignment before a command, a redirect, and a # inside a word', () => {
  expect(kinds('TZ=America/Toronto date 2>&1 a#b')).toEqual([
    ['TZ=America/Toronto', 'name'], ['date', 'function'], ['2>&1', 'punct'], ['a#b', 'plain'],
  ])
  expect(kinds('for f in *.py; do echo $f; done').filter(([, kind]) => kind === 'keyword').map(([text]) => text)).toEqual(['for', ';', 'do', ';', 'done'])
})

test('tokens join back to the command exactly', () => {
  const command = `cd ~/x && sed -n '1,40p' a.ts | head -5 > /tmp/o 2>/dev/null; echo \${A:-b} $(pwd)`
  expect(tokenize(command, 'bash').map(token => token.text).join('')).toBe(command)
})

test("a heredoc body is split out in its reader's language", () => {
  const command = "python3 - <<'EOF'\nimport os\nprint(os.sep)\nEOF\necho done"
  const parts = splitCommand(command)
  expect(parts.map(part => part.lang)).toEqual(['bash', 'python', undefined, 'bash'])
  expect(parts[2]?.text).toBe('EOF')
  expect(parts[1]?.text).toBe('import os\nprint(os.sep)\n')
  expect(parts.map(part => part.text).join('')).toBe(command)
  expect(splitCommand('cat > notes.ts <<EOF\nconst a = 1\nEOF').map(part => part.lang)).toEqual(['bash', 'ts', undefined])
  expect(splitCommand('git commit -F - <<EOF\nfeat: x\nEOF').map(part => part.lang)).toEqual(['bash', undefined, undefined])
  const tabbed = 'cat <<-EOF\n\tx\n\tEOF\nls'
  expect(splitCommand(tabbed).map(part => part.text)).toEqual(['cat <<-EOF\n', '\tx\n', '\tEOF', '\nls'])
  // A here-string is not a heredoc, even with a line that matches.
  expect(splitCommand('tr a-z A-Z <<<"str"\nstr').map(part => part.lang)).toEqual(['bash'])
  // No closing line: no body, all shell.
  expect(splitCommand('cat <<EOF\nnever closed').map(part => part.lang)).toEqual(['bash'])
})

test('output is in a language only when every print is a plain print of such files', () => {
  expect(outputLang('cat sample.py')).toBe('python')
  expect(outputLang("cd ~/repo && sed -n '10,40p' src/a.ts | head -20")).toBe('ts')
  expect(outputLang('head -n 40 a.rs 2>/dev/null')).toBe('rust')
  expect(outputLang('tail -n +5 main.tf')).toBe('hcl')
  expect(outputLang('cat -n a.py')).toBe('python')
  expect(outputLang('cat a.py b.ts')).toBeUndefined() // two languages
  expect(outputLang('grep -n def a.py')).toBeUndefined()
  expect(outputLang('cat a.py | grep def')).toBe('python') // still lines of a.py
  expect(outputLang('sed -i s/a/b/ a.py')).toBeUndefined()
  expect(outputLang('cat notes.md')).toBe('markdown')
  expect(outputLang('cat notes.txt')).toBeUndefined()
  expect(outputLang('cat a.py && ls')).toBeUndefined()
  expect(outputLang('cat $(git ls-files)')).toBeUndefined()
})

const done = (stdout: string, extra: Record<string, unknown> = {}) => ({
  input: { command: 'cat a.py' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...extra },
})

test('a plain finished row is ours; running, background, git and escape rows stay the engine\'s', () => {
  expect(bashRow(done('x = 1'))).toEqual({ bullet: 'success', command: [{ lang: 'bash', text: 'cat a.py' }], output: { lang: 'python', colored: 'x = 1' }, edits: [] })
  expect(bashRow(done('')))?.toMatchObject({ output: { colored: '(No output)', color: 'inactive' } })
  expect(bashRow({ ...done('x'), isRunning: true, output: undefined })).toEqual({ bullet: 'running', command: [{ lang: 'bash', text: 'cat a.py' }], edits: [] })
  expect(bashRow({ ...done('x'), isRunning: true, input: { command: '' } })).toBeUndefined() // still being written
  // Written but not started yet (its PreToolUse hooks are running): the same header.
  expect(bashRow({ ...done('x'), output: undefined })?.bullet).toBe('running')
  expect(bashRow({ ...done('x'), isInterrupted: true })).toBeUndefined()
  expect(bashRow(done('x', { backgroundTaskId: 'b1' }))).toBeUndefined()
  expect(bashRow(done('x', { gitOperation: { push: { branch: 'main' } } }))).toBeUndefined()
  expect(bashRow(done('\u001b[31mred\u001b[0m'))).toBeUndefined()
  expect(bashRow({ ...done('x'), input: {} })).toBeUndefined()
})

test('a row whose output was saved to a file, or that ended on an exit-code note, is ours', () => {
  // The engine draws nothing of its own for either (its Bash result renderer, 2.1.322): the output it kept is all there is.
  const plain = bashRow(done('x = 1'))
  expect(plain?.output).toEqual({ lang: 'python', colored: 'x = 1' })
  expect(bashRow(done('x = 1', { persistedOutputPath: '/p/tool-results/a.txt', persistedOutputSize: 93334 }))).toEqual(plain)
  expect(bashRow(done('x = 1', { returnCodeInterpretation: 'Files differ' }))).toEqual(plain)
  // With nothing printed, the engine's one dim line is the note, else "Done" for a command that prints nothing, else "(No output)".
  const note = (extra: Record<string, unknown>) => bashRow(done('', extra))?.output
  expect(note({ returnCodeInterpretation: 'No matches found' })).toEqual({ lang: undefined, colored: 'No matches found', color: 'inactive' })
  expect(note({ returnCodeInterpretation: 'No matches found', noOutputExpected: true })).toEqual({ lang: undefined, colored: 'No matches found', color: 'inactive' })
  expect(note({ noOutputExpected: true })).toEqual({ lang: undefined, colored: 'Done', color: 'inactive' })
  expect(note({})).toEqual({ lang: undefined, colored: '(No output)', color: 'inactive' })
  expect(note({ returnCodeInterpretation: '' })).toEqual({ lang: undefined, colored: '(No output)', color: 'inactive' })
  // A saved output is cut mid-line where the engine stopped keeping it: still drawn line by line, nothing lost.
  const cut = bashRow({ ...done('512 notes.md\n66:  { id = "t12", note = "a -> b', { persistedOutputPath: '/p/a.txt', persistedOutputSize: 93334 }), input: { command: 'wc -c notes.md && grep -n k board.toml | head -30' } })
  expect(cut?.output?.lines?.map(line => line.prefix + line.text).join('\n')).toBe('512 notes.md\n66:  { id = "t12", note = "a -> b')
  expect(cut?.output?.lines?.[1]).toEqual({ prefix: '66:', lang: 'ini', text: '  { id = "t12", note = "a -> b' })
  // Rows the engine does add a part to stay its.
  for (const field of ['backgroundTaskId', 'gitOperation', 'structuredContent', 'timedOutAfterMs', 'backgroundCwdHint', 'rawOutputPath']) expect(bashRow(done('x', { [field]: 'y' }))).toBeUndefined()
})

test('an errored row draws the text the model read, in the error color', () => {
  const row = bashRow({ input: { command: 'false' }, isRunning: false, isErrored: true, isInterrupted: false, output: 'Error: Exit code 1' })
  expect(row).toMatchObject({ bullet: 'error', output: { colored: 'Error: Exit code 1', color: 'error' } })
})

test('past the cap the output is drawn plain', () => {
  const stdout = Array.from({ length: MAX_COLORED_LINES + 2 }, (_, i) => `x${i} = ${i}`).join('\n')
  const row = bashRow(done(stdout))
  expect(row?.output?.colored.split('\n').length).toBe(MAX_COLORED_LINES)
  expect(row?.output?.rest?.split('\n').length).toBe(2)
})

const CWD = '\nShell cwd was reset to /home/me/repo'
const changed = (filePath: string, extra: Record<string, unknown> = {}) => ({
  filePath,
  hunks: [{ oldStart: 9, oldLines: 1, newStart: 9, newLines: 2, lines: [' class Thing:', '+x = 1'] }],
  ...extra,
})

test("the engine's cwd note is a block of its own; with no output, there is no (No output)", () => {
  expect(bashRow(done('hi', { stderr: CWD }))).toMatchObject({ output: { colored: 'hi' }, cwdNote: 'Shell cwd was reset to /home/me/repo' })
  const quiet = bashRow(done('', { stderr: CWD }))
  expect(quiet?.output).toBeUndefined()
  expect(quiet?.cwdNote).toBe('Shell cwd was reset to /home/me/repo')
  // Any other stderr stays the engine's.
  expect(bashRow(done('hi', { stderr: 'warning: x' }))).toBeUndefined()
})

test('files the command changed come as Edit-style diffs, with the note under them', () => {
  const row = bashRow(done('', { bashEditDiff: { files: [changed('/r/a.py'), changed('/r/new.txt', { created: true })], moreFiles: 0 } }))
  expect(row?.output).toBeUndefined()
  expect(row?.edits.map(edit => [edit.verb, edit.filePath, edit.added, edit.removed])).toEqual([
    ['Updated', '/r/a.py', 1, 0],
    ['Created', '/r/new.txt', 1, 0],
  ])
  expect(row?.edits[0]?.rows.map(r => (r.kind === 'gap' ? 'gap' : `${r.kind}:${r.lineNo}`))).toEqual(['context:9', 'add:10'])
  // A text file is in the output colors on the tints; code we have no lexer for is plain text on them.
  expect(row?.edits[1]?.rows[1]).toMatchObject({ kind: 'add', tokens: [{ kind: 'plain', text: 'x = ' }, { kind: 'number', text: '1' }] })
  const go = bashRow(done('', { bashEditDiff: { files: [changed('/r/main.go')], moreFiles: 0 } }))
  expect(go?.edits[0]?.rows[1]).toMatchObject({ kind: 'add', tokens: [{ kind: 'plain', text: 'x = 1' }] })
  expect(row?.editNote).toBe(EDIT_NOTES.files)
})

test('an empty edit record draws only its note; records not seen drawn stay the engine\'s', () => {
  expect(bashRow(done('ok', { bashEditDiff: { files: [], moreFiles: 0, unavailable: true } }))).toMatchObject({ edits: [], editNote: EDIT_NOTES.unavailable })
  expect(bashRow(done('', { bashEditDiff: { files: [], moreFiles: 0, shared: true } }))).toMatchObject({ editNote: EDIT_NOTES.shared })
  expect(bashRow(done('', { bashEditDiff: { files: [], moreFiles: 0, shared: true } }))?.output).toBeUndefined()
  expect(bashRow(done('', { bashEditDiff: { files: [], moreFiles: 0, skipped: true } }))).toBeUndefined()
  expect(bashRow(done('', { bashEditDiff: { files: [changed('/r/a.py')], moreFiles: 2 } }))).toBeUndefined()
  expect(bashRow(done('', { bashEditDiff: { files: [changed('/r/a.py', { deleted: true })], moreFiles: 0 } }))).toBeUndefined()
  expect(bashRow(done('', { bashEditDiff: { files: [changed('/r/a.py')], moreFiles: 0, shared: true } }))).toBeUndefined()
  expect(bashRow(done('', { bashEditDiff: { files: [], moreFiles: 0 } }))).toBeUndefined()
})

// Plain tokens merge with the spaces around them, so a plain word is found inside its run.
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const pick = (source: string, lang: Lang, text: string) =>
  tokenize(source, lang).find(
    token => token.text === text || (token.kind === 'plain' && new RegExp(`(^|[\\s>'])${escaped(text)}($|[\\s<:])`).test(token.text)),
  )?.kind

test('html: tags, attributes and their strings; quotes in page text stay text', () => {
  const html = `<a href="x.html" class='big'>don't "panic"</a>`
  expect(pick(html, 'html', '<a')).toBe('keyword')
  expect(pick(html, 'html', 'href')).toBe('type')
  expect(pick(html, 'html', '"x.html"')).toBe('string')
  expect(pick(html, 'html', "'big'")).toBe('string')
  expect(pick(html, 'html', '"panic"')).toBe('plain')
  expect(pick(html, 'html', '</a')).toBe('keyword')
  expect(tokenize(html, 'html').map(token => token.text).join('')).toBe(html)
})

test('css, alone or inside <style>: properties, custom properties, functions, colors, sizes', () => {
  const css = ':root { --ground: #1c0716; }\nmain { padding-left: max(16px, 1rem); }\na:hover { color: var(--ground) }\n@media (max-width: 600px) {}'
  for (const [source, lang] of [[css, 'css'], [`<style>\n${css}\n</style>`, 'html']] as const) {
    expect(pick(source, lang, '--ground')).toBe('name')
    expect(pick(source, lang, '#1c0716')).toBe('number')
    expect(pick(source, lang, 'padding-left')).toBe('type')
    expect(pick(source, lang, 'max')).toBe('function')
    expect(pick(source, lang, '16px')).toBe('number')
    expect(pick(source, lang, 'a')).toBe('plain') // a selector, not a property
    expect(pick(source, lang, '@media')).toBe('keyword')
  }
})

test('json: keys, strings, numbers, literals', () => {
  const json = '{ "name": "code-colors", "version": 3, "ok": true }'
  expect(pick(json, 'json', '"name"')).toBe('type')
  expect(pick(json, 'json', '"code-colors"')).toBe('string')
  expect(pick(json, 'json', '3')).toBe('number')
  expect(pick(json, 'json', 'true')).toBe('keyword')
})

test("a heredoc into an .html file is colored as HTML, and cat of a .json file as JSON", () => {
  expect(splitCommand("cat > template.html <<'EOF'\n<title>x</title>\nEOF").map(part => part.lang)).toEqual(['bash', 'html', undefined])
  expect(outputLang('cat .claude-plugin/plugin.json')).toBe('json')
})

test('powershell: cmdlets, parameters vs operators, variables, types, strings, comments', () => {
  const ps = `# 16 - a GPO\n$ErrorActionPreference = 'Stop'\nif (-not (Get-GPO -Name $name -ErrorAction SilentlyContinue)) { New-GPLink -Target $env:USERDOMAIN }\n[string]$x = "a ""b"" \`n" ; $true`
  expect(pick(ps, 'powershell', '# 16 - a GPO')).toBe('comment')
  expect(pick(ps, 'powershell', '$ErrorActionPreference')).toBe('name')
  expect(pick(ps, 'powershell', "'Stop'")).toBe('string')
  expect(pick(ps, 'powershell', 'if')).toBe('keyword')
  expect(pick(ps, 'powershell', '-not')).toBe('keyword')
  expect(pick(ps, 'powershell', 'Get-GPO')).toBe('function')
  expect(pick(ps, 'powershell', '-Name')).toBe('type')
  expect(pick(ps, 'powershell', '$env:USERDOMAIN')).toBe('name')
  expect(pick(ps, 'powershell', '[string]')).toBe('type')
  expect(pick(ps, 'powershell', '"a ""b"" `n"')).toBe('string')
  expect(pick(ps, 'powershell', '$true')).toBe('keyword')
  expect(tokenize(ps, 'powershell').map(token => token.text).join('')).toBe(ps)
})

test("a heredoc's language comes from its own command, not another command's redirect on the line", () => {
  const command = "find ~/p -name '*.jsonl' > /tmp/list.txt; wc -l < /tmp/list.txt; python3 - <<'EOF'\nimport json\nEOF"
  expect(splitCommand(command).map(part => part.lang)).toEqual(['bash', 'python', undefined])
  expect(splitCommand("echo x > a.txt && cat > b.py <<EOF\nx = 1\nEOF").map(part => part.lang)).toEqual(['bash', 'python', undefined])
})

test('a heredoc into a .ps1 file is colored as PowerShell', () => {
  expect(splitCommand("cd ~/lab && cat > 16-staff-gpo.ps1 <<'EOF'\nNew-GPO -Name $n\nEOF").map(part => part.lang)).toEqual(['bash', 'powershell', undefined])
})

test('markdown: headings, inline code, bold, links, list markers, quotes, fences', () => {
  const md = '# NOW: mods\n## State\n- **jump-to-prompts** works, see [README](README.md)\n> a quote\n1. run `claude plugin test`\n```bash\nls\n```'
  expect(pick(md, 'markdown', '# NOW: mods')).toBe('number')
  expect(pick(md, 'markdown', '## State')).toBe('number')
  expect(pick(md, 'markdown', '-')).toBe('number')
  expect(pick(md, 'markdown', '**jump-to-prompts**')).toBe('keyword')
  expect(pick(md, 'markdown', '[README](README.md)')).toBe('function')
  expect(pick(md, 'markdown', '> a quote')).toBe('comment')
  expect(pick(md, 'markdown', '`claude plugin test`')).toBe('name')
  expect(pick(md, 'markdown', '```bash\nls\n```')).toBe('string')
  expect(tokenize(md, 'markdown').map(token => token.text).join('')).toBe(md)
  // A # inside a line is not a heading.
  expect(tokenize('see issue #48636', 'markdown').every(token => token.kind === 'plain')).toBe(true)
})

test('yaml: keys, strings, literals, comments, anchors', () => {
  const yaml = "services:\n  web:\n    image: 'caddy:2' # pinned\n    restart: true\n    ports: [80, 443]\n    <<: *defaults"
  expect(pick(yaml, 'yaml', 'services')).toBe('type')
  expect(pick(yaml, 'yaml', 'image')).toBe('type')
  expect(pick(yaml, 'yaml', "'caddy:2'")).toBe('string')
  expect(pick(yaml, 'yaml', '# pinned')).toBe('comment')
  expect(pick(yaml, 'yaml', 'true')).toBe('keyword')
  expect(pick(yaml, 'yaml', '443')).toBe('number')
  expect(pick(yaml, 'yaml', '*defaults')).toBe('name')
})

test('ini and toml: sections, keys, values, comments (systemd units, .wslconfig, pyproject)', () => {
  const unit = '[Unit]\nDescription=Nightly review\n# runs at 4:30\n[Timer]\nOnCalendar=*-*-* 04:30\nPersistent=true'
  expect(pick(unit, 'ini', '[Unit]')).toBe('keyword')
  expect(pick(unit, 'ini', 'Description')).toBe('type')
  expect(pick(unit, 'ini', '# runs at 4:30')).toBe('comment')
  expect(pick(unit, 'ini', 'true')).toBe('keyword')
  const toml = '[project]\nname = "code-colors"\nversion = 3\n[[tool.x]]'
  expect(pick(toml, 'ini', 'name')).toBe('type')
  expect(pick(toml, 'ini', '"code-colors"')).toBe('string')
  expect(pick(toml, 'ini', '[[tool.x]]')).toBe('keyword')
  // A word in a value is not a key, even before another `=`.
  expect(tokenize('ExecStart=/usr/bin/env FOO=1 run', 'ini').some(token => token.text === 'FOO' && token.kind === 'type')).toBe(false)
})

test('surrealql: SQL and SurrealQL keywords, functions, params, record links', () => {
  const surql = "DEFINE FUNCTION fn::waiting_on($who: string) { RETURN SELECT * FROM entry WHERE ->about->project; }; -- note"
  expect(pick(surql, 'surql', 'DEFINE')).toBe('keyword')
  expect(pick(surql, 'surql', 'fn::waiting_on')).toBe('function')
  expect(pick(surql, 'surql', '$who')).toBe('name')
  expect(pick(surql, 'surql', 'string')).toBe('type')
  expect(pick(surql, 'surql', 'SELECT')).toBe('keyword')
  expect(pick(surql, 'surql', '-- note')).toBe('comment')
})

test('batch: rem and :: comments, labels, %variables%, switches, keywords', () => {
  const bat = '@echo off\nrem start the bot\n:: also a comment\nset PORT=%1\nif not exist "%~dp0bot.exe" goto :fail\ndir /b\n:fail'
  expect(pick(bat, 'batch', 'rem start the bot')).toBe('comment')
  expect(pick(bat, 'batch', ':: also a comment')).toBe('comment')
  expect(pick(bat, 'batch', '%1')).toBe('name')
  expect(pick(bat, 'batch', 'if')).toBe('keyword')
  expect(pick(bat, 'batch', '"%~dp0bot.exe"')).toBe('string')
  expect(pick(bat, 'batch', '/b')).toBe('type')
  expect(tokenize(bat, 'batch').filter(token => token.text.trim() === ':fail').map(token => token.kind)).toEqual(['function', 'function'])
})

test('c family: preprocessor, types, keywords, names, calls, for C, C#, Swift and GLSL', () => {
  const c = '#include <stdio.h>\nstatic int add(int a, int b) { return a + b; } // sum'
  expect(pick(c, 'c', '#include')).toBe('keyword')
  expect(pick(c, 'c', 'int')).toBe('type')
  expect(pick(c, 'c', 'static')).toBe('keyword')
  expect(pick(c, 'c', 'add')).toBe('function')
  expect(pick(c, 'c', '// sum')).toBe('comment')
  expect(pick('public class Mount : IDisposable { }', 'c', 'Mount')).toBe('name')
  expect(pick('guard let x = y else { return }', 'c', 'guard')).toBe('keyword')
  expect(pick('uniform vec3 color;', 'c', 'vec3')).toBe('type')
})

test('files are recognized by extension, dotfile name, and unit type', () => {
  for (const [path, lang] of [
    ['NOW.md', 'markdown'], ['compose.yml', 'yaml'], ['pyproject.toml', 'ini'], ['nightly.timer', 'ini'],
    ['/mnt/c/Users/x/.wslconfig', 'ini'], ['~/.bash_profile', 'bash'], ['~/.bashrc', 'bash'], ['schema.surql', 'surql'],
    ['start.cmd', 'batch'], ['main.cpp', 'c'], ['Window.cs', 'c'], ['App.swift', 'c'], ['shade.frag', 'c'], ['nb.ipynb', 'json'],
  ] as const) expect(outputLang(`cat ${path}`)).toBe(lang)
})

test("a mixed command's file prints are listed with their lines and the folder a cd moved to", () => {
  expect(filePrints('tmux ls 2>&1 | head -2; cd ~/.claude && git status --short mods/ | head; cat ~/.claude/mods/NOW.md')).toEqual([
    { path: '~/.claude/mods/NOW.md', dir: '~/.claude', lang: 'markdown', picks: [] },
  ])
  expect(filePrints("cd ~/m/code-colors && sed -n 1,22p hooks/shell.ts; grep -n x hooks/shell.ts | head -40")).toEqual([
    { path: 'hooks/shell.ts', dir: '~/m/code-colors', lang: 'ts', picks: [{ from: 1, to: 22 }] },
  ])
  expect(filePrints('head -n 5 a.py; tail -3 b.rs; tail -n +4 c.tf; sed -n 7p d.sh')).toEqual([
    { path: 'a.py', lang: 'python', picks: [{ from: 1, to: 5 }] },
    { path: 'b.rs', lang: 'rust', picks: [{ last: 3 }] },
    { path: 'c.tf', lang: 'hcl', picks: [{ from: 4, to: Infinity }] },
    { path: 'd.sh', lang: 'bash', picks: [{ from: 7, to: 7 }] },
  ])
  // Text changed (line numbers, a grep after it), two files, or a substitution: not a print to find.
  expect(filePrints('cat -n a.py; cat a.py | grep x; cat a.py b.py; ls; cat $(ls)')).toEqual([])
  expect(filePrints('cd a && cd b && cat x.ts')[0]?.dir).toBe('a/b')
})

test('the printed text is the picked lines, trailing newline trimmed', () => {
  const file = 'one\ntwo\nthree\nfour\n'
  expect(printedText(file, [])).toBe('one\ntwo\nthree\nfour')
  expect(printedText(file, [{ from: 2, to: 3 }])).toBe('two\nthree')
  expect(printedText(file, [{ last: 2 }])).toBe('three\nfour')
  expect(printedText(file, [{ from: 1, to: 3 }, { last: 1 }])).toBe('three') // head -3 | tail -1
})

test('a printed text found whole on its own lines is colored, the output around it plain', () => {
  const stdout = "ls: cannot access '/x': No such file\n# NOW\n- item\nafter"
  expect(printSpans(stdout, [{ lang: 'markdown', text: '# NOW\n- item' }])).toEqual([
    { text: "ls: cannot access '/x': No such file" },
    { lang: 'markdown', text: '# NOW\n- item' },
    { text: 'after' },
  ])
  // First in the output, then grep's lines.
  expect(printSpans('a = 1\nhooks/x.py:1:a', [{ lang: 'python', text: 'a = 1' }])).toEqual([{ lang: 'python', text: 'a = 1' }, { text: 'hooks/x.py:1:a' }])
  // Changed since it was printed, or only part of a line: plain.
  expect(printSpans('# NOW\n- old', [{ lang: 'markdown', text: '# NOW\n- new' }])).toBeUndefined()
  expect(printSpans('xa = 1', [{ lang: 'python', text: 'a = 1' }])).toBeUndefined()
  // Found in command order: the second print is looked for after the first.
  expect(printSpans('b\na\nb', [{ lang: 'python', text: 'a' }, { lang: 'ts', text: 'b' }])?.map(span => span.lang)).toEqual([undefined, 'python', 'ts'])
})

test('a CRLF file or output is drawn with plain newlines, and its print is still found', () => {
  expect(bashRow(done('x = 1\r\ny = 2'))?.output?.colored).toBe('x = 1\ny = 2')
  expect(printedText('a\r\nb\r\n', [])).toBe('a\nb')
  expect(printSpans('ls: x\na\nb', [{ lang: 'python', text: printedText('a\r\nb\r\n', []) }])?.map(span => span.lang)).toEqual([undefined, 'python'])
})

test("a grep of one file: line-number prefixes apart, the code in the file's language", () => {
  const out = '124:const MARKDOWN_RULES: Rule[] = [\n125-  { kind: \'comment\' },\n--\n200:x'
  expect(grepLines('cd ~/m && grep -n "const MARKDOWN_RULES" -A14 hooks/languages.ts', out)).toEqual([
    { prefix: '124:', lang: 'ts', text: 'const MARKDOWN_RULES: Rule[] = [' },
    { prefix: '125-', lang: 'ts', text: "  { kind: 'comment' }," },
    { prefix: '--', text: '' },
    { prefix: '200:', lang: 'ts', text: 'x' },
  ])
  // No -n: the whole line is code, even one that starts like a line number.
  expect(grepLines('grep port compose.yml', '80: web')).toEqual([{ prefix: '', lang: 'yaml', text: '80: web' }])
  expect(grepLines('grep -e x -C2 a.py | head -5', '3-y = 1')?.[0]).toEqual({ prefix: '', lang: 'python', text: '3-y = 1' })
  // A quoted pattern with a space, a pipe or a semicolon is one word.
  expect(grepLines('grep -nE "a b|c; d" x.rs', '1:fn a()')).toEqual([{ prefix: '1:', lang: 'rust', text: 'fn a()' }])
  expect(grepLines("grep -n 'it'\\''s' x.rs", '2:x')?.[0]?.lang).toBe('rust') // the shell's 'it'\''s'
})

test('a grep over many files: each line takes its own file\'s language, a dash in a path included', () => {
  const out = 'hooks/code-colors/a.ts:12:const a = 1\nREADME.md-3-# Title\nnotes.txt:1:plain'
  expect(grepLines('grep -rn const .', out)).toEqual([
    { prefix: 'hooks/code-colors/a.ts:12:', lang: 'ts', text: 'const a = 1' },
    { prefix: 'README.md-3-', lang: 'markdown', text: '# Title' },
    { prefix: '', lang: 'output', text: 'notes.txt:1:plain' },
  ])
  expect(grepLines('rg foo src', 'src/x.py:foo()')).toEqual([{ prefix: 'src/x.py:', lang: 'python', text: 'foo()' }])
})

test('counts, file lists, other commands and plain-text files are not drawn as grep lines', () => {
  expect(grepLines('grep -c x a.ts', '3')).toBeUndefined()
  expect(grepLines('grep -rl x .', 'a.ts')).toBeUndefined()
  expect(grepLines('grep -n x notes.txt', '1:x')).toBeUndefined()
  expect(grepLines('grep x a.ts | wc -l', '3')).toBeUndefined()
  expect(grepLines('grep x a.ts; grep y b.ts', 'x')).toBeUndefined()
  expect(grepLines('ls; cat a.ts', 'x')).toBeUndefined()
})

test('a stage that keeps the lines leaves a print or a grep in its language; one that changes them does not', () => {
  expect(grepLines('grep -n a x.ts | cut -c1-200 | head -5', '3:const a = 1')?.[0]).toEqual({ prefix: '3:', lang: 'ts', text: 'const a = 1' })
  expect(grepLines('grep -n a x.ts | grep -v b | sort | head', '3:const a = 1')?.[0]?.lang).toBe('ts')
  expect(outputLang('cat x.py | grep -v y | head')).toBe('python')
  expect(outputLang('cat x.py | cut -c1-80')).toBe('python')
  expect(outputLang("cat x.py | grep -v 'a|b; c'")).toBe('python')
  expect(grepLines('grep -n a x.ts | cut -d: -f1', '3')).toBeUndefined()
  expect(grepLines('grep -n a x.ts | grep -c b', '3')).toBeUndefined()
  expect(outputLang('cat x.py | sed s/a/b/')).toBeUndefined()
})

test('a variable set earlier in the command names the file', () => {
  expect(grepLines('T=~/x/index.d.ts; grep -n Bash $T | head -8', '3:type Bash')?.[0]).toEqual({ prefix: '3:', lang: 'ts', text: 'type Bash' })
  expect(outputLang('export F=a.rs; cat ${F}')).toBe('rust')
})

test('a redirect joined to its target takes no next word as one', () => {
  expect(outputLang('cat 2>&1 a.py')).toBe('python')
  expect(grepLines('grep -n x 2>&1 a.py', '1:y')?.[0]?.lang).toBe('python')
  expect(outputLang('cat 2> /dev/null a.py')).toBe('python')
})

const langs = (command: string, stdout: string) => outputLines(command, stdout).map(line => [line.prefix, line.lang])

test('in a chain, grep lines with a path are found anywhere, and bare numbers by the echo before them', () => {
  const command = `echo "--- impl"; grep -n x tools/tv.py | head -40; echo "--- docs"; grep -n y a.md b.json | head -14; pm list`
  const stdout = '--- impl\n12:def x():\n--\n40-  y = 1\n--- docs\na.md:1:# y\nb.json-2-{"y": 1}\nc.txt:3:y\n7:not code'
  expect(outputLines(command, stdout)).toEqual([
    { prefix: '', lang: 'output', text: '--- impl' },
    { prefix: '12:', lang: 'python', text: 'def x():' },
    { prefix: '--', text: '' },
    { prefix: '40-', lang: 'python', text: '  y = 1' },
    { prefix: '', lang: 'output', text: '--- docs' },
    { prefix: 'a.md:1:', lang: 'markdown', text: '# y' },
    { prefix: 'b.json-2-', lang: 'json', text: '{"y": 1}' },
    { prefix: '', lang: 'output', text: 'c.txt:3:y' },
    { prefix: '', lang: 'output', text: '7:not code' },
  ])
})

test('in a chain, two numbered greps of different languages with no echo between them are not guessed', () => {
  expect(langs('grep -n a x.py; grep -n b y.rs', '1:a\n2:b')).toEqual([['', 'output'], ['', 'output']])
  expect(langs('ls; grep -n a x.py; grep -n b y.py', 'z.py\n1:a')).toEqual([['', 'output'], ['1:', 'python']])
})

test('a print or an unnumbered grep alone between two echoes is its language; a path in a sentence is no grep prefix', () => {
  expect(langs('echo one; cat a.py | grep -v z; echo two; ls', 'one\nx = 1\ntwo\nb')).toEqual([['', 'output'], ['', 'python'], ['', 'output'], ['', 'output']])
  expect(outputLines('ls', 'Updated foo.md: 12: bar')).toEqual([{ prefix: '', lang: 'output', text: 'Updated foo.md: 12: bar' }])
  expect(outputLines('rg x; ls', 'src/a.py:foo()')).toEqual([{ prefix: 'src/a.py:', lang: 'python', text: 'foo()' }])
})

test('a diff in the output is drawn as one, and ends where its shape ends', () => {
  const stdout = 'commit abc\ndiff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n ctx\n\ncommit def'
  expect(outputLines('git log -p', stdout).map(line => line.lang)).toEqual(['output', 'diff', 'diff', 'diff', 'diff', 'diff', 'diff', 'diff', 'diff', 'diff', 'output'])
  // A section marker is not a diff without its +++ line.
  expect(outputLines('ls', '--- now\n- item')[0]?.lang).toBe('output')
})

test('JSON, `$ command` lines and the cut-offs', () => {
  expect(langs('gh api x', '{\n  "a": 1\n}')).toEqual([['', 'json'], ['', 'json'], ['', 'json']])
  expect(langs('cat a.jsonl.bak', '{"a": 1}\nb')).toEqual([['', 'json'], ['', 'output']])
  expect(langs('ls', '[section]')).toEqual([['', 'output']])
  expect(outputLines('sh x', '$ pm enable y')).toEqual([{ prefix: '$ ', lang: 'bash', text: 'pm enable y' }])
  // A very long line is colored where the lexer's cost grows with its length (output, TOML, JSON); past the
  // limit, or past the short one in a language whose cost grows with the square, it is plain.
  const long = 'x'.repeat(2001)
  expect(outputLines('ls', long)).toEqual([{ prefix: '', lang: 'output', text: long }])
  const toml = `{ id = "t12", note = "${'word '.repeat(800)}" },`
  expect(outputLines('wc -c a.md && grep -n k a.toml | head', `1 a.md\n66:${toml}`)).toEqual([{ prefix: '', lang: 'output', text: '1 a.md' }, { prefix: '66:', lang: 'ini', text: toml }])
  const atLimit = 'x'.repeat(MAX_COLORED_LINE)
  expect(outputLines('ls', atLimit)).toEqual([{ prefix: '', lang: 'output', text: atLimit }])
  expect(outputLines('ls', `${atLimit}x`)).toEqual([{ prefix: '', text: `${atLimit}x` }])
  const script = `echo ${'a '.repeat(1100)}`
  expect(outputLines('sh x', `$ ${script}`)).toEqual([{ prefix: '$ ', text: script }])
  expect(outputLines('wc -c a.md && grep -n k a.ts | head', `1 a.md\n66:${long}`)[1]).toEqual({ prefix: '66:', text: long })
  expect(outputLines('sh x', `$ ${script}\n$ ls`).map(line => line.prefix + line.text).join('\n')).toBe(`$ ${script}\n$ ls`)
  // A grep's path prefix is looked for where a path can be (4,096 chars), not at every `:` of a very long line.
  const deep = `${'d/'.repeat(2040)}a.ts`
  expect(outputLines('ls; grep -rn k d | head', `${deep}:12:const x = 1`)[0]).toEqual({ prefix: `${deep}:12:`, lang: 'ts', text: 'const x = 1' })
  expect(outputLines('ls; grep -rn k d | head', `${'x'.repeat(5000)}/a.ts:12:const x = 1`)[0]?.lang).toBe('output')
  const atBound = `${'d/'.repeat(2046)}a.ts` // 4,096 chars: its `:` is the last cut tried
  expect(atBound.length).toBe(4096)
  expect(outputLines('ls; grep -rn k d | head', `${atBound}:12:const x = 1`)[0]).toEqual({ prefix: `${atBound}:12:`, lang: 'ts', text: 'const x = 1' })
  expect(outputLines('ls; grep -rn k d | head', `d${atBound}:12:const x = 1`)[0]?.lang).toBe('output')
  const many = Array.from({ length: MAX_COLORED_LINES + 2 }, (_, i) => `l${i}`)
  const drawn = outputLines('ls', many.join('\n'))
  expect(drawn.length).toBe(MAX_COLORED_LINES + 1)
  expect(drawn.at(-1)).toEqual({ prefix: '', text: `l${MAX_COLORED_LINES}\nl${MAX_COLORED_LINES + 1}` })
  // Joined back, nothing is lost or moved.
  expect(drawn.map(line => line.prefix + line.text).join('\n')).toBe(many.join('\n'))
})

test('any output joins back to exactly what the command printed', () => {
  const stdout = '--- a\n12:x\n--\na.py:1:b\n$ c\n{"d": 1}\ndiff --git a b\n-e\n+f\n\nplain text'
  for (const command of ['ls', 'echo "--- a"; grep -n x a.py', 'cat a.txt']) {
    const joined = outputLines(command, stdout).map(line => line.prefix + line.text).join('\n')
    expect(joined).toBe(stdout)
  }
})

const outputKinds = (source: string) => tokenize(source, 'output').filter(token => token.kind !== 'plain' && token.text.trim()).map(token => [token.text, token.kind])

test('output: what can be told from the shape gets a kind, and prose stays plain', () => {
  expect(outputKinds('restoring the state on a machine')).toEqual([])
  expect(outputKinds("don't touch it, it's fine")).toEqual([])
  expect(outputKinds('Claude Code (WSL)')).toEqual([['WSL', 'keyword']])
  expect(outputKinds('docs(rules)')).toEqual([['docs', 'function']])
  expect(outputKinds('a | b && c; d')).toEqual([['|', 'keyword'], ['&&', 'keyword'], [';', 'keyword']])
  expect(outputKinds('--- now')).toEqual([['--- now', 'keyword']])
  expect(outputKinds('package:com.google.android.tts')).toEqual([['package', 'type'], ['com.google.android.tts', 'function']])
  expect(outputKinds('mCurrentFocus=Window{1ee4bbf u0 com.android.tv.settings/.Home}')).toEqual([
    ['mCurrentFocus', 'type'], ['1ee4bbf', 'number'], ['com.android.tv.settings/.Home', 'name'],
  ])
  expect(outputKinds('FAILED tests/a.py - 3 passed, 1 error in 2.5s')).toEqual([
    ['FAILED', 'string'], ['tests/a.py', 'name'], ['3', 'number'], ['passed', 'comment'], ['1', 'number'], ['error', 'string'], ['2.5s', 'number'],
  ])
  expect(outputKinds('see https://a.b/c?d=1 and ~/x/y.py at 2026-10-30T18:18:04-0400')).toEqual([
    ['https://a.b/c?d=1', 'function'], ['~/x/y.py', 'name'], ['2026-10-30T18:18:04-0400', 'number'],
  ])
  expect(outputKinds('warning: run --force "now" v2.1.3 50%')).toEqual([
    ['warning', 'keyword'], ['--force', 'keyword'], ['"now"', 'string'], ['v2.1.3', 'number'], ['50%', 'number'],
  ])
})

test('every output token joins back to its source', () => {
  for (const source of ["a/b c:\\d 'e\" f=1 -g --- #h é😀 1,2 3:4 0xff", '--- x\n## y\n"unterminated', 'a.py:1:b//c']) {
    expect(tokenize(source, 'output').map(token => token.text).join('')).toBe(source)
    expect(tokenize(source, 'diff').map(token => token.text).join('')).toBe(source)
  }
})

test('a repeated echo moves on to the next section, across the spans a printed file cuts the output into', () => {
  const command = 'git status; echo ---; cat a.py; echo ---; git log --oneline -5'
  expect(outputLines(command, 'M x\n---\ny = 1\n---\nabc1234 z').map(line => line.lang)).toEqual(['output', 'output', 'python', 'output', 'output'])
  const position = { section: 0 }
  expect(outputLines(command, 'M x\n---', position).map(line => line.lang)).toEqual(['output', 'output'])
  expect(outputLines(command, '---\nabc1234 z', position).map(line => line.lang)).toEqual(['output', 'output'])
})

test('a diagnostic with a path and a line number is output unless a grep ran', () => {
  const line = "a.py:12: error: Name 'x' is not defined"
  expect(outputLines('mypy . | tail -20', line)).toEqual([{ prefix: '', lang: 'output', text: line }])
  expect(outputLines('ls; grep -rn x .', line)).toEqual([{ prefix: 'a.py:12:', lang: 'python', text: " error: Name 'x' is not defined" }])
  expect(outputLines('git grep -n x', line)[0]?.lang).toBe('python')
  expect(outputLines('find . | xargs grep -n x', line)[0]?.lang).toBe('python')
  // A grep after a pipe only filters what came before it, and adds no prefix.
  expect(outputLines('mypy . | grep error', line)[0]?.lang).toBe('output')
  expect(outputLines('gcc a.c 2>&1 |  grep error', line)[0]?.lang).toBe('output')
  expect(outputLines('mypy . |& grep error', line)[0]?.lang).toBe('output')
  expect(outputLines('mypy . | \\\n  grep error', line)[0]?.lang).toBe('output')
  expect(outputLines('grep -rn x . | grep -v y', line)[0]?.lang).toBe('python')
  // In quotes or called by its path, it is still a grep.
  expect(outputLines('ssh host "grep -rn x /app"', line)[0]?.lang).toBe('python')
  expect(outputLines("sh -c 'rg -n x'", line)[0]?.lang).toBe('python')
  expect(outputLines('/usr/bin/grep -n x a.py b.py', line)[0]?.lang).toBe('python')
})

test('a name like an Object method is no language', () => {
  expect(outputLines('grep -rn x .', 'a.constructor:12:y')).toEqual([{ prefix: '', lang: 'output', text: 'a.constructor:12:y' }])
  expect(outputLang('cat a.constructor')).toBeUndefined()
  expect(tokenize('a.toString', 'output').map(token => token.kind)).toEqual(['function'])
})

const commandKinds = (source: string, lang: Lang = 'bash') => commandTokens(source, lang).filter(token => token.text.trim()).map(token => [token.text.trim(), token.kind])

test('a short string in a command stays one string', () => {
  for (const source of [`python3 - <<'EOF'`, `echo "--- now"`, `tr -d '\\r'`, `R="$A/home"`]) {
    expect(commandTokens(source, 'bash')).toEqual(tokenize(source, 'bash'))
  }
})

test("a long string's sentence gets variety; its quotes stay the string's", () => {
  const kinds = commandKinds(`echo "- 2026-10-30 · mods/code-colors · 92 tests, see --force" >> LOG.md`)
  expect(kinds).toContainEqual(['"', 'string'])
  expect(kinds).toContainEqual(['2026-10-30', 'number'])
  expect(kinds).toContainEqual(['mods/code-colors', 'name'])
  expect(kinds).toContainEqual(['92', 'number'])
  expect(kinds).toContainEqual(['--force', 'keyword'])
})

test('a quoted command is drawn as a command, its pipes and programs apart', () => {
  const kinds = commandKinds(`$P 'pm list packages -d --user 0; cmd package | tail -1' | tr -d x`)
  expect(kinds).toContainEqual(['pm', 'function'])
  expect(kinds).toContainEqual(['-d', 'type'])
  expect(kinds.filter(([text]) => text === '|').map(([, kind]) => kind)).toEqual(['keyword', 'keyword'])
  expect(kinds).toContainEqual(['tail', 'function'])
})

test('pipes in a pattern get a color of their own, however short the pattern', () => {
  const kinds = commandKinds(`grep -E 'a|b' x`)
  expect(kinds).toContainEqual(['|', 'keyword'])
  expect(kinds).toContainEqual(["'", 'string'])
})

test('a sentence with a semicolon in echo or a commit message is not taken for a command', () => {
  const kinds = commandKinds(`echo "fixed the thing here; now it works fine" && git commit -m "first part of it; the second part"`)
  expect(kinds).not.toContainEqual(['fixed', 'function'])
  expect(kinds).not.toContainEqual(['first', 'function'])
})

test('code after -c is drawn in its language, in a heredoc body a long string is expanded too', () => {
  expect(commandKinds(`python3 -c "import os; print(os.getcwd())"`)).toContainEqual(['import', 'keyword'])
  expect(commandKinds(`bash -c "ls -la; pwd"`)).toContainEqual(['ls', 'function'])
  const python = commandKinds(`s.replace(a, '- code-colors 0.13.0 (2026-10-30), a long sentence')`, 'python')
  expect(python).toContainEqual(['2026-10-30', 'number'])
  expect(python).toContainEqual(["'", 'string'])
})

test('only a string in shell text can be a command', () => {
  const kinds = commandKinds(`print("first part is finished; second part next")`, 'python')
  expect(kinds).not.toContainEqual(['first', 'function'])
  expect(kinds).not.toContainEqual(['second', 'function'])
})

test('a code fence in a Markdown heredoc stays one piece', () => {
  const source = '```bash\nls -la | wc -l\n```'
  expect(commandTokens(source, 'markdown')).toEqual(tokenize(source, 'markdown'))
})

test('code after -c is found past a path, flag values and joined flags', () => {
  expect(commandKinds(`psql -U postgres -c "SELECT 1; SELECT 2"`)).toContainEqual(['SELECT', 'keyword'])
  expect(commandKinds(`.venv/bin/python -c "import os; print(1)"`)).toContainEqual(['import', 'keyword'])
  expect(commandKinds(`powershell.exe -ExecutionPolicy Bypass -Command "Get-Item x; ls"`)).toContainEqual(['Get-Item', 'function'])
  expect(commandKinds(`powershell -Command "Get-Item x; ls"`)).toContainEqual(['Get-Item', 'function'])
  expect(commandKinds(`bash -lc "ls some/long/path here"`)).toContainEqual(['ls', 'function'])
  // Not a program's code: the count flags of grep and cut.
  expect(commandKinds(`grep -c "a long pattern with spaces in it" x`)).not.toContainEqual(['a', 'function'])
})

test('a command joins back to itself whatever its strings hold', () => {
  for (const source of [
    `echo "- a long sentence with a \\"quote\\" and a path /a/b.py; and more" | tee 'x y z | q'`,
    `f"a long f-string with {x} in it and 3 words"`,
    `'''a long triple quoted\nstring | across two lines'''`,
    `"an unterminated string that runs on for a while`,
    `$'a dollar quoted string that runs on | for a while'`,
  ]) {
    expect(commandTokens(source, 'bash').map(token => token.text).join('')).toBe(source)
    expect(commandTokens(source, 'python').map(token => token.text).join('')).toBe(source)
  }
  const huge = `echo "${'word '.repeat(1000)}"`
  expect(commandTokens(huge, 'bash')).toEqual(tokenize(huge, 'bash'))
})

test('the row in the screenshot: a long chain of adb output and greps', () => {
  const command = `cd /r/tv-tools; R=/r/records; export TV_HOST=127.0.0.1; P="tools/venv/bin/python -I tools/tv.py"; echo "--- now"; $P 'pm list packages -d | tail -1; dumpsys window | grep mCurrentFocus | head -1' | tr -d '\\r'; echo "--- reboot impl"; grep -n -E -A12 '"--reboot"|def .*reboot' tools/tv.py | head -40; echo "--- key docs"; grep -n -E 'a|b' docs/launcher.md | head -14`
  const stdout = '--- now\npackage:com.google.android.tts\n--- reboot impl\n12:    if reboot:\n--- key docs\n3:# Launcher'
  expect(langs(command, stdout)).toEqual([['', 'output'], ['', 'output'], ['', 'output'], ['12:', 'python'], ['', 'output'], ['3:', 'markdown']])
})

test('a grep row carries its lines; a cat row does not', () => {
  const row = bashRow({ ...done('1:x = 1'), input: { command: 'grep -n x a.py' } })
  expect(row?.output?.grep).toEqual([{ prefix: '1:', lang: 'python', text: 'x = 1' }])
  expect(bashRow(done('x = 1'))?.output?.grep).toBeUndefined()
})
