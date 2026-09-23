import { markdownAssistantRenderer } from '../../v0/tui/assistant_layout.ts';
import { cellWidth } from '../../v0/tui/terminal_text.ts';
import type { AssistantLine, AssistantSpanTone } from '../../v0/tui/conversation_renderer.ts';

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

Deno.test('Increment 98 leaves fenced code blocks uncolored', () => {
  const markdown = [
    '```ts',
    'const x = 1;',
    '```',
  ].join('\n');
  const lines = markdownAssistantRenderer.render(markdown, 'settled', 40);
  assert(lines.length >= 3);
  assert(lines.every((line) => line.spans.length === 0), 'fenced code must not be colored');
});

Deno.test('Increment 84 marks inline emphasis and leaves code uncolored', () => {
  const [line] = markdownAssistantRenderer.render(
    'a *italic* **bold** ***triple*** `code`',
    'settled',
    60,
  );
  const chars = [...line.text];
  const textOf = (span: { readonly start: number; readonly length: number }): string =>
    chars.slice(span.start, span.start + span.length).join('');
  assert(
    line.spans.every((span) => textOf(span) !== 'code'),
    'inline code must not be colored',
  );
  const emphasis = line.spans.filter((span) => span.tone === 'emphasis').map(textOf);
  for (const expected of ['*italic*', '**bold**', '***triple***']) {
    assert(emphasis.includes(expected), `missing emphasis span ${expected}`);
  }
  assert(emphasis.length === 3, `unexpected emphasis spans: ${JSON.stringify(emphasis)}`);
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

Deno.test('Increment 96 renders * ** and *** emphasis green including markers', () => {
  const [line] = markdownAssistantRenderer.render('a *i* **b** ***c***', 'settled', 40);
  const chars = [...line.text];
  const emphasis = line.spans
    .filter((span) => span.tone === 'emphasis')
    .map((span) => chars.slice(span.start, span.start + span.length).join(''));
  for (const expected of ['*i*', '**b**', '***c***']) {
    assert(emphasis.includes(expected), `missing emphasis span ${expected}`);
  }
  assert(emphasis.length === 3, `unexpected emphasis spans: ${JSON.stringify(emphasis)}`);
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

Deno.test('Increment 96 keeps inline emphasis spans across wrapped lines', () => {
  const covered = (lines: readonly AssistantLine[], tone: AssistantSpanTone): string =>
    lines.map((line) => {
      const chars = [...line.text];
      return line.spans
        .filter((span) => span.tone === tone)
        .map((span) => chars.slice(span.start, span.start + span.length).join(''))
        .join('');
    }).join('');

  const emphasisBody = `**${'あ'.repeat(40)}**`;
  const emphasisLines = markdownAssistantRenderer.render(
    `pre ${emphasisBody} post`,
    'settled',
    16,
  );
  assert(
    emphasisLines.filter((line) => line.spans.some((span) => span.tone === 'emphasis')).length > 1,
    'emphasis did not span the wrap',
  );
  assert(
    covered(emphasisLines, 'emphasis') === emphasisBody,
    `emphasis coverage mismatch: ${covered(emphasisLines, 'emphasis')}`,
  );
});
