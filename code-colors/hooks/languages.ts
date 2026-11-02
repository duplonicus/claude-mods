/**
 * languages.ts: what each language's tokens are. A rule table per language
 * (tried in order at each position, sticky regexes) and a word classifier that
 * sees the text before and after the word. highlight.ts runs these; the fence
 * tags and file extensions that pick a language live here too.
 */

export type Lang = 'sql' | 'ts' | 'python' | 'rust' | 'hcl' | 'bash' | 'html' | 'css' | 'json' | 'powershell' | 'markdown' | 'yaml' | 'ini' | 'surql' | 'batch' | 'c' | 'diff' | 'output'

export type TokenKind = 'keyword' | 'type' | 'name' | 'string' | 'number' | 'comment' | 'function' | 'punct' | 'plain'

export type Token = { kind: TokenKind; text: string; isChanged?: true }

type Rule = { kind: TokenKind | 'word'; pattern: RegExp }

type LanguageSpec = { rules: Rule[]; classifyWord: (word: string, before: string, after: string) => TokenKind }

const words = (list: string) => new Set(list.split(/\s+/))

const isCall = (after: string) => /^\s*\(/.test(after)
const isDefinitionName = (before: string) => /\b(?:fn|def|function)\s+$/.test(before.slice(-12))
const isPascalCase = (word: string) => /^[A-Z]/.test(word)

const NUMBER = /\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\b/y

const SQL_KEYWORDS = words(
  `select from where and or not null is in as on join left right inner outer full cross group by order having limit offset
   insert into values update set delete create table alter drop add column index unique primary key foreign references
   default constraint check if exists distinct union all case when then else end with returning cascade begin commit
   rollback transaction view trigger asc desc between like true false`,
)
const SQL_TYPES = words(
  `integer int bigint smallint serial bigserial text varchar char boolean bool timestamp timestamptz date time interval
   numeric decimal real float double uuid json jsonb blob bytea`,
)

const TS_KEYWORDS = words(
  `const let var function return if else for while do switch case break continue new delete typeof instanceof in of
   class extends implements interface type enum export import from as async await try catch finally throw yield
   default void this super null undefined true false readonly public private protected static declare keyof satisfies`,
)
const TS_PRIMITIVES = words('string number boolean unknown never any object bigint symbol')

const PYTHON_KEYWORDS = words(
  `def class return if elif else for while in not and or is None True False import from as with try except finally
   raise yield lambda pass break continue global nonlocal async await del assert match case self`,
)
const PYTHON_TYPES = words('int float str bool list dict set tuple bytes object complex frozenset')

const RUST_KEYWORDS = words(
  `fn let mut pub struct enum impl trait use mod crate self super match if else for while loop return as in ref move
   where async await dyn const static type unsafe extern true false break continue`,
)
const RUST_PRIMITIVES = words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Option Result Vec Box PathBuf Path HashMap HashSet Self')

const HCL_KEYWORDS = words(
  `resource data variable output locals module provider terraform backend required_providers dynamic moved import check
   for in if true false null`,
)
const HCL_TYPES = words('string number bool list map set object tuple any')

const SHELL_KEYWORDS = words('if then else elif fi for while until do done case esac in function select time')
// A word right after one of these (or after `VAR=value ` assignments) is the command that runs.
const SHELL_COMMAND_START = /(?:^|[|&;({`\n]|\$\(|\b(?:then|do|else|elif|if|while|until|sudo|xargs|exec|env|nohup|command|builtin)\s)\s*(?:[A-Za-z_]\w*=\S*\s+)*$/

const SURQL_KEYWORDS = words(
  `define namespace database table field index event param function fn analyzer access user relate live kill upsert let
   return type permissions schemafull schemaless assert value content merge patch fetch split omit only
   parallel timeout explain throw break continue none`,
)

const SURQL_TYPES = words('string int float bool datetime duration record array object option set geometry number decimal uuid any bytes')

const BATCH_KEYWORDS = words('if else for in do goto call set setlocal endlocal echo exit not exist defined errorlevel equ neq lss leq gtr geq shift pushd popd start')

// One lexer for the C family: C, C++, C#, Swift, GLSL. The keyword sets are merged;
// a word that is a keyword in one and a name in another is rare in practice.
const C_KEYWORDS = words(
  `if else for while do switch case default break continue return goto sizeof typedef struct union enum class namespace
   using public private protected internal static const constexpr volatile extern inline virtual override final abstract
   sealed template typename new delete this self super nullptr null nil true false try catch finally throw throws
   import func let var guard defer in out inout uniform varying attribute layout precision readonly ref async await
   is as where get set init deinit protocol extension operator explicit friend mutable noexcept`,
)
const C_TYPES = words(
  `void int char short long float double bool unsigned signed auto size_t ssize_t uint8_t uint16_t uint32_t uint64_t
   int8_t int16_t int32_t int64_t string String Int Double Float Bool vec2 vec3 vec4 mat2 mat3 mat4 sampler2D decimal
   object byte sbyte uint ulong ushort dynamic Any Void`,
)

const POWERSHELL_KEYWORDS = words(
  `if else elseif foreach for while do until switch function filter param return try catch finally throw break continue
   in begin process end trap exit class enum using`,
)

// HTML and CSS share one classifier: inside a tag a word is an attribute, inside
// <style> (or a .css file) the CSS rules apply. The lexer keeps no state, so
// where a word sits is read from the text before it.
const isInTag = (before: string) => before.lastIndexOf('<') > before.lastIndexOf('>')
const isInStyle = (before: string) => before.lastIndexOf('<style') > before.lastIndexOf('</style')

function classifyMarkup(word: string, before: string, after: string, isCss: boolean): TokenKind {
  const tail = before.slice(-2000) // only the nearest tag matters
  const inTag = !isCss && isInTag(tail)
  if (word.startsWith('"') || word.startsWith("'")) return inTag || isCss || isInStyle(tail) ? 'string' : 'plain'
  if (inTag) return 'type' // an attribute name; the tag's own name came with its `<`
  if (!isCss && !isInStyle(tail)) return isCall(after) ? 'function' : 'plain' // page text, or script
  if (word.startsWith('@')) return 'keyword' // @media, @import
  if (word.startsWith('--')) return 'name' // a custom property
  if (isCall(after)) return 'function' // var(, max(, rgb(
  // A property starts a declaration (after `{` or `;`); `a:hover` is a selector.
  return /^\s*:/.test(after) && /[{;]\s*$/.test(tail) ? 'type' : 'plain'
}

const MARKUP_RULES: Rule[] = [
  { kind: 'comment', pattern: /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//y },
  { kind: 'keyword', pattern: /<\/?[A-Za-z][\w:-]*/y }, // a tag and its name
  { kind: 'punct', pattern: /\/?>/y },
  { kind: 'word', pattern: /"[^"<>\n]*"|'[^'<>\n]*'/y }, // a string only inside a tag or CSS (see classifyMarkup)
  { kind: 'number', pattern: /#[0-9a-fA-F]{3,8}\b|&#?\w+;|-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch|fr|ms|s|deg)?\b/y }, // colors, entities, sizes
  { kind: 'word', pattern: /@?-*[A-Za-z_][\w-]*/y },
]

// Kinds picked so Markdown here (a printed .md, a Fetch page) reads like reply
// prose in the default palette: headings gold, bold orange, inline code pink,
// links light blue.
const MARKDOWN_RULES: Rule[] = [
  { kind: 'comment', pattern: /<!--[\s\S]*?-->|(?<![^\n])>[^\n]*/y }, // HTML comments, block quotes
  { kind: 'number', pattern: /(?<![^\n])#{1,6}[ \t][^\n]*/y }, // a heading
  { kind: 'string', pattern: /(?<![^\n])(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*/y }, // code fences
  { kind: 'name', pattern: /`[^`\n]+`/y }, // inline code
  { kind: 'keyword', pattern: /\*\*[^*\n]+\*\*|__[^_\n]+__/y }, // bold
  { kind: 'function', pattern: /!?\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]+>/y }, // links, images
  { kind: 'number', pattern: /(?<![^\n])[ \t]*(?:[-*+]|\d+[.)])(?=[ \t])/y }, // list markers
  { kind: 'punct', pattern: /(?<![^\n])(?:-{3,}|\*{3,})[ \t]*(?=\n|$)|\|/y }, // rules, table bars
]

// What a command prints has no grammar: these words and the rules' shapes (paths, numbers, flags, pipes) are what can be told, and prose around them stays plain.
const OUTPUT_BAD = words(`error errors err failed failure failures fail fails fatal denied refused exception traceback panic panicked
  killed aborted abort timeout missing invalid unauthorized forbidden`)
const OUTPUT_WARN = words('warning warnings warn deprecated skipped skipping skip stale ignored disabled')
const OUTPUT_GOOD = words('ok success successful succeeded passed pass enabled done')

export const LANGUAGES: Record<Lang, LanguageSpec> = {
  sql: {
    rules: [
      { kind: 'comment', pattern: /--[^\n]*|\/\*[\s\S]*?\*\//y },
      { kind: 'string', pattern: /'(?:[^']|'')*'/y },
      { kind: 'number', pattern: NUMBER },
      { kind: 'word', pattern: /[A-Za-z_][\w$]*/y },
      { kind: 'punct', pattern: /[(),;.*=<>+\-/%]/y },
    ],
    classifyWord: word => {
      const lower = word.toLowerCase()
      if (SQL_TYPES.has(lower)) return 'type'
      return SQL_KEYWORDS.has(lower) ? 'keyword' : 'plain'
    },
  },
  ts: {
    rules: [
      { kind: 'comment', pattern: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
      { kind: 'string', pattern: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/y },
      { kind: 'number', pattern: NUMBER },
      { kind: 'word', pattern: /[A-Za-z_$][\w$]*/y },
      { kind: 'punct', pattern: /[{}()[\];,.:=<>+\-*/%!?&|^~@]/y },
    ],
    classifyWord: (word, before, after) => {
      if (TS_KEYWORDS.has(word)) return 'keyword'
      if (TS_PRIMITIVES.has(word)) return 'type'
      if (isPascalCase(word)) return 'name' // a class, struct or enum name
      if (/<\/?$/.test(before)) return 'keyword' // a JSX html tag: <div>, </div>
      return isDefinitionName(before) || isCall(after) ? 'function' : 'plain'
    },
  },
  python: {
    rules: [
      { kind: 'comment', pattern: /#[^\n]*/y },
      { kind: 'string', pattern: /[rRbBuUfF]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/y },
      { kind: 'function', pattern: /@[A-Za-z_][\w.]*/y }, // a decorator
      { kind: 'number', pattern: NUMBER },
      { kind: 'word', pattern: /[A-Za-z_]\w*/y },
      { kind: 'punct', pattern: /[{}()[\];,.:=<>+\-*/%!&|^~@]/y },
    ],
    classifyWord: (word, before, after) => {
      if (PYTHON_KEYWORDS.has(word)) return 'keyword'
      if (PYTHON_TYPES.has(word)) return 'type'
      if (isPascalCase(word)) return 'name' // a class, struct or enum name
      return isDefinitionName(before) || isCall(after) ? 'function' : 'plain'
    },
  },
  rust: {
    rules: [
      { kind: 'comment', pattern: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
      { kind: 'string', pattern: /b?"(?:[^"\\]|\\[\s\S])*"|r(#*)"[\s\S]*?"\1/y },
      { kind: 'string', pattern: /'(?:\\.|[^\\'\n])'/y }, // a char
      { kind: 'keyword', pattern: /'[A-Za-z_]\w*/y }, // a lifetime
      { kind: 'number', pattern: /\d[\d_]*(?:\.\d[\d_]*)?(?:[iu](?:8|16|32|64|128|size)|f32|f64)?\b/y },
      { kind: 'word', pattern: /[A-Za-z_]\w*/y },
      { kind: 'punct', pattern: /[{}()[\];,.:=<>+\-*/%!&|^~?#@]/y },
    ],
    classifyWord: (word, before, after) => {
      if (RUST_KEYWORDS.has(word)) return 'keyword'
      if (RUST_PRIMITIVES.has(word)) return 'type'
      if (isPascalCase(word)) return 'name' // a class, struct or enum name
      if (/^![^=]/.test(after)) return 'function' // a macro: println!, vec!
      return isDefinitionName(before) || isCall(after) ? 'function' : 'plain'
    },
  },
  hcl: {
    rules: [
      { kind: 'comment', pattern: /#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
      { kind: 'string', pattern: /"(?:[^"\\\n]|\\.)*"/y },
      { kind: 'number', pattern: NUMBER },
      { kind: 'word', pattern: /[A-Za-z_][\w-]*/y },
      { kind: 'punct', pattern: /[{}()[\],.:=<>+\-*/%!?&|]/y },
    ],
    classifyWord: (word, _before, after) => {
      if (HCL_KEYWORDS.has(word)) return 'keyword'
      if (HCL_TYPES.has(word)) return 'type'
      return isCall(after) ? 'function' : 'plain'
    },
  },
  html: { rules: MARKUP_RULES, classifyWord: (word, before, after) => classifyMarkup(word, before, after, false) },
  css: { rules: MARKUP_RULES, classifyWord: (word, before, after) => classifyMarkup(word, before, after, true) },
  json: {
    rules: [
      { kind: 'word', pattern: /"(?:[^"\\\n]|\\.)*"/y },
      { kind: 'number', pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
      { kind: 'word', pattern: /[A-Za-z]+/y },
      { kind: 'punct', pattern: /[{}[\],:]/y },
    ],
    // A string before a colon is a key.
    classifyWord: (word, _before, after) => {
      if (word.startsWith('"')) return /^\s*:/.test(after) ? 'type' : 'string'
      return word === 'true' || word === 'false' || word === 'null' ? 'keyword' : 'plain'
    },
  },
  markdown: { rules: MARKDOWN_RULES, classifyWord: () => 'plain' },
  diff: {
    rules: [
      { kind: 'keyword', pattern: /(?<![^\n])(?:diff |index |--- |\+\+\+ |new file|deleted file|rename |similarity |old mode|new mode)[^\n]*/y },
      { kind: 'function', pattern: /(?<![^\n])@@[^\n]*?@@/y },
      { kind: 'comment', pattern: /(?<![^\n])\+[^\n]*/y },
      { kind: 'string', pattern: /(?<![^\n])-[^\n]*/y },
      { kind: 'plain', pattern: /[^\n]+/y },
    ],
    classifyWord: () => 'plain',
  },
  output: {
    rules: [
      { kind: 'keyword', pattern: /(?<![^\n])[ \t]*(?:-{3,}|={3,}|\*{3,}|>{3,}|<{3,})(?:[ \t][^\n]*)?(?=\n|$)/y }, // `--- now`
      { kind: 'comment', pattern: /(?<![^\n])[ \t]*#{1,6}[ \t][^\n]*/y },
      { kind: 'function', pattern: /\b[a-z][a-z+.-]*:\/\/[^\s"'<>)]+/y }, // URL
      { kind: 'number', pattern: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/y }, // date, time
      { kind: 'string', pattern: /"(?:[^"\\\n]|\\.)*"|(?<![\w'])'(?:[^'\\\n]|\\.)*'(?!\w)/y },
      { kind: 'keyword', pattern: /\|\|?|&&|;(?=\s|$)/y },
      { kind: 'name', pattern: /\b[A-Za-z]:\\[^\s"']+|(?<![\w./~@-])(?:~|\.{1,2})?\/[\w.@+~-]+(?:\/[\w.@+~-]*)*|(?<![\w./~@-])[A-Za-z_.][\w.@+-]*(?:\/[\w.@+~-]+)+\/?/y }, // path
      { kind: 'number', pattern: /\b(?=[a-f]*\d)(?=\d*[a-f])[0-9a-f]{7,64}\b/y }, // commit hash
      { kind: 'number', pattern: /\bv\d+(?:\.\d+)*\b|\b\d+(?:[.,]\d+)*(?:%|(?:[kKMGT]i?[bB]?|[bB]|ms|us|s|m|h)\b|\b)/y },
      { kind: 'keyword', pattern: /(?<![\w-])--?[A-Za-z][\w-]*/y }, // flag
      { kind: 'word', pattern: /[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/y },
    ],
    classifyWord: (word, _before, after) => {
      const lower = word.toLowerCase()
      if (OUTPUT_BAD.has(lower)) return 'string'
      if (OUTPUT_WARN.has(lower)) return 'keyword'
      if (OUTPUT_GOOD.has(lower)) return 'comment'
      if (word.includes('.')) return langFromPath(word) ? 'name' : 'function' // `a.py`, `com.google.android.tts`
      if (/^[:=]/.test(after)) return 'type' // `package:x`, `Author: y`, `key=value`
      if (after.startsWith('(')) return 'function' // `f(x)`; `Claude Code (WSL)` is prose

      if (/^(?:true|false|null|none|nil|yes|no)$/.test(lower) || /^[A-Z][A-Z\d_-]+$/.test(word)) return 'keyword'
      return 'plain'
    },
  },
  yaml: {
    rules: [
      { kind: 'comment', pattern: /(?<![^\s])#[^\n]*/y },
      { kind: 'punct', pattern: /(?<![^\n])(?:---|\.\.\.)(?=\s|$)/y }, // document markers
      { kind: 'word', pattern: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'/y },
      { kind: 'name', pattern: /[&*][\w-]+/y }, // anchors and aliases
      { kind: 'number', pattern: /-?\b\d+(?:\.\d+)?\b/y },
      { kind: 'word', pattern: /[A-Za-z_][\w.-]*/y },
    ],
    // A word or string before `:` is a key.
    classifyWord: (word, _before, after) => {
      if (/^\s*:(?:\s|$)/.test(after)) return 'type'
      if (word.startsWith('"') || word.startsWith("'")) return 'string'
      return /^(?:true|false|yes|no|on|off|null)$/i.test(word) ? 'keyword' : 'plain'
    },
  },
  ini: {
    rules: [
      { kind: 'comment', pattern: /(?<![^\n])[ \t]*[#;][^\n]*/y },
      { kind: 'keyword', pattern: /(?<![^\n])[ \t]*\[\[?[^\]\n]+\]\]?/y }, // [section], [[array]]
      { kind: 'string', pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/y },
      { kind: 'number', pattern: /-?\b\d[\d_]*(?:\.\d+)?\b/y },
      { kind: 'word', pattern: /[A-Za-z_][\w.-]*/y },
    ],
    // A word before `=` (or `:` in .gitconfig-style files) is a key; the rest of the line is its value.
    classifyWord: (word, before, after) => {
      if (/^\s*=/.test(after) && /(?:^|\n)[ \t]*[\w.-]*$/.test(before.slice(-200))) return 'type'
      return /^(?:true|false|yes|no|on|off)$/i.test(word) ? 'keyword' : 'plain'
    },
  },
  surql: {
    rules: [
      { kind: 'comment', pattern: /(?:--|\/\/|#)[^\n]*|\/\*[\s\S]*?\*\//y },
      { kind: 'string', pattern: /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/y },
      { kind: 'name', pattern: /\$[A-Za-z_]\w*/y }, // a parameter
      { kind: 'number', pattern: NUMBER },
      { kind: 'word', pattern: /[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*/y }, // fn::name, string::len
      { kind: 'punct', pattern: /->|<-|[(),;.*=<>+\-/%:{}[\]]/y },
    ],
    classifyWord: (word, _before, after) => {
      const lower = word.toLowerCase()
      if (word.includes('::')) return 'function'
      if (SQL_TYPES.has(lower) || SURQL_TYPES.has(lower)) return 'type'
      if (SQL_KEYWORDS.has(lower) || SURQL_KEYWORDS.has(lower)) return 'keyword'
      return isCall(after) ? 'function' : 'plain'
    },
  },
  batch: {
    rules: [
      { kind: 'comment', pattern: /(?<![^\n])[ \t@]*(?:rem\b[^\n]*|::[^\n]*)/iy },
      { kind: 'function', pattern: /(?<![^\n])[ \t]*:[A-Za-z_]\w*|(?<=\b(?:goto|call)[ \t]+):[A-Za-z_]\w*/iy }, // a label, and goto/call targets
      { kind: 'string', pattern: /"[^"\n]*"/y },
      { kind: 'name', pattern: /%~?[\w]*%?|![\w]+!/y }, // %VAR%, %~dp0, %1, !VAR!
      { kind: 'type', pattern: /(?<=\s)\/[A-Za-z?]+/y }, // a /switch
      { kind: 'word', pattern: /[A-Za-z_][\w.-]*/y },
      { kind: 'punct', pattern: /[()&|<>@=]/y },
    ],
    classifyWord: word => (BATCH_KEYWORDS.has(word.toLowerCase()) ? 'keyword' : 'plain'),
  },
  c: {
    rules: [
      { kind: 'comment', pattern: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
      { kind: 'keyword', pattern: /(?<![^\n])[ \t]*#[ \t]*\w+/y }, // #include, #if, #pragma
      { kind: 'string', pattern: /@?"(?:[^"\\\n]|\\.)*"|'(?:\\.|[^\\'\n])'/y },
      { kind: 'function', pattern: /@[A-Za-z_]\w*/y }, // a Swift or C# attribute
      { kind: 'number', pattern: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFuUlL]*\b/y },
      { kind: 'word', pattern: /[A-Za-z_]\w*/y },
      { kind: 'punct', pattern: /[{}()[\];,.:=<>+\-*/%!?&|^~]/y },
    ],
    classifyWord: (word, before, after) => {
      if (C_KEYWORDS.has(word)) return 'keyword'
      if (C_TYPES.has(word)) return 'type'
      if (isPascalCase(word)) return 'name' // a class, struct or enum name
      return isDefinitionName(before) || isCall(after) ? 'function' : 'plain'
    },
  },
  powershell: {
    rules: [
      { kind: 'comment', pattern: /<#[\s\S]*?#>|#[^\n]*/y },
      { kind: 'string', pattern: /@'\n[\s\S]*?\n'@|@"\n[\s\S]*?\n"@|'(?:[^']|'')*'|"(?:[^"`]|`[\s\S]|"")*"/y }, // here-strings, '' and `" escapes
      { kind: 'keyword', pattern: /\$(?:true|false|null)\b/iy },
      { kind: 'name', pattern: /\$(?:\{[^}\n]*\}|[A-Za-z_][\w]*(?::[\w]+)?|[$?^_])/y }, // $name, $env:PATH, ${x}, $_
      { kind: 'type', pattern: /\[[A-Za-z][\w.]*(?:\[\])?\]/y }, // a type literal: [string], [System.IO.Path]
      { kind: 'number', pattern: /\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:kb|mb|gb|tb)?\b/y },
      { kind: 'word', pattern: /-[A-Za-z][\w]*|[A-Za-z_][\w]*(?:-[A-Za-z][\w]*)*/y },
      { kind: 'punct', pattern: /[{}()[\];,.=|&<>+*/%!@`:]/y },
    ],
    classifyWord: (word, before, after) => {
      const lower = word.toLowerCase()
      // -eq, -not, -and: operators; any other -Name is a parameter.
      if (word.startsWith('-')) return /^-(?:c|i)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|is|isnot|as|and|or|xor|not|band|bor|f)$/.test(lower) ? 'keyword' : 'type'
      if (POWERSHELL_KEYWORDS.has(lower)) return 'keyword'
      if (/^[A-Za-z]+-[A-Za-z]/.test(word)) return 'function' // a cmdlet: Get-ADDomain, New-GPLink
      return isDefinitionName(before) || isCall(after) ? 'function' : 'plain'
    },
  },
  bash: {
    rules: [
      { kind: 'comment', pattern: /(?<![^\s;|&(])#[^\n]*/y }, // `#` starting a word; inside one (a#b) it is text
      { kind: 'string', pattern: /\$?'[^']*'|"(?:[^"\\]|\\[\s\S])*"/y },
      { kind: 'name', pattern: /\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@#?$!*-])/y }, // a variable
      { kind: 'keyword', pattern: /&&|\|\||;;|[|;]/y }, // what chains commands, so a pipeline's parts stand out
      { kind: 'punct', pattern: /\d*[<>]{1,2}&?\d*-?|\$\(|[()&`{}]/y }, // redirects, subshells
      { kind: 'word', pattern: /[^\s|&;()<>"'`$]+/y },
    ],
    classifyWord: (word, before) => {
      // Only the end matters; a cut-off start must not read as the start of the command.
      const isCommand = SHELL_COMMAND_START.test(before.length > 200 ? `x${before.slice(-200)}` : before)
      if (isCommand && SHELL_KEYWORDS.has(word)) return 'keyword'
      if (/^[A-Za-z_]\w*=/.test(word) && isCommand) return 'name' // an assignment before the command
      if (isCommand) return 'function'
      if (/^-./.test(word)) return 'type' // a flag
      return /^\d+$/.test(word) ? 'number' : 'plain'
    },
  },
}

/** Fence tags we color; every other fence is left to the engine. */
export const FENCE_LANGS: Record<string, Lang> = {
  sql: 'sql',
  ts: 'ts', typescript: 'ts', tsx: 'ts', js: 'ts', javascript: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  py: 'python', python: 'python',
  rs: 'rust', rust: 'rust',
  tf: 'hcl', terraform: 'hcl', hcl: 'hcl', tfvars: 'hcl',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', css: 'css', json: 'json', jsonl: 'json',
  powershell: 'powershell', pwsh: 'powershell', ps1: 'powershell', ps: 'powershell',
  md: 'markdown', markdown: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', systemd: 'ini',
  surql: 'surql', surrealql: 'surql', bat: 'batch', cmd: 'batch', batch: 'batch',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', cs: 'c', csharp: 'c', swift: 'c', glsl: 'c', hlsl: 'c',
  diff: 'diff', patch: 'diff', '': 'output', text: 'output', txt: 'output', plaintext: 'output', console: 'output', output: 'output', log: 'output',
}

const EXTENSION_LANGS: Record<string, Lang> = {
  sql: 'sql',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  py: 'python', pyi: 'python',
  rs: 'rust',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', css: 'css', json: 'json',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', ipynb: 'json',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', service: 'ini', timer: 'ini', socket: 'ini', mount: 'ini',
  path: 'ini', target: 'ini', network: 'ini', desktop: 'ini', editorconfig: 'ini', gitconfig: 'ini',
  wslconfig: 'ini', inputrc: 'ini', npmrc: 'ini',
  bashrc: 'bash', zshrc: 'bash', profile: 'bash', bash_profile: 'bash', bash_aliases: 'bash', bash_logout: 'bash',
  envrc: 'bash', surql: 'surql', bat: 'batch', cmd: 'batch',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', cs: 'c', swift: 'c',
  glsl: 'c', frag: 'c', vert: 'c', comp: 'c', geom: 'c', hlsl: 'c',
}

// Files with no grammar. Any other extension we don't know is code the engine colors better than the output rules would.
const TEXT_FILE = /\.(?:txt|text|log|out|output)$/i

/** A file's language for a diff or a new file's lines: its code's, or output for a text file; `undefined` leaves it to the engine. */
export function fileLang(path: string): Lang | undefined {
  return langFromPath(path) ?? (TEXT_FILE.test(path) ? 'output' : undefined)
}

/** The language a file is colored as, from its extension; `undefined` leaves it to the engine. */
export function langFromPath(path: string): Lang | undefined {
  // The part after the last dot of the name: digits too (.ps1), and dotfiles (~/.bash_profile).
  const match = /\.(\w+)$/.exec(path)
  const extension = match?.[1]?.toLowerCase()
  return extension && Object.hasOwn(EXTENSION_LANGS, extension) ? EXTENSION_LANGS[extension] : undefined // `a.constructor` is no language
}
