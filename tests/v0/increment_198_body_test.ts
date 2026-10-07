import { createUiState, reduceUiEvent } from '../../v0/tui/state.ts';
import { strictEqual } from 'node:assert';
import { type BodyCursor, BodyDocument, type BodyRow } from '../../v0/tui/body_document.ts';
import { cellWidth } from '../../v0/tui/terminal_text.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const collect = (document: BodyDocument, width: number): BodyRow[] => {
  const rows: BodyRow[] = [];
  let cursor: BodyCursor | undefined = document.first(width);
  while (cursor !== undefined) {
    rows.push(document.render(cursor, width));
    cursor = document.next(cursor, width);
  }
  return rows;
};

Deno.test('Increment 198 plain body wraps only at measured grapheme boundaries', () => {
  const family = '👨‍👩‍👧‍👦';
  const document = new BodyDocument(`${family}abあ`, 'plain');
  const rows = collect(document, 2);
  assert(rows.length === 3);
  assert(rows[0].text === family, 'emoji family was split');
  assert(rows[1].text === 'ab');
  assert(rows[2].text === 'あ');
  assert(rows.every((row) => cellWidth(row.text) <= 2));
  assert(document.seek(family.length, 2).row === 1);
});

Deno.test('Increment 198 identifies document boundaries without stepping past them', () => {
  const document = new BodyDocument('abcd\nxy', 'plain');
  const first = document.first(2);
  const last = document.last(2);
  assert(document.isFirst(first));
  assert(!document.isLast(first, 2));
  assert(document.isLast(last, 2));
  assert(!document.isFirst(last));
});

Deno.test('Increment 198 preserves Markdown body text when a list prefix is too wide', () => {
  const list = new BodyDocument('- あいうえお', 'markdown');
  const rows = collect(list, 3);
  assert(rows.length === 5);
  assert(rows[0].text === '-あ');
  assert(rows.every((row) => cellWidth(row.text) <= 3));

  const escaped = new BodyDocument('- \u0001abcdef', 'markdown');
  const escapedRows = collect(escaped, 8);
  assert(escapedRows[0].text === '\\u{0001}');
  assert(escapedRows.every((row) => cellWidth(row.text) <= 8));
  assert(escapedRows.map((row) => row.text).join('').includes('abcdef'));
});

Deno.test('Increment 198 long plain rows expose only the requested source slice', () => {
  const body = 'x'.repeat(2_000_000);
  const document = new BodyDocument(body, 'plain');
  const cursor = document.last(80);
  const row = document.render(cursor, 80);
  assert(cursor.row === 24_999);
  assert(row.text === 'x'.repeat(80));
  assert(row.sourceUtf16Offset === body.length - 80);
  assert(document.previous(cursor, 80)?.row === cursor.row - 1);
});

Deno.test('Increment 198 append preserves prior plain rows and extends the last boundary', () => {
  const original = `${'p'.repeat(64)}\n${'x'.repeat(512)}`;
  const document = new BodyDocument(original, 'plain');
  const before = collect(document, 8);
  document.update(`${original}tail`);
  const after = collect(document, 8);
  assert(after.length === before.length + 1);
  assert(
    after.slice(0, before.length).every((row, index) => row.text === before[index].text),
  );
  assert(after.at(-1)?.text === 'tail');
});

Deno.test('Increment 198 row keys retain unchanged plain rows across tail append', () => {
  const original = `${'p'.repeat(64)}\n${'x'.repeat(512)}`;
  const document = new BodyDocument(original, 'plain');
  const stableKey = document.rowKey({ block: 0, row: 3 }, 8);
  const tailKey = document.rowKey({ block: 1, row: 63 }, 8);

  document.update(`${original}tail`);

  assert(document.rowKey({ block: 0, row: 3 }, 8) === stableKey);
  assert(document.rowKey({ block: 1, row: 63 }, 8) === tailKey);
  assert(document.rowKey({ block: 1, row: 64 }, 8) !== tailKey);
});

Deno.test('Increment 198 table row source anchors survive Page and width changes', () => {
  const source = [
    '| Tool | Speed | Notes |',
    '| --- | --- | --- |',
    '| bash | fast | one two three four five six seven eight nine ten |',
  ].join('\n');
  const document = new BodyDocument(source, 'markdown');
  const narrowRows = collect(document, 28);
  const tableRows = narrowRows.filter((row) => row.text.startsWith('|'));
  assert(tableRows.length > 4, 'table cells did not wrap into visible rows');
  for (const row of tableRows.slice(2)) {
    const cursor = document.seek(row.sourceUtf16Offset, 28);
    assert(document.sourceOffset(cursor, 28) === row.sourceUtf16Offset);
    assert(document.render(cursor, 28).text === row.text);
  }
  const anchor = tableRows.at(-1)!.sourceUtf16Offset;
  const resized = document.seek(anchor, 42);
  const resizedRow = document.render(resized, 42);
  const anchoredText = source.slice(anchor, anchor + 3).trim();
  assert(anchoredText.length > 0 && resizedRow.text.includes(anchoredText));
});

Deno.test('Increment 198 Markdown append preserves open fence context and table delimiter', () => {
  const code = ['```ts', 'const before = true;'].join('\n');
  const fenced = new BodyDocument(code, 'markdown');
  const priorKey = fenced.rowKey({ block: 1, row: 0 }, 40);
  fenced.update(`${code}\n- **still code**`);
  const fenceRows = collect(fenced, 40);
  assert(fenceRows.at(-1)?.text === '- **still code**');
  assert(fenceRows.at(-1)?.spans.length === 0);
  assert(fenced.rowKey({ block: 1, row: 0 }, 40) === priorKey);

  const longCodeText = `\`\`\`ts\n${'x'.repeat(512)}`;
  const longCode = new BodyDocument(longCodeText, 'markdown');
  const stableCodeKey = longCode.rowKey({ block: 1, row: 3 }, 8);
  longCode.update(`${longCodeText}tail`);
  assert(longCode.rowKey({ block: 1, row: 3 }, 8) === stableCodeKey);

  const table = new BodyDocument('| H | V |\n| --- | --- |\n| a | b |', 'markdown');
  table.update('| H | V |\n| --- | --- |\n| a | b |\n| c | d |');
  const tableRows = collect(table, 40).filter((row) => row.text.startsWith('|'));
  assert(tableRows.length === 4);
  assert(tableRows.at(-1)?.text.includes('c'));
});

Deno.test('Increment 198 table records keep long labels and body rows within width', () => {
  const header = 'あ'.repeat(12);
  const source = [
    `| ${header} | Speed | Notes |`,
    '| --- | --- | --- |',
    '| \u0001abcdef | fast | one two three four five six |',
  ].join('\n');
  const document = new BodyDocument(source, 'markdown');
  const rows = collect(document, 15);
  const visibleRows = rows.filter((row) => row.text.length > 0);
  assert(visibleRows.length > 3);
  assert(visibleRows.every((row) => cellWidth(row.text) <= 15));
  assert(visibleRows.some((row) => row.text.includes('abc')));
  assert(visibleRows.some((row) => row.text.includes('def')));
  const headerStart = source.indexOf(header);
  const headerRows = visibleRows.filter((row) =>
    row.sourceUtf16Offset >= headerStart &&
    row.sourceUtf16Offset < headerStart + header.length
  );
  assert(headerRows.length === header.length);
  assert(
    headerRows.every((row, index) => row.sourceUtf16Offset === headerStart + index),
    'the complete header body was not rendered in source order',
  );
  for (const row of visibleRows) {
    const cursor = document.seek(row.sourceUtf16Offset, 15);
    assert(
      document.render(cursor, 15).text === row.text,
      `table record anchor did not resolve to its row: ${row.text}`,
    );
  }
});

Deno.test('Increment 198 code resize resolves source anchors without materializing other rows', () => {
  const code = `0123456789あいうえおかきくけこ${'z'.repeat(60)}`;
  const source = `\`\`\`ts\n${code}\n\`\`\``;
  const document = new BodyDocument(source, 'markdown');
  const narrow = { block: 1, row: 3 };
  const anchor = document.sourceOffset(narrow, 8);
  const resized = document.seek(anchor, 15);
  const row = document.render(resized, 15);
  assert(anchor > source.indexOf(code));
  assert(row.sourceUtf16Offset <= anchor);
  assert(row.text.includes(source[anchor]));
  assert(row.spans.length === 0);
});

Deno.test('Increment 198 inline style ranges follow escaped terminal text', () => {
  const document = new BodyDocument('a *b\u0001c*', 'markdown');
  const row = document.render(document.first(30), 30);
  const emphasis = row.spans.find((span) => span.tone === 'emphasis');
  assert(emphasis !== undefined);
  const selected = [...row.text].slice(
    emphasis.start,
    emphasis.start + emphasis.length,
  ).join('');
  strictEqual(selected, '*b\\u{0001}c*');
});

Deno.test('Increment 198 body replacement refreshes UTF-8 size while settlement retains it', () => {
  let state = reduceUiEvent(createUiState(), { kind: 'assistant_progress', turn: 1, text: 'a' });
  const text = '漢字🌸';
  state = reduceUiEvent(state, { kind: 'assistant_progress', turn: 1, text });
  strictEqual(state.log.entries[0].textByteLength, new TextEncoder().encode(text).byteLength);
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text } },
  });
  strictEqual(state.log.entries[0].text, text);
  strictEqual(state.log.entries[0].textByteLength, new TextEncoder().encode(text).byteLength);
});
