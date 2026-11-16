// parse.js — a fast, dependency-free drop-in for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML that marked.parse(markdown)
// returns with marked's default options (GFM on, breaks off, pedantic off,
// async off). No dependencies, no WASM, no native code, deterministic.
//
// Architecture: a block lexer turns the source into tokens (collecting link
// reference definitions as it goes), an inline lexer fills in the inline
// tokens afterwards (so a definition written later in the document still
// resolves an earlier link), and a renderer walks the tokens to HTML.
// The grammar follows the CommonMark 0.31.2 spec and the GFM 0.29
// extensions, matching marked's rendering decisions edge for edge.

// ---------------------------------------------------------------- helpers

// Compose a regex from parts: c(/.../).replace('name', /.../).getRegex().
// A `^` at the start of an inserted part (or after anything but `[`) is
// stripped, so the part can be inlined mid-pattern.
function c(a, e = '') {
  let t = typeof a === 'string' ? a : a.source;
  const n = {
    replace(s, r) {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(/(^|[^\[])\^/g, '$1');
      t = t.replace(s, o);
      return n;
    },
    getRegex() { return new RegExp(t, e); },
  };
  return n;
}

// Memoised regex factory keyed by indent level 0..3.
function D(a) {
  const e = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return e[n] || (e[n] = a(n));
  };
}

// ------------------------------------------------------------------ regexes

const K = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const T = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (a) => new RegExp(`^( {0,3}${a})((?:[ \t][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: D((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: D((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: D((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: D((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: D((a) => new RegExp(`^ {0,${a}}(?:</?(?:${K})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: D((a) => new RegExp(`^ {0,${a}}>`)),
};

// Block-level rules (GFM set; the only set used — defaults are GFM on).
const BLOCK = (() => {
  const newline = /^(?:[ \t]*(?:\n|$))+/;
  const code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
  const fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
  const hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  const heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
  const list = c(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, / {0,3}(?:[*+-]|\d{1,9}[.)])/).getRegex();
  const bullPat = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
  const blockCodePat = /(?: {4}| {0,3}\t)/;
  const fencesPat = / {0,3}(?:`{3,}|~{3,})/;
  const blockquotePat = / {0,3}>/;
  const headingPat = / {0,3}#{1,6}(?:\s|$)/;
  const hrPat = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
  const htmlTagPat = c(/ {0,3}(?:<\/?(?:tag)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)/).replace('tag', K).getRegex();
  const fencesPat2 = / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/;
  const paraSrc = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
  // Table (xe) — built first; the GFM paragraph needs its source.
  const table = c("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
    .replace('hr', hr).replace('heading', headingPat).replace('blockquote', blockquotePat)
    .replace('code', /(?: {4}| {0,3}\t)[^\n]/).replace('fences', fencesPat2)
    .replace('list', / {0,3}(?:[*+-]|1[.)])[ \t]/).replace('html', htmlTagPat).getRegex();
  // GFM paragraph.
  const paragraph = c(paraSrc)
    .replace('hr', hr).replace('heading', headingPat).replace('|lheading', '')
    .replace('table', table)
    .replace('blockquote', blockquotePat).replace('fences', fencesPat2)
    .replace('list', / {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/)
    .replace('html', htmlTagPat).getRegex();
  // Paragraph used inside blockquotes: no table, wider list pattern.
  const blockquoteParagraph = c(paraSrc)
    .replace('hr', hr).replace('heading', headingPat).replace('|lheading', '').replace('|table', '')
    .replace('blockquote', blockquotePat).replace('fences', fencesPat2)
    .replace('list', / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
    .replace('html', htmlTagPat).getRegex();
  const tablePat = / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/;
  const lheading = c(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
    .replace(/bull/g, bullPat).replace(/blockCode/g, blockCodePat).replace(/fences/g, fencesPat)
    .replace(/blockquote/g, blockquotePat).replace(/heading/g, headingPat).replace(/hr/g, hrPat)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, tablePat).getRegex();
  const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  const html = c('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
    .replace('comment', htmlComment).replace('tag', K)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
  const labelPat = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
  const titlePat = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/;
  const def = c(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
    .replace('label', labelPat).replace('title', titlePat).getRegex();
  const blockquote = c(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', blockquoteParagraph).getRegex();
  const text = /^[^\n]+/;
  return { newline, code, fences, hr, heading, list, paragraph, lheading, table, html, def, blockquote, text };
})();

// Inline rules (GFM set).
const INLINE = (() => {
  const escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
  const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
  const br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
  const punct = /[\p{P}\p{S}]/u;
  const punctSpace = /[\s\p{P}\p{S}]/u;
  const notPunctSpace = /[^\s\p{P}\p{S}]/u;
  const punctuation = c(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, punctSpace).getRegex();
  const emStrongLDelim = c(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u').replace(/punct/g, punct).getRegex();
  const rDelimAstSrc = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
  const rDelimAst = c(rDelimAstSrc, 'gu').replace(/notPunctSpace/g, notPunctSpace).replace(/punctSpace/g, punctSpace).replace(/punct/g, punct).getRegex();
  const rDelimUndSrc = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
  const rDelimUnd = c(rDelimUndSrc, 'gu').replace(/notPunctSpace/g, notPunctSpace).replace(/punctSpace/g, punctSpace).replace(/punct/g, punct).getRegex();
  const delLDelim = c(/^(~~?)(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, punct).getRegex();
  const delRDelimSrc = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
  const delRDelim = c(delRDelimSrc, 'gu').replace(/notPunctSpace/g, notPunctSpace).replace(/punctSpace/g, punctSpace).replace(/punct/g, punct).getRegex();
  const anyPunctuation = c(/\\(punct)/, 'gu').replace(/punct/g, punct).getRegex();
  const anyPunctuationOutsideCode = c(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, punct).getRegex();
  const autolink = c(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
  const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
  const tag = c("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
    .replace('comment', c(htmlComment).replace('(?:-->|$)', '-->').getRegex())
    .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
  const labelInner = /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
  const brackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  const label = c(labelInner).replace('brackets', brackets).getRegex();
  const hrefPat = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
  const titlePat = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
  const link = c(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace('label', label).replace('href', hrefPat).replace('title', titlePat).getRegex();
  const refLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
  const reflink = c(/^!?\[(label)\]\[(ref)\]/).replace('label', label).replace('ref', refLabel).getRegex();
  const nolink = c(/^!?\[(ref)\](?:\[\])?/).replace('ref', refLabel).getRegex();
  const reflinkSearchLabel = c(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', brackets).getRegex();
  const reflinkSearch = c('reflink|nolink(?!\\()', 'g')
    .replace('reflink', c(/^!?\[(label)\]\[(ref)\]/).replace('label', reflinkSearchLabel).replace('ref', /(?:\\[\s\S]|[^\[\]\\]){1,999}/).getRegex())
    .replace('nolink', c(/^!?\[(ref)\](?:\[\])?/).replace('ref', /(?:\\[\s\S]|[^\[\]\\]){1,999}/).getRegex()).getRegex();
  const blockSkip = c(/link|precode-code|html/, 'g')
    .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
    .replace('precode-', /(?<!`)()/)
    .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace('html', /<(?! )[^<>]*?>/).getRegex();
  const emailRe = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
  const url = c(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace('emailProtocol', c(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, emailRe).getRegex())
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex();
  const backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
  const text = c(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
    .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace('wwwStart', /(?<![^\s*_~(])www\./).getRegex();
  return { escape, code, br, punctuation, emStrongLDelim, emStrongRDelimAst: rDelimAst, emStrongRDelimUnd: rDelimUnd, delLDelim, delRDelim, anyPunctuation, anyPunctuationOutsideCode, autolink, tag, link, reflink, nolink, reflinkSearch, blockSkip, url, backpedal, text };
})();

// ------------------------------------------------------------------ helpers

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML. encode=true escapes & < > " ' unconditionally; encode=false
// leaves a & alone when it starts a valid entity or numeric character ref.
function escapeHtml(a, encode) {
  if (encode) {
    if (T.escapeTest.test(a)) return a.replace(T.escapeReplace, (ch) => ESCAPES[ch]);
  } else if (T.escapeTestNoEncode.test(a)) {
    return a.replace(T.escapeReplaceNoEncode, (ch) => ESCAPES[ch]);
  }
  return a;
}

// Decode numeric character references in inline text; a bare & (not part of
// a valid entity) becomes &amp;. Named entities pass through untouched.
function unescapeEntities(a) {
  if (a.indexOf('&') === -1) return a;
  if (!T.numericCharacterReference.test(a)) return a;
  return a.replace(T.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// encodeURI for hrefs, keeping literal % (marked's %25 -> % undo).
function encodeHref(a) {
  try { return encodeURI(a).replace(T.percentDecode, '%'); } catch { return null; }
}

// Split a table row on unescaped pipes; pad/truncate to `count` cells.
function splitTableRow(a, count) {
  const t = a.replace(T.findPipe, (r, o, i) => {
    let escaped = false;
    let p = o;
    while (--p >= 0 && i[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(T.splitPipe);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let s = 0; s < cells.length; s++) cells[s] = cells[s].trim().replace(T.slashPipe, '|');
  return cells;
}

// Strip trailing newlines from a string (keeps at most one).
function trimTrailingNewlines(a) {
  return a.replace(T.endingNewline, '') + '\n';
}

// Drop trailing blank lines from a block's raw text (keeps at most one \n).
// Manual backward scan: only the trailing lines are inspected, no split.
function trimBlankLines(a) {
  let i = a.length;
  let blankCount = 0;
  let lastNonBlankEnd = 0;
  while (i > 0) {
    const nl = a.lastIndexOf('\n', i - 1);
    const lineStart = nl === -1 ? 0 : nl + 1;
    let blank = true;
    for (let k = lineStart; k < i; k++) {
      const c = a.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank) { lastNonBlankEnd = i; break; }
    blankCount++;
    if (nl === -1) break;
    i = nl;
  }
  return blankCount <= 1 ? a : a.slice(0, lastNonBlankEnd);
}

// Normalise a link label for lookup: collapse whitespace, Unicode case-fold.
function normalizeLabel(a) {
  return a.trim().replace(T.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces to the next multiple of 4, tracking the column.
function expandTabs(s, col = 0) {
  let t = col, out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (t % 4);
      out += ' '.repeat(r);
      t += r;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Find the first unbalanced closing paren in a href: -1 none, -2 too many
// opens, else the index of the first unmatched close.
function findUnbalancedParen(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') { n++; continue; }
    if (a[n] === pair[0]) depth++;
    else if (a[n] === pair[1]) {
      depth--;
      if (depth < 0) return n;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Strip a trailing run of `ch` from a string (used for closing ATX hashes).
function stripTrailing(a, ch) {
  const n = a.length;
  if (n === 0) return '';
  let s = 0;
  for (;;) {
    const r = a.charAt(n - s - 1);
    if (r === ch) s++;
    else break;
  }
  return a.slice(0, n - s);
}

// Scan a masked source for the last index a closer run could start at, for
// `*` and `_` (em/strong) and `~` (strikethrough). A run counts as a
// possible closer when the character before it is not blank.
const CLOSER_RUN = /(\*+|_+|~+)/g;
function scanClosers(masked) {
  const last = { '*': -1, '_': -1 };
  let lastDel = -1;
  CLOSER_RUN.lastIndex = 0;
  let m;
  while ((m = CLOSER_RUN.exec(masked)) !== null) {
    const s = m.index;
    const r = m[0][0];
    const prev = s === 0 ? '\n' : masked[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (r === '~') lastDel = s;
      else last[r] = s;
    }
  }
  return { last, lastDel };
}

// ---------------------------------------------------------- block lexer

// Per-parse state: the token list (with its link-reference map), the queue
// of inline sources waiting to be lexed, and the lexer flags.
function createLexer() {
  const tokens = [];
  tokens.links = Object.create(null);
  const inlineQueue = [];
  const state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };

  // Queue an inline source for later lexing; returns the (initially empty)
  // token array that will be filled in.
  function inline(src) {
    const t = [];
    inlineQueue.push({ src, tokens: t });
    return t;
  }

  function space(src) {
    const t = BLOCK.newline.exec(src);
    if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
  }

  function code(src) {
    const t = BLOCK.code.exec(src);
    if (t) {
      const raw = trimBlankLines(t[0]);
      return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(T.codeRemoveIndent, '') };
    }
  }

  function fences(src) {
    const t = BLOCK.fences.exec(src);
    if (t) {
      const raw = t[0];
      let text = t[3] || '';
      const m = raw.match(T.indentCodeCompensation);
      if (m !== null) {
        const indent = m[1];
        text = text.split('\n').map((line) => {
          const o = line.match(T.beginningSpace);
          if (o === null) return line;
          return line.slice(Math.min(o[0].length, indent.length));
        }).join('\n');
      }
      return { type: 'code', raw, lang: t[2] ? t[2].trim().replace(INLINE.anyPunctuation, '$1') : t[2], text };
    }
  }

  function heading(src) {
    const t = BLOCK.heading.exec(src);
    if (t) {
      let text = t[2].trim();
      if (T.endingHash.test(text)) {
        const stripped = stripTrailing(text, '#');
        if (!stripped || T.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[1].length, text, tokens: inline(text) };
    }
  }

  function hr(src) {
    const t = BLOCK.hr.exec(src);
    if (t) return { type: 'hr', raw: stripTrailing(t[0], '\n') };
  }

  function html(src) {
    const t = BLOCK.html.exec(src);
    if (t) {
      const raw = trimBlankLines(t[0]);
      return { type: 'html', block: true, raw, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: raw };
    }
  }

  function def(src) {
    const t = BLOCK.def.exec(src);
    if (t) {
      if (!T.startAngleBracket.test(t[2]) && findUnbalancedParen(t[2], '()') !== -1) return;
      const tag = normalizeLabel(t[1]);
      const href = t[2] ? t[2].replace(T.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
      const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(INLINE.anyPunctuation, '$1') : t[3];
      return { type: 'def', tag, raw: stripTrailing(t[0], '\n'), href, title };
    }
  }

  function table(src) {
    const t = BLOCK.table.exec(src);
    if (!t || !T.tableDelimiter.test(t[2])) return;
    const headerCells = splitTableRow(t[1]);
    const delimCells = t[2].replace(T.tableAlignChars, '').split('|');
    const bodyLines = t[3]?.trim() ? t[3].replace(T.tableRowBlankLine, '').split('\n') : [];
    const tok = { type: 'table', raw: stripTrailing(t[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === delimCells.length) {
      for (const cell of delimCells) {
        if (T.tableAlignRight.test(cell)) tok.align.push('right');
        else if (T.tableAlignCenter.test(cell)) tok.align.push('center');
        else if (T.tableAlignLeft.test(cell)) tok.align.push('left');
        else tok.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        tok.header.push({ text: headerCells[i], tokens: inline(headerCells[i]), header: true, align: tok.align[i] });
      }
      for (const line of bodyLines) {
        tok.rows.push(splitTableRow(line, tok.header.length).map((cell, p) => ({ text: cell, tokens: inline(cell), header: false, align: tok.align[p] })));
      }
      return tok;
    }
  }

  function lheading(src) {
    const t = BLOCK.lheading.exec(src);
    if (t) {
      const text = t[1].trim();
      return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text, tokens: inline(text) };
    }
  }

  function paragraph(src) {
    const t = BLOCK.paragraph.exec(src);
    if (t) {
      const text = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
      return { type: 'paragraph', raw: t[0], text, tokens: inline(text) };
    }
  }

  function text(src) {
    const t = BLOCK.text.exec(src);
    if (t) return { type: 'text', raw: t[0], text: t[0], tokens: inline(t[0]) };
  }

  function blockquote(src) {
    const t = BLOCK.blockquote.exec(src);
    if (!t) return;
    const lines = stripTrailing(t[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const toks = [];
    let rest = lines;
    while (rest.length > 0) {
      let hasQuote = false;
      const chunk = [];
      let p;
      for (p = 0; p < rest.length; p++) {
        if (T.blockquoteStart.test(rest[p])) { chunk.push(rest[p]); hasQuote = true; }
        else if (!hasQuote) chunk.push(rest[p]);
        else break;
      }
      rest = rest.slice(p);
      const h = chunk.join('\n');
      const u = h
        .replace(T.blockquoteMarkerWhitespace, (g, b, m) => b + expandTabs(m, b.length))
        .replace(T.blockquoteSetextReplace, '\n    $1')
        .replace(T.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${h}` : h;
      text = text ? `${text}\n${u}` : u;
      const prevTop = state.top;
      state.top = true;
      blockTokens(u, toks, true);
      state.top = prevTop;
      if (rest.length === 0) break;
      const k = toks.at(-1);
      if (k?.type === 'code' || k?.type === 'heading' || k?.type === 'hr' || k?.type === 'html' || k?.type === 'table') break;
      if (k?.type === 'blockquote') {
        const g = k;
        const b = rest.join('\n');
        const m = g.raw + '\n' + b.replace(T.blockquoteSetextReplace2, '');
        const f = blockquote(m);
        toks[toks.length - 1] = f;
        const y = m.substring(f.raw.length).replace(/^\n/, '');
        const r = y ? y.split('\n').length : 0;
        const taken = r ? rest.slice(0, -r) : rest;
        if (taken.length > 0) raw = `${raw}\n${taken.join('\n')}`;
        text = text.substring(0, text.length - g.text.length) + f.text;
        rest = rest.slice(taken.length);
        if (rest.length > 0 && T.blockquoteStart.test(rest[0])) continue;
        break;
      } else if (k?.type === 'list') {
        const g = k;
        const b = g.raw + '\n' + rest.join('\n');
        const m = list(b);
        toks[toks.length - 1] = m;
        const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
        if (f > 0) {
          const y = rest.slice(0, f).join('\n');
          raw = `${raw}\n${y}`;
          text = `${text}\n${y}`;
        }
        rest = rest.slice(f);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens: toks, text };
  }

  function list(src) {
    const t = BLOCK.list.exec(src);
    if (!t) return;
    let rest = src;
    const totalLen = src.length;
    const consumed = () => totalLen - rest.length;
    const marker = t[1].trim();
    const ordered = marker.length > 1;
    const tok = { type: 'list', raw: '', ordered, start: ordered ? +marker.slice(0, -1) : '', loose: false, items: [] };
    const markerRe = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = T.listItemRegex(markerRe);
    let prevBlank = false;
    while (rest) {
      let isEmpty = false;
      let itemText = '';
      const m = itemRe.exec(rest);
      if (!m || BLOCK.hr.test(rest)) break;
      const startPos = consumed();
      rest = rest.substring(m[0].length);
      const firstLine = m[2].split('\n', 1)[0];
      const markerLen = m[1].length;
      const content = firstLine.replace(T.leadingSpaceTab, (v) => expandTabs(v, markerLen));
      let nextLine = rest.split('\n', 1)[0];
      const firstBlank = !content.trim();
      let indent;
      if (firstBlank) indent = markerLen + 1;
      else {
        indent = content.search(T.nonSpaceChar);
        if (indent > 4) indent = 1;
        itemText = content.slice(indent);
        indent += markerLen;
      }
      if (firstBlank && T.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        isEmpty = true;
      }
      if (!isEmpty) {
        const nextBullet = T.nextBulletRegex(indent);
        const hrRe = T.hrRegex(indent);
        const fencesRe = T.fencesBeginRegex(indent);
        const headingRe = T.headingBeginRegex(indent);
        const htmlRe = T.htmlBeginRegex(indent);
        const bqRe = T.blockquoteBeginRegex(indent);
        let cur = content;
        let prevLineBlank = firstBlank;
        while (rest) {
          const line = rest.split('\n', 1)[0];
          if (fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) || bqRe.test(line) || nextBullet.test(line) || hrRe.test(line)) break;
          const expanded = line.replace(T.leadingSpaceTab, (v) => expandTabs(v));
          if (expanded.search(T.nonSpaceChar) >= indent || !line.trim()) itemText += '\n' + expanded.slice(indent);
          else {
            if (prevLineBlank || cur.replace(T.tabCharGlobal, '    ').search(T.nonSpaceChar) >= 4 || fencesRe.test(cur) || headingRe.test(cur) || htmlRe.test(cur) || hrRe.test(cur)) break;
            const setextLine = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${cur}\n${line}`);
            itemText += '\n' + (setextLine ? `    ${expanded.replace(/^ {0,3}/, '')}` : line);
          }
          prevLineBlank = !line.trim();
          rest = rest.substring(line.length + 1);
          cur = expanded.slice(indent);
        }
      }
      const raw = src.slice(startPos, consumed());
      if (!tok.loose) {
        if (prevBlank) tok.loose = true;
        else if (T.doubleBlankLine.test(raw)) prevBlank = true;
      }
      tok.items.push({ type: 'list_item', raw, task: T.listIsTask.test(itemText), loose: false, text: itemText, tokens: [] });
    }
    const last = tok.items.at(-1);
    if (last) { last.raw = last.raw.trimEnd(); last.text = last.text.trimEnd(); }
    else return;
    tok.raw = src.slice(0, consumed()).trimEnd();
    for (const item of tok.items) {
      state.top = false;
      item.tokens = blockTokens(item.text, []);
      if (!tok.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        if (spaces.length > 0 && spaces.some((g) => T.anyLine.test(g.raw))) tok.loose = true;
      }
    }
    for (const item of tok.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(T.listReplaceTask, '');
        first.raw = first.raw.replace(T.listReplaceTask, '');
        first.text = first.text.replace(T.listReplaceTask, '');
        for (let g = inlineQueue.length - 1; g >= 0; g--) {
          if (T.listIsTask.test(inlineQueue[g].src)) {
            inlineQueue[g].src = inlineQueue[g].src.replace(T.listReplaceTask, '');
            break;
          }
        }
        const cb = T.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = box.checked;
          if (tok.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
          } else item.tokens.unshift(box);
        }
      } else if (item.task) item.task = false;
    }
    if (tok.loose) {
      for (const item of tok.items) {
        item.loose = true;
        for (const d of item.tokens) if (d.type === 'text') d.type = 'paragraph';
      }
    }
    return tok;
  }

  // The block-level loop. `inBlock` is true when lexing a blockquote's
  // chunk: a leading paragraph then merges into the previous one.
  function blockTokens(src, out = [], inBlock = false) {
    let guard = Infinity;
    let n = inBlock;
    while (src) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = space(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else out.push(tok);
        continue;
      }
      if ((tok = code(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          inlineQueue[inlineQueue.length - 1].src = prev.text;
        } else out.push(tok);
        continue;
      }
      if ((tok = fences(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = heading(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = hr(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = blockquote(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = list(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = html(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = def(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          inlineQueue[inlineQueue.length - 1].src = prev.text;
        } else {
          if (!tokens.links[tok.tag]) tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          out.push(tok);
        }
        continue;
      }
      if ((tok = table(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if ((tok = lheading(src))) { src = src.substring(tok.raw.length); out.push(tok); continue; }
      if (state.top && (tok = paragraph(src))) {
        const prev = out[out.length - 1];
        if (n && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          inlineQueue.pop();
          inlineQueue[inlineQueue.length - 1].src = prev.text;
        } else out.push(tok);
        n = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = text(src))) {
        src = src.substring(tok.raw.length);
        const prev = out[out.length - 1];
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          inlineQueue.pop();
          inlineQueue[inlineQueue.length - 1].src = prev.text;
        } else out.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    state.top = true;
    return out;
  }

  // --- inline lexer -------------------------------------------------------

  // Does `src` contain a link? Used while masking sources for emphasis.
  function linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(tokens.links, normalizeLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1)))) return true;
    }
    return false;
  }

  // Mask a source for delimiter scanning: link labels, code spans and HTML
  // become runs of 'a' so a `*` inside them is never read as emphasis.
  function maskSrc(src) {
    let t = src;
    if (src.includes('[')) {
      const n = INLINE.reflinkSearch;
      const sub = (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(tokens.links, normalizeLabel(r.slice(o + 1, -1)))) return r;
        if (o > 1 && r.charAt(0) !== '!') {
          const inner = r.slice(1, o - 1);
          if (linkInText(inner)) return '[' + inner.replace(n, sub) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      t = t.replace(n, sub);
    }
    t = t.replace(INLINE.anyPunctuationOutsideCode, (n, s, r) => (r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n));
    t = t.replace(INLINE.blockSkip, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
    return t;
  }

  // The masked source + closer scan for the inline string currently being
  // lexed. Saved/restored around recursive inlineTokens calls.
  let currentMask = { masked: '', closers: null };

  function escapeTok(src) {
    const t = INLINE.escape.exec(src);
    if (t) return { type: 'escape', raw: t[0], text: t[1] };
  }

  function tagTok(src) {
    const t = INLINE.tag.exec(src);
    if (t) {
      if (!state.inLink && T.startATag.test(t[0])) state.inLink = true;
      else if (state.inLink && T.endATag.test(t[0])) state.inLink = false;
      if (!state.inRawBlock && T.startPreScriptTag.test(t[0])) state.inRawBlock = true;
      else if (state.inRawBlock && T.endPreScriptTag.test(t[0])) state.inRawBlock = false;
      return { type: 'html', raw: t[0], inLink: state.inLink, inRawBlock: state.inRawBlock, block: false, text: t[0] };
    }
  }

  // Is there an unclosed tag/autolink inside the link label `label`?
  // `full` is the whole remaining source, `off` the label's start in it.
  function hasTagInLabel(full, label, off) {
    if (!label.includes('<')) return false;
    for (let s = 0; s < label.length; s++) {
      if (label[s] === '\\') { s++; continue; }
      if (label[s] === '`') {
        const i = INLINE.code.exec(label.slice(s));
        if (i) { s += i[0].length - 1; continue; }
      }
      if (label[s] !== '<') continue;
      const r = full.slice(off + s);
      const o = INLINE.tag.exec(r) || INLINE.autolink.exec(r);
      if (o) {
        if (o[0].length > label.length - s) return true;
        s += o[0].length - 1;
      }
    }
    return false;
  }

  // Build a link or image token from a matched `m` (link/reflink/nolink).
  function makeLink(m, dest, raw) {
    const href = dest.href;
    const title = dest.title || null;
    const text = m[1].replace(T.outputLinkReplace, '$1');
    const isImage = m[0].charAt(0) === '!';
    const prevInLink = state.inLink;
    const prevEmitted = state.linkEmitted;
    const prevRawBlock = state.inRawBlock;
    state.inLink = true;
    state.linkEmitted = false;
    const inner = inlineTokens(text);
    const emittedInside = state.linkEmitted;
    state.linkEmitted = prevEmitted;
    state.inLink = prevInLink;
    if (!isImage) {
      if (emittedInside) { state.inRawBlock = prevRawBlock; return; }
      state.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens: inner };
  }

  function linkTok(src) {
    if (state.linkParenPossible === false) return;
    const t = INLINE.link.exec(src);
    if (!t) return;
    const off = t[0].charAt(0) === '!' ? 2 : 1;
    if (hasTagInLabel(src, t[1], off)) return;
    let href = t[2].trim();
    if (T.startAngleBracket.test(href)) {
      if (!T.endAngleBracket.test(href)) return;
      const stripped = stripTrailing(href.slice(0, -1), '\\');
      if ((href.length - stripped.length) % 2 === 0) return;
    } else {
      const unbalanced = findUnbalancedParen(t[2], '()');
      if (unbalanced === -2) return;
      if (unbalanced > -1) {
        const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + unbalanced;
        t[2] = t[2].substring(0, unbalanced);
        t[0] = t[0].substring(0, h).trim();
        t[3] = '';
      }
    }
    const r = stripTrailing(t[0].slice(0, -1), '\\');
    if ((t[0].length - r.length) % 2 === 0) return;
    let dest = t[2];
    let title = t[3] ? t[3].slice(1, -1) : '';
    dest = dest.trim();
    if (T.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
    return makeLink(t, { href: dest && dest.replace(INLINE.anyPunctuation, '$1'), title: title && title.replace(INLINE.anyPunctuation, '$1') }, t[0]);
  }

  function reflinkTok(src) {
    const n = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!n) return;
    const off = n[0].charAt(0) === '!' ? 2 : 1;
    if (hasTagInLabel(src, n[1], off)) return;
    const dest = tokens.links[normalizeLabel(n[2] || n[1])];
    if (!dest) {
      const ch = n[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLink(n, dest, n[0]);
  }

  function emStrong(src, masked, prevChar = '') {
    const s = INLINE.emStrongLDelim.exec(src);
    if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return;
    const delim = s[0][0];
    const sameAsPrev = prevChar === delim;
    const i = masked.length - src.length;
    let l = i;
    while (l > 0 && masked[l - 1] === delim) l--;
    const before = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const beforeIsDelimOrPunct = before === '*' || before === '_' || !!INLINE.punctuation.exec(before);
    if (l < i) prevChar = before;
    const prevIsPunct = l < i ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prevChar);
    if (s[4] && prevChar.match(T.unicodeAlphaNumeric)) return;
    const followingPunct = s[1] || s[3] || '';
    if (!followingPunct || !prevChar || prevIsPunct) {
      const runLen = [...s[0]].length - 1;
      let g, b, m = runLen, extra = 0;
      const total = i - l + runLen;
      const allowSingle = !!before.trim() && (!!followingPunct || (delim === '*' && !beforeIsDelimOrPunct));
      if (delim !== '*' && delim !== '_') return;
      const rDelim = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = currentMask.closers ? currentMask.closers.last[delim] : -1;
      const searchFrom = masked.length - src.length + runLen;
      if (lastCloser < searchFrom) return;
      const rest = masked.slice(-1 * src.length + runLen);
      const maxIdx = lastCloser - searchFrom;
      let mm;
      for (rDelim.lastIndex = 0; (mm = rDelim.exec(rest)) !== null && !(mm.index > maxIdx);) {
        g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
        if (!g) continue;
        b = [...g].length;
        if (mm[3] || mm[4]) { m += b; continue; }
        if (mm[5] || mm[6] || allowSingle) {
          if (sameAsPrev && (mm[5] || mm[6])) break;
          if (total % 3 && !((total + b) % 3)) { extra += b; continue; }
        }
        m -= b;
        if (m > 0) continue;
        b = Math.min(b, b + m + extra);
        const firstLen = [...mm[0]][0].length;
        const raw = src.slice(0, runLen + mm.index + firstLen + b);
        if (Math.min(runLen, b) % 2) {
          const text = raw.slice(1, -1);
          return { type: 'em', raw, text, tokens: inlineTokens(text) };
        }
        const text = raw.slice(2, -2);
        return { type: 'strong', raw, text, tokens: inlineTokens(text) };
      }
    }
  }

  function codespanTok(src) {
    const t = INLINE.code.exec(src);
    if (t) {
      let text = t[2].replace(T.newLineCharGlobal, ' ');
      const hasNonSpace = T.nonSpaceChar.test(text);
      const wrapped = T.startingSpaceChar.test(text) && T.endingSpaceChar.test(text);
      if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: t[0], text };
    }
  }

  function brTok(src) {
    const t = INLINE.br.exec(src);
    if (t) return { type: 'br', raw: t[0] };
  }

  function delTok(src, masked, prevChar = '') {
    const s = INLINE.delLDelim.exec(src);
    if (!s) return;
    if (!(s[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      const runLen = [...s[0]].length - 1;
      let g, l, p = runLen;
      const rDelim = INLINE.delRDelim;
      const lastCloser = currentMask.closers ? currentMask.closers.lastDel : -1;
      const searchFrom = masked.length - src.length + runLen;
      if (lastCloser < searchFrom) return;
      const rest = masked.slice(-1 * src.length + runLen);
      const maxIdx = lastCloser - searchFrom;
      let mm;
      for (rDelim.lastIndex = 0; (mm = rDelim.exec(rest)) !== null && !(mm.index > maxIdx);) {
        g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
        if (!g) continue;
        l = [...g].length;
        if (l !== runLen) continue;
        if (mm[3] || mm[4]) { p += l; continue; }
        p -= l;
        if (p > 0) continue;
        l = Math.min(l, l + p);
        const firstLen = [...mm[0]][0].length;
        const raw = src.slice(0, runLen + mm.index + firstLen + l);
        const text = raw.slice(runLen, -runLen);
        return { type: 'del', raw, text, tokens: inlineTokens(text) };
      }
    }
  }

  function autolinkTok(src) {
    const t = INLINE.autolink.exec(src);
    if (t) {
      let text, href;
      if (t[2] === '@') { text = t[1]; href = 'mailto:' + text; }
      else { text = t[1]; href = text; }
      return { type: 'link', raw: t[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }

  function urlTok(src) {
    const t = INLINE.url.exec(src);
    if (!t) return;
    let text, href;
    if (t[2] === '@') { text = t[0]; href = 'mailto:' + text; }
    else {
      let r;
      do { r = t[0]; t[0] = INLINE.backpedal.exec(t[0])?.[0] ?? ''; } while (r !== t[0]);
      text = t[0];
      href = t[1] === 'www.' ? 'http://' + t[0] : t[0];
    }
    return { type: 'link', raw: t[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }

  // Fast plain-text scan: one native regex finds the next stop (a special
  // character or a hard break). If the run holds a URL/email hint, fall back
  // to the exact text regex so autolinks and emails are detected byte-exactly.
  const TEXT_STOP = /[\\<!\[`*_~]| {2,}\n/;
  function inlineTextTok(src) {
    const m = TEXT_STOP.exec(src);
    const end = m ? m.index : src.length;
    if (end > 0) {
      const raw = src.slice(0, end);
      if (raw.indexOf('www.') === -1 && raw.indexOf('://') === -1 && raw.indexOf('mailto:') === -1 && raw.indexOf('xmpp:') === -1 && raw.indexOf('@') === -1) {
        const inRaw = state.inRawBlock;
        return { type: 'text', raw, text: inRaw ? raw : unescapeEntities(raw), escaped: inRaw };
      }
    }
    const t = INLINE.text.exec(src);
    if (t) {
      const inRaw = state.inRawBlock;
      return { type: 'text', raw: t[0], text: inRaw ? t[0] : unescapeEntities(t[0]), escaped: inRaw };
    }
  }

  // Lex one inline source into `out`. The masked source and its closer
  // scan are computed once per call and shared with emStrong/del.
  function inlineTokens(src, out = []) {
    const prevParen = state.linkParenPossible;
    state.linkParenPossible = prevParen && src.includes(')');
    try {
      let masked = src;
      let closers = null;
      if (/[*_~]/.test(src)) {
        // Nothing to hide (no links, code spans, HTML or backslash escapes)
        // means the source is already its own mask — skip three regex scans.
        masked = (!src.includes('[') && !src.includes('`') && !src.includes('<') && !src.includes('\\')) ? src : maskSrc(src);
        closers = scanClosers(masked);
      }
      const prevMask = currentMask;
      currentMask = { masked, closers };
      try {
        let prevChar = '';
        let guard = Infinity;
        let e = src;
        let justText = false;
        let last = out.length ? out[out.length - 1] : undefined;
        while (e) {
          if (e.length < guard) guard = e.length;
          else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
          if (!justText) prevChar = '';
          justText = false;
          // Dispatch on the first character: only the tokenizers that can
          // possibly match at this position are tried, in marked's order.
          const ch = e.charCodeAt(0);
          let tok;
          if (ch === 92) { // backslash
            tok = escapeTok(e) || brTok(e);
          } else if (ch === 60) { // <
            tok = tagTok(e) || autolinkTok(e);
          } else if (ch === 91 || ch === 33) { // [ or !
            tok = linkTok(e) || reflinkTok(e);
          } else if (ch === 42 || ch === 95) { // * or _
            tok = emStrong(e, masked, prevChar);
          } else if (ch === 96) { // backtick
            tok = codespanTok(e);
          } else if (ch === 126) { // ~
            tok = delTok(e, masked, prevChar);
          } else if (ch === 32) { // space
            tok = brTok(e);
          } else if ((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) {
            // letter or digit: only a GFM extended autolink can start here
            tok = !state.inLink ? urlTok(e) : undefined;
          }
          if (tok) {
            e = e.substring(tok.raw.length);
            if (tok.type === 'text') {
              if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
              else { out.push(tok); last = tok; }
            } else { out.push(tok); last = tok; }
            continue;
          }
          if ((tok = inlineTextTok(e))) {
            e = e.substring(tok.raw.length);
            if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
            justText = true;
            if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
            else { out.push(tok); last = tok; }
            continue;
          }
          if (e) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
        }
        return out;
      } finally {
        currentMask = prevMask;
      }
    } finally {
      state.linkParenPossible = prevParen;
    }
  }

  // Top-level lex: normalise line endings, lex blocks, then fill in every
  // queued inline token list.
  function lex(src) {
    src = src.replace(T.carriageReturn, '\n');
    blockTokens(src, tokens);
    for (let i = 0; i < inlineQueue.length; i++) {
      const item = inlineQueue[i];
      state.inRawBlock = false;
      inlineTokens(item.src, item.tokens);
    }
    inlineQueue.length = 0;
    return tokens;
  }

  return { tokens, inlineQueue, state, inline, blockTokens, lex, blockquote, list, inlineTokens };
}

// ------------------------------------------------------------- renderer

// Render block tokens to HTML.
function renderTokens(tokens, out) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'space': break;
      case 'hr': out.push('<hr>\n'); break;
      case 'heading': {
        out.push('<h', String(tok.depth), '>');
        renderInline(tok.tokens, out);
        out.push('</h', String(tok.depth), '>\n');
        break;
      }
      case 'code': {
        const lang = (tok.lang || '').match(T.notSpaceStart)?.[0];
        const text = tok.text ? tok.text.replace(T.endingNewline, '') + '\n' : '';
        const body = escapeHtml(text, true);
        if (lang) out.push('<pre><code class="language-', escapeHtml(lang), '">', body, '</code></pre>\n');
        else out.push('<pre><code>', body, '</code></pre>\n');
        break;
      }
      case 'table': {
        let head = '';
        for (let r = 0; r < tok.header.length; r++) head += renderCell(tok.header[r]);
        let body = '';
        for (let r = 0; r < tok.rows.length; r++) {
          let row = '';
          for (let c = 0; c < tok.rows[r].length; c++) row += renderCell(tok.rows[r][c]);
          body += '<tr>\n' + row + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out.push('<table>\n<thead>\n<tr>\n', head, '</tr>\n</thead>\n', body, '</table>\n');
        break;
      }
      case 'blockquote': {
        out.push('<blockquote>\n');
        renderTokens(tok.tokens, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out.push('<', tag, start, '>\n');
        for (let j = 0; j < tok.items.length; j++) {
          out.push('<li>');
          renderTokens(tok.items[j].tokens, out);
          out.push('</li>\n');
        }
        out.push('</', tag, '>\n');
        break;
      }
      case 'checkbox': out.push('<input ', tok.checked ? 'checked="" ' : '', 'disabled="" type="checkbox"> '); break;
      case 'html': out.push(tok.text); break;
      case 'def': break;
      case 'paragraph': {
        out.push('<p>');
        renderInline(tok.tokens, out);
        out.push('</p>\n');
        break;
      }
      case 'text': {
        if ('tokens' in tok && tok.tokens) renderInline(tok.tokens, out);
        else if ('escaped' in tok && tok.escaped) out.push(tok.text);
        else out.push(escapeHtml(tok.text));
        break;
      }
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ' align="' + cell.align + '"' : '';
  const parts = [];
  renderInline(cell.tokens, parts);
  return '<' + tag + align + '>' + parts.join('') + '</' + tag + '>\n';
}

// Render inline tokens to HTML.
function renderInline(tokens, out) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'escape': out.push(escapeHtml(tok.text)); break;
      case 'html': out.push(tok.text); break;
      case 'link': {
        const content = tok.autolink ? escapeHtml(tok.text, true) : inlineToString(tok.tokens);
        const href = encodeHref(tok.href);
        if (href === null) { out.push(content); break; }
        let a = '<a href="' + escapeHtml(href, tok.autolink) + '"';
        if (tok.title) a += ' title="' + escapeHtml(tok.title) + '"';
        out.push(a, '>', content, '</a>');
        break;
      }
      case 'image': {
        const text = tok.tokens ? inlinePlainText(tok.tokens) : tok.text;
        const href = encodeHref(tok.href);
        if (href === null) { out.push(escapeHtml(text)); break; }
        let img = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(text) + '"';
        if (tok.title) img += ' title="' + escapeHtml(tok.title) + '"';
        out.push(img, '>');
        break;
      }
      case 'checkbox': out.push('<input ', tok.checked ? 'checked="" ' : '', 'disabled="" type="checkbox"> '); break;
      case 'strong': out.push('<strong>', inlineToString(tok.tokens), '</strong>'); break;
      case 'em': out.push('<em>', inlineToString(tok.tokens), '</em>'); break;
      case 'codespan': out.push('<code>', escapeHtml(tok.text, true), '</code>'); break;
      case 'br': out.push('<br>'); break;
      case 'del': out.push('<del>', inlineToString(tok.tokens), '</del>'); break;
      case 'text': {
        if ('tokens' in tok && tok.tokens) renderInline(tok.tokens, out);
        else if ('escaped' in tok && tok.escaped) out.push(tok.text);
        else out.push(escapeHtml(tok.text));
        break;
      }
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

function inlineToString(tokens) {
  const parts = [];
  renderInline(tokens, parts);
  return parts.join('');
}

// Render inline tokens as plain text (image alt text): no markup, just the
// words, with code spans and HTML kept as their text.
function inlinePlainText(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    switch (tok.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += tok.tokens ? inlinePlainText(tok.tokens) : tok.text;
        break;
      case 'codespan': case 'html': case 'text': case 'escape':
        out += tok.text;
        break;
      case 'br': break;
      case 'checkbox': out += tok.raw; break;
      default: break;
    }
  }
  return out;
}

// ------------------------------------------------------------------- entry

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const lexer = createLexer();
  const tokens = lexer.lex(markdown);
  const out = [];
  renderTokens(tokens, out);
  return out.join('');
}
