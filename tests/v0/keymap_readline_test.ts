import { InputDecoder, TuiEditor } from '../../v0/tui/input.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const feedOne = (decoder: InputDecoder, bytes: readonly number[]): string => {
  const events = decoder.feed(new Uint8Array(bytes));
  assertEquals(events.length, 1);
  return (events[0] as { kind: string }).kind;
};

Deno.test('Keymap decodes readline control bytes', () => {
  const decoder = new InputDecoder();
  assertEquals(feedOne(decoder, [0x01]), 'ctrl_a');
  assertEquals(feedOne(decoder, [0x02]), 'ctrl_b');
  assertEquals(feedOne(decoder, [0x05]), 'ctrl_e');
  assertEquals(feedOne(decoder, [0x06]), 'ctrl_f');
  assertEquals(feedOne(decoder, [0x15]), 'ctrl_u');
  assertEquals(feedOne(decoder, [0x0b]), 'ctrl_k');
});

Deno.test('Keymap decodes alt word keys without leaking text', () => {
  const decoder = new InputDecoder();
  assertEquals(feedOne(decoder, [0x1b, 0x62]), 'alt_b');
  assertEquals(feedOne(decoder, [0x1b, 0x66]), 'alt_f');
  assertEquals(feedOne(decoder, [0x1b, 0x64]), 'alt_d');
});

Deno.test('Keymap decodes modified Return keys as newline', () => {
  const decoder = new InputDecoder();
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75]), 'newline');
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x33, 0x75]), 'newline');
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x35, 0x75]), 'newline');
  assertEquals(feedOne(decoder, [0x1b, 0x0d]), 'alt_enter');
});

const edit = (text: string, cursor: number): TuiEditor => {
  const editor = new TuiEditor();
  assert(editor.insert(text));
  assert(editor.setCursorScalar(cursor));
  return editor;
};

Deno.test('Keymap line and word movement', () => {
  const line = edit('ab cd', 5);
  assert(line.moveWordLeft());
  assertEquals(line.cursorScalar, 3);
  assert(line.moveWordLeft());
  assertEquals(line.cursorScalar, 0);
  assert(line.moveWordRight());
  assertEquals(line.cursorScalar, 2);
  assert(line.moveWordRight());
  assertEquals(line.cursorScalar, 5);

  const moved = edit('ab cd', 3);
  assert(moved.home());
  assertEquals(moved.cursorScalar, 0);
  assert(moved.end());
  assertEquals(moved.cursorScalar, 5);
});

Deno.test('Keymap kill operations keep the remainder', () => {
  const killEnd = edit('ab cd', 2);
  assert(killEnd.deleteToLineEnd());
  assertEquals(killEnd.text, 'ab');

  const killStart = edit('ab cd', 3);
  assert(killStart.deleteToLineStart());
  assertEquals(killStart.text, 'cd');
  assertEquals(killStart.cursorScalar, 0);

  const killWord = edit('ab cd ef', 3);
  assert(killWord.deleteWordForward());
  assertEquals(killWord.text, 'ab  ef');
});
