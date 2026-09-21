import { markdownAssistantRenderer } from '../../v0/tui/assistant_layout.ts';
import { cellWidth } from '../../v0/tui/editor_render.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const widthOf = (text: string): number =>
  [...text].reduce((total, character) => total + cellWidth(character), 0);

const render = (text: string, width: number): string[] =>
  markdownAssistantRenderer.render(text, 'settled', width).map((line) => line.text);

const pipePositions = (text: string): number[] => {
  const result: number[] = [];
  [...text].forEach((character, index) => {
    if (character === '|') result.push(index);
  });
  return result;
};

Deno.test('Increment 84 wraps Latin prose at word boundaries', () => {
  const input = 'alpha bravo charlie delta echo foxtrot golf hotel india';
  const lines = render(input, 20);
  assert(lines.length > 1);
  for (const line of lines) assert(widthOf(line) <= 20);
  const words = new Set(input.split(' '));
  for (const line of lines) {
    for (const token of line.split(' ').filter((value) => value.length > 0)) {
      assert(words.has(token), `unexpected token ${token}`);
    }
  }
});

Deno.test('Increment 84 wraps CJK runs by display cells', () => {
  const input = 'あ'.repeat(45);
  const lines = render(input, 10);
  assert(lines.length >= 5);
  for (const line of lines) assert(widthOf(line) <= 10);
  assert(lines.join('') === input);
});

Deno.test('Increment 84 hangs list continuation lines under the marker', () => {
  const lines = render('- one two three four five six seven eight nine ten', 12);
  assert(lines[0].startsWith('- '));
  for (const continuation of lines.slice(1)) assert(continuation.startsWith('  '));
  for (const line of lines) assert(widthOf(line) <= 12);
});

Deno.test('Increment 84 keeps table pipe columns aligned while wrapping cells', () => {
  const markdown = [
    '| Tool | Speed | Notes |',
    '| --- | --- | --- |',
    '| bash | fast | best for shell one-liners and pipelines |',
    '| read | fast | returns a bounded line window with offset |',
  ].join('\n');
  const lines = render(markdown, 40);
  assert(lines.length > 4);
  const want = pipePositions(lines[0]);
  assert(want.length === 4);
  for (const line of lines) {
    assert(JSON.stringify(pipePositions(line)) === JSON.stringify(want), line);
    assert(widthOf(line) <= 40, line);
  }
});

Deno.test('Increment 84 falls back to records when a table cannot fit', () => {
  const markdown = [
    '| Tool | Speed | Notes |',
    '| --- | --- | --- |',
    '| bash | fast | pipelines |',
  ].join('\n');
  const lines = render(markdown, 15);
  assert(!lines.some((line) => line.includes('|')));
  assert(lines.some((line) => line.startsWith('Tool: ')));
  assert(lines.some((line) => line.startsWith('Notes: ')));
});

Deno.test('Increment 84 keeps fenced code out of table and list parsing', () => {
  const markdown = [
    '```ts',
    '| a | b |',
    '- not a list',
    '```',
  ].join('\n');
  const lines = render(markdown, 40);
  assert(lines[0].startsWith('```'));
  assert(lines.some((line) => line === '| a | b |'));
  assert(lines.some((line) => line === '- not a list'));
  assert(lines[lines.length - 1].startsWith('```'));
});

Deno.test('Increment 84 marks inline emphasis and code spans', () => {
  const [line] = markdownAssistantRenderer.render(
    'a *italic* **bold** ***triple*** `code`',
    'settled',
    60,
  );
  const chars = [...line.text];
  const textOf = (span: { readonly start: number; readonly length: number }): string =>
    chars.slice(span.start, span.start + span.length).join('');
  const code = line.spans.find((span) => span.tone === 'code');
  assert(code !== undefined && textOf(code) === 'code');
  const emphasis = line.spans
    .filter((span) => span.tone === 'emphasis')
    .map(textOf)
    .sort();
  assert(
    JSON.stringify(emphasis) === JSON.stringify(['bold', 'italic', 'triple']),
    `unexpected emphasis spans: ${JSON.stringify(emphasis)}`,
  );
});

Deno.test('Increment 84 marks heading and list markers', () => {
  const heading = markdownAssistantRenderer.render('## Title', 'settled', 40)[0];
  assert(
    heading.spans.some((span) =>
      span.tone === 'heading' && span.start === 0 && span.length === [...heading.text].length
    ),
    'heading span does not cover the whole line',
  );
  const list = markdownAssistantRenderer.render('- item', 'settled', 40)[0];
  assert(list.spans.some((span) => span.tone === 'list' && span.start === 0 && span.length === 1));
});

Deno.test('Increment 96 renders *, **, and *** emphasis green without bold', () => {
  const [line] = markdownAssistantRenderer.render('a *i* **b** ***c***', 'settled', 40);
  const chars = [...line.text];
  const emphasis = line.spans
    .filter((span) => span.tone === 'emphasis')
    .map((span) => chars.slice(span.start, span.start + span.length).join(''))
    .sort();
  assert(
    JSON.stringify(emphasis) === JSON.stringify(['b', 'c', 'i']),
    `unexpected emphasis spans: ${JSON.stringify(emphasis)}`,
  );
  assert(line.spans.every((span) => span.tone !== 'bold'), 'emphasis produced a bold span');
});

Deno.test('Increment 96 colors the whole wrapped heading line', () => {
  const lines = markdownAssistantRenderer.render(
    '## alpha bravo charlie delta echo',
    'settled',
    14,
  );
  for (const line of lines) {
    assert(
      line.spans.some((span) =>
        span.tone === 'heading' && span.start === 0 && span.length === [...line.text].length
      ),
      `heading line not fully colored: ${line.text}`,
    );
  }
});
