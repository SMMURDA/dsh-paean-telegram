import test from 'node:test';
import assert from 'node:assert/strict';
import { cellDisplayWidth, markdownTablePreBlock, markdownToHtml } from '../dist/telegram/markdown.js';
import { splitText } from '../dist/telegram/html.js';

test('markdownToHtml renders the issue example without literal markers', () => {
  const input = [
    '# Heading',
    '',
    '**bold** and *italic*',
    '',
    '- item one',
    '- item two',
    '',
    '`inline code`',
    '',
    '[documentation](https://example.com)',
  ].join('\n');
  const html = markdownToHtml(input);
  assert.equal(html.includes('**'), false, 'bold markers are gone');
  assert.equal(html.includes('`inline'), false, 'code markers are gone');
  assert.match(html, /<b>Heading<\/b>/);
  assert.match(html, /<b>bold<\/b> and <i>italic<\/i>/);
  assert.match(html, /• item one/);
  assert.match(html, /• item two/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com">documentation<\/a>/);
});

test('markdownToHtml supports strong/emphasis/strike/blockquote and nested inline', () => {
  assert.equal(markdownToHtml('__bold__'), '<b>bold</b>');
  assert.equal(markdownToHtml('*italic*'), '<i>italic</i>');
  assert.equal(markdownToHtml('_italic_'), '<i>italic</i>');
  assert.equal(markdownToHtml('~~strike~~'), '<s>strike</s>');
  assert.equal(markdownToHtml('**bold *nested***'), '<b>bold <i>nested</i></b>');
  assert.equal(markdownToHtml('> quoted **bold**'), '<blockquote>quoted <b>bold</b></blockquote>');
});

test('markdownToHtml leaves word-internal underscores and arithmetic untouched', () => {
  assert.equal(markdownToHtml('snake_case_name'), 'snake_case_name');
  assert.equal(markdownToHtml('2*3*4'), '2*3*4');
});

test('markdownToHtml HTML-escapes plain text and code bodies', () => {
  assert.equal(markdownToHtml('a <b> & "quoted"'), 'a &lt;b&gt; &amp; &quot;quoted&quot;');
  assert.equal(markdownToHtml('`<x> & y`'), '<code>&lt;x&gt; &amp; y</code>');
  assert.equal(markdownToHtml('&amp;'), '&amp;amp;');
});

test('malformed model markup degrades to readable text instead of raw tags', () => {
  const malformed = '**bold without close and <script>alert(1)</script>';
  const html = markdownToHtml(malformed);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('fenced code blocks become escaped <pre><code> blocks (#30)', () => {
  const html = markdownToHtml('```js\nconst x = "<tag>";\n```');
  assert.equal(html, '<pre><code class="language-js">const x = &quot;&lt;tag&gt;&quot;;</code></pre>');
});

test('fenced code without a language still wraps in <pre><code> (#30)', () => {
  assert.equal(markdownToHtml('```\nplain\n```'), '<pre><code>plain</code></pre>');
});

test('fence language info is sanitized instead of leaking markup (#30)', () => {
  const html = markdownToHtml('```"><b onclick="x">\nboom\n```');
  assert.equal(html, '<pre><code>boom</code></pre>');
});

test('GFM tables become aligned monospace blocks instead of raw pipes (#19, #30)', () => {
  const html = markdownToHtml([
    '| 消息 | 文件 | 大小 |',
    '|---|---|---|',
    '| 📌 ① | `a.xlsx` | 26,666B |',
    '| 📌 ② | `b.csv` | 39,723B |',
    '',
    '**三个文件已发送**',
  ].join('\n'));
  assert.match(html, /<pre><code>\| 消息\s+\| 文件\s+\| 大小\s+\|/);
  assert.match(html, /\| 📌 ① \| `a\.xlsx`\s+\| 26,666B\s+\|/);
  assert.equal(html.includes('|---|'), false, 'separator syntax is replaced');
  assert.match(html, /<\/code><\/pre>/, 'table block closes both code and pre');
  assert.match(html, /<b>三个文件已发送<\/b>/, 'markdown around the table still renders');
  assert.equal(html.split('<pre>').length, 2, 'exactly one monospace table block');
});

test('a lone separator-looking line stays prose instead of half a table', () => {
  assert.equal(markdownToHtml('not a table\n|---|'), 'not a table\n|---|');
});

test('markdownTablePreBlock finds a table anywhere and renders it as aligned monospace (#26)', () => {
  const input = [
    'leading prose',
    '| col1 | col2 |',
    '|------|------|',
    '| a    | b    |',
    '| long | text |',
    'trailing prose',
  ].join('\n');
  const html = markdownTablePreBlock(input);
  assert.ok(html, 'a table block was detected');
  assert.match(html, /^<pre><code>/);
  assert.match(html, /\| col1\s+\| col2\s+\|/);
  assert.match(html, /\| a\s+\| b\s+\|/);
  assert.match(html, /\| long \| text \|/);
  assert.match(html, /<\/code><\/pre>$/);
  assert.equal(html.includes('------'), false, 'separator syntax is replaced by an aligned rule');
});

test('markdownTablePreBlock leaves table-less text alone', () => {
  assert.equal(markdownTablePreBlock('| not a header |\nand prose'), undefined);
});

test('unordered and ordered lists keep their structure', () => {
  const html = markdownToHtml('- one\n- two\n\n1. first\n2. second');
  assert.match(html, /• one\n• two/);
  assert.match(html, /1\. first\n2\. second/);
});

test('unsafe link targets are left as literal text', () => {
  assert.equal(markdownToHtml('[bad](javascript:alert(1))'), '[bad](javascript:alert(1))');
});

function assertBalanced(part) {
  const stack = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?(\/?)>/g;
  for (const match of part.matchAll(tag)) {
    const name = match[2].toLowerCase();
    if (match[3] === '/') continue;
    if (match[1] === '/') {
      assert.equal(stack.at(-1), name, `stray closer </${name}> in ${JSON.stringify(part)}`);
      stack.pop();
    } else {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `unclosed tags <${stack.join('>, <')}> in ${JSON.stringify(part)}`);
}

test('long normalized replies split into balanced Telegram HTML chunks', () => {
  const markdown = `**${'x'.repeat(5000)}** and *${'y'.repeat(5000)}*`;
  const parts = splitText(markdownToHtml(markdown), 4096);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 4096);
    assertBalanced(part);
  }
});

test('deeply nested inline markup degrades instead of overflowing the stack', () => {
  const depth = 80;
  const nested = `${'**'.repeat(depth)}deep${'**'.repeat(depth)}`;
  const html = markdownToHtml(nested);
  assert.ok(html.includes('deep'), 'deep content survives as escaped text once the depth guard trips');
  assert.doesNotThrow(() => markdownToHtml(`${'['.repeat(500)}deep`));
});

// ---- issue #31: CJK-aware display width for table columns ----

/** Rendered column widths of a markdown table: split each row line back into
 * cells (stripping only the single ` | ` delimiter spaces, so alignment
 * padding survives) and measure with the same display-width rule the
 * renderer used. */
function renderedColumnWidths(markdown) {
  const html = markdownToHtml(markdown);
  const block = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] ?? '';
  const rows = block.split('\n').map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.replace(/^ /, '').replace(/ $/, '')));
  return rows.map((row) => row.map((cell) => cellDisplayWidth(cell)));
}
test('cellDisplayWidth measures CJK as two columns and Latin as one (#31)', () => {
  assert.equal(cellDisplayWidth('文件'), 4);
  assert.equal(cellDisplayWidth('20,064 B'), 8);
  assert.equal(cellDisplayWidth('主交付物'), 8);
  assert.equal(cellDisplayWidth('📌'), 2);
  assert.equal(cellDisplayWidth('e\u0301'), 1, 'combining mark adds no width');
  assert.equal(cellDisplayWidth('a&b'), 3, 'raw width: entities render one glyph');
  assert.equal(cellDisplayWidth(''), 0);
});

test('CJK and Latin cells in one column align by display width (#31)', () => {
  const markdown = [
    '| 文件 | 大小 | 说明 |',
    '|---|---|---|',
    '| result.xlsx | 20,064 B | 主交付物 |',
    '| data.csv | 5,039 B | CSV 备份 |',
  ].join('\n');
  const widths = renderedColumnWidths(markdown);
  assert.equal(widths.length, 4);
  for (const row of widths) {
    assert.deepEqual(row, widths[0], 'every row renders identical column widths');
  }
  assert.deepEqual(widths[0], [11, 8, 8], `columns sized to the widest cell, got ${JSON.stringify(widths[0])}`);
});

test('cells containing HTML-escapable characters still align (#31)', () => {
  const markdown = ['| a&b | x |', '|---|---|', '| abcdef | y |'].join('\n');
  const html = markdownToHtml(markdown);
  const rows = (/<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] ?? '').split('\n');
  // The escaped entity `&amp;` renders as one glyph, so the rendered widths
  // must match: `a&b` padded like a 3-wide cell next to 6-wide `abcdef`.
  assert.ok(rows[0].includes('a&amp;b   '), `header cell padded by raw width: ${JSON.stringify(rows[0])}`);
  assert.ok(rows[2].includes('abcdef'), 'body cell unpadded');
  assert.equal((rows[0].match(/ /g) ?? []).length >= 3, true);
});

test('narrow columns keep a minimum width of three (#31)', () => {
  const html = markdownToHtml(['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n'));
  assert.match(html, /\| --- \| --- \|/, 'separator is at least three dashes');
});

test('emoji cells measure two columns wide (#31)', () => {
  const markdown = ['| 📌① | n |', '|---|---|', '| ab | y |'].join('\n');
  const widths = renderedColumnWidths(markdown);
  for (const row of widths) assert.equal(row[0], 3, `emoji column aligned at 3, got ${JSON.stringify(row)}`);
});

test('a long model-styled separator does not inflate column width (#31)', () => {
  const html = markdownToHtml(['| a | b |', '|-----------|-----------|', '| 1 | 2 |'].join('\n'));
  assert.match(html, /\| --- \| --- \|/, 'separator reflects data width, not its own dashes');
});

test('ragged body rows fold overflow cells into the last column (RE-11)', () => {
  const html = markdownToHtml(['| a | b |', '|---|---|', '| 1 | 2 | extra | cells |'].join('\n'));
  assert.match(html, /<pre><code>\| a   \| b                 \|/);
  assert.match(html, /\| 1   \| 2 \| extra \| cells \|/, 'overflow cells are kept, merged into the last column');
  assert.equal(html.includes('undefined'), false);
  assert.equal(html.includes('NaN'), false);
});

test('a GFM escaped pipe (\\|) stays inside its cell instead of splitting the row (RE-11)', () => {
  const html = markdownToHtml(['| name | value |', '|---|---|', '| a \\| b | c |'].join('\n'));
  const block = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] ?? '';
  const lines = block.split('\n');
  // Two columns only: the escaped pipe renders as a literal pipe inside
  // cell one instead of creating a phantom third column.
  assert.equal((lines[0].match(/\|/g) ?? []).length, 3, 'header still has exactly two columns');
  assert.match(lines[2], /^\| a \| b\s+\| c\s+\|$/, `body row: ${JSON.stringify(lines[2])}`);
});

test('nested link labels hit the recursion guard instead of overflowing the stack (RE-5)', () => {
  // Links and emphasis alternate so every wrap level genuinely nests inside
  // the previous label/content. Before RE-5 the link hop reset the effective
  // depth to its paren-counter (~1-2), so MAX_INLINE_DEPTH never tripped and
  // 50k wraps blew the stack with an uncaught RangeError.
  let nested = 'core';
  for (let i = 0; i < 50_000; i += 1) nested = `[**${nested}**](https://e.test/)`;
  let html;
  assert.doesNotThrow(() => {
    html = markdownToHtml(nested);
  }, 'deep mixed nesting must degrade, not RangeError');
  assert.ok(html.includes('core'), 'innermost content survives as text');
  // Normal (shallow) link rendering is unchanged.
  assert.equal(markdownToHtml('[label](https://e.test/x)'), '<a href="https://e.test/x">label</a>');
});

// ---- MD-1: Telegram-legal entity nesting ----

test('MD-1: link labels flatten code and formatting to plain text inside <a>', () => {
  // Telegram rejects <a> whose content is anything but plain text with HTTP
  // 400 "can't parse entities", so the rendered label is flattened; the
  // escaped text itself must survive verbatim (exactly-once escaping).
  assert.equal(markdownToHtml('[a `b` c](https://e.test/x)'), '<a href="https://e.test/x">a b c</a>');
  assert.equal(markdownToHtml('[**bold** label](https://e.test/x)'), '<a href="https://e.test/x">bold label</a>');
  assert.equal(markdownToHtml('[*i* ~~s~~ _u_](https://e.test/x)'), '<a href="https://e.test/x">i s u</a>');
});

test('MD-1: flattening never decodes entities, so HTML chars stay escaped once', () => {
  assert.equal(
    markdownToHtml('[`<b>` & friends](https://e.test/)'),
    '<a href="https://e.test/">&lt;b&gt; &amp; friends</a>',
  );
  assert.equal(markdownToHtml('**<x> & y**'), '<b>&lt;x&gt; &amp; y</b>');
});

test('MD-1: styled runs flatten inner code spans instead of nesting them', () => {
  // Telegram rejects `code` inside b/i/s with HTTP 400 "can't parse entities"
  // (MD-1), which drops the whole message — so the code span degrades to its
  // plain text and only the legal surrounding styling survives.
  assert.equal(markdownToHtml('**x `y` z**'), '<b>x y z</b>');
  assert.equal(markdownToHtml('*i `c` i*'), '<i>i c i</i>');
  assert.equal(markdownToHtml('~~s `c` s~~'), '<s>s c s</s>');
  assert.equal(markdownToHtml('# run `npm test`'), '<b>run npm test</b>');
  // Legal styling-in-styling is untouched.
  assert.equal(markdownToHtml('***bi***'), '<b><i>bi</i></b>');
});

test('MD-1: a single-dash GFM separator renders a table (#19)', () => {
  const html = markdownToHtml(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'));
  assert.equal(html, '<pre><code>| a   | b   |\n| --- | --- |\n| 1   | 2   |</code></pre>');
});

test('MD-1: single-dash separators with alignment colons are accepted (#19)', () => {
  const html = markdownToHtml(['| a | b |', '| :- | -: |', '| 1 | 2 |'].join('\n'));
  assert.equal(html, '<pre><code>| a   | b   |\n| --- | --- |\n| 1   | 2   |</code></pre>');
});

test('MD-1: streaming table detector accepts single-dash separators (#26)', () => {
  const html = markdownTablePreBlock(['| h1 | h2 |', '| - | - |', '| a | b |'].join('\n'));
  assert.equal(html, '<pre><code>| h1  | h2  |\n| --- | --- |\n| a   | b   |</code></pre>');
});

test('MD-1: bare hr rules are still not tables after relaxing the separator (#19)', () => {
  assert.equal(markdownToHtml('---'), '────────');
  assert.equal(markdownToHtml('-\n--\n---'), '-\n--\n────────');
  assert.equal(markdownToHtml('prose\n\n---\n\nmore'), 'prose\n\n────────\n\nmore');
});

test('MD-1: flattening composes with the depth guard instead of overflowing (RE-5)', () => {
  let nested = '`core`';
  for (let i = 0; i < 40_000; i += 1) nested = `[${nested}](https://e.test/)`;
  let html;
  assert.doesNotThrow(() => {
    html = markdownToHtml(nested);
  }, 'deep link/code nesting must degrade via MAX_INLINE_DEPTH, not RangeError');
  assert.ok(html.includes('core'), 'innermost content survives as text');
});

// ---- audit MD-1 (defect coverage): anchor sweep + full GFM divider grammar ----

test('no rendered anchor nests formatting entities inside <a>...</a> (MD-1)', () => {
  // Structural sweep over a whole chat message: whatever the label markup,
  // every emitted <a> must contain plain text only — Telegram rejects the
  // entire message otherwise.
  const html = markdownToHtml([
    'See [**bold**, `code`, and *italic*](https://e.test/doc) plus',
    'a [nested [inner](https://e.test/a)](https://e.test/b) link.',
    '**regular bold** keeps legal nesting: **`code` in bold**.',
  ].join('\n'));
  const anchors = html.match(/<a [^>]*>[\s\S]*?<\/a>/g) ?? [];
  assert.ok(anchors.length >= 2, 'both links rendered');
  for (const anchor of anchors) {
    const inner = anchor.slice(anchor.indexOf('>') + 1, anchor.length - 4);
    assert.equal(/<(b|i|s|u|code|pre|a)[\s>]/.test(inner), false, `anchor nests an entity: ${anchor}`);
    assert.ok(inner.length > 0, 'label text survives flattening');
  }
});

test('legal entity nesting is preserved byte-for-byte (MD-1 audit lock)', () => {
  // Bold wrapping code is flattened (MD-1); bold wrapping italic stays legal.
  assert.equal(markdownToHtml('**`c`**'), '<b>c</b>', 'code inside bold is flattened, not nested');
  assert.equal(markdownToHtml('**_c_**'), '<b><i>c</i></b>', 'b>i is a legal Telegram nesting');
  assert.equal(markdownToHtml('[**styled link text**](https://e.test/x)'), '<a href="https://e.test/x">styled link text</a>');
});

test('GFM dividers with alignment colons and compact dashes match the spaced variant (MD-1)', () => {
  const header = '| Left | Right |';
  const body = ['| a | b |', '| cc | dd |'];
  const spaced = markdownToHtml([header, '| --- | --- |', ...body].join('\n'));
  assert.match(spaced, /^<pre><code>/);
  for (const divider of ['| :--- | ---: |', '|:-|-:|', '|--|--|', '|-|-|']) {
    assert.equal(markdownToHtml([header, divider, ...body].join('\n')), spaced, `divider ${divider}`);
  }
});

test('GFM dividers without outer pipes are recognized (MD-1)', () => {
  const header = '| Left | Right |';
  const body = '| a | b |';
  const expected = markdownToHtml([header, '| --- | --- |', body].join('\n'));
  for (const divider of ['--- | ---', '| --- | ---', '--- | --- |']) {
    assert.equal(markdownToHtml([header, divider, body].join('\n')), expected, `divider ${divider}`);
  }
  // The streaming snapshot path (#26) sees the same pipe-less divider.
  assert.equal(markdownTablePreBlock([header, ':--- | ---:', body].join('\n')), expected);
});

test('prose with dashes and pipes is never mistaken for a table (MD-1)', () => {
  assert.equal(markdownToHtml('a | b -- c'), 'a | b -- c');
  assert.equal(markdownTablePreBlock('a | b -- c'), undefined);
  // Dash-only thematic breaks under prose stay horizontal rules.
  assert.equal(markdownToHtml('todo | done\n---'), 'todo | done\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  assert.equal(markdownToHtml('x | y\n***'), 'x | y\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  // Strict outer-pipe row shapes still gate detection: quotes and bullets
  // followed by divider-looking lines stay non-tables.
  assert.equal(markdownToHtml('> quoted | pipes\n--- | ---'), '<blockquote>quoted | pipes</blockquote>\n--- | ---');
  assert.equal(markdownToHtml('- bullet | pipes\n--- | ---'), '\u2022 bullet | pipes\n--- | ---');
});
