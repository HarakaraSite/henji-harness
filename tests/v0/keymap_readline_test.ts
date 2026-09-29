import { InputDecoder, TuiEditor, TuiEditorHistory } from '../../v0/tui/input.ts';

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

Deno.test('Keymap retains only whole-operation and masked-input control keys', () => {
  const decoder = new InputDecoder();
  assertEquals(feedOne(decoder, [0x04]), 'ctrl_d');
  assertEquals(feedOne(decoder, [0x11]), 'ctrl_q');
  assertEquals(feedOne(decoder, [0x15]), 'ctrl_u');
  for (const byte of [0x01, 0x02, 0x05, 0x06, 0x07, 0x0b, 0x0f, 0x14, 0x17]) {
    assertEquals(feedOne(decoder, [byte]), 'unknown');
  }
  assertEquals(feedOne(decoder, [0x08]), 'backspace');
  assertEquals(feedOne(decoder, [0x7f]), 'backspace');
});

Deno.test('Keymap retires alt word aliases without inserting their payload', () => {
  const decoder = new InputDecoder();
  assertEquals(feedOne(decoder, [0x1b, 0x62]), 'unknown');
  assertEquals(feedOne(decoder, [0x1b, 0x66]), 'unknown');
  assertEquals(feedOne(decoder, [0x1b, 0x64]), 'unknown');
});

Deno.test('Keymap decodes F1 through F3 from SS3 and xterm CSI sequences', () => {
  const decoder = new InputDecoder();
  assertEquals(feedOne(decoder, [0x1b, 0x4f, 0x50]), 'f1');
  assertEquals(feedOne(decoder, [0x1b, 0x4f, 0x51]), 'f2');
  assertEquals(feedOne(decoder, [0x1b, 0x4f, 0x52]), 'f3');
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x31, 0x7e]), 'f1');
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x32, 0x7e]), 'f2');
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x33, 0x7e]), 'f3');
});

Deno.test('Keymap decodes modified Return keys as newline', () => {
  const decoder = new InputDecoder();
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75]), 'newline');
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x33, 0x75]), 'newline');
  assertEquals(feedOne(decoder, [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x35, 0x75]), 'newline');
  assertEquals(feedOne(decoder, [0x1b, 0x0d]), 'alt_enter');
});

Deno.test('Keymap decodes a new arrow after a timed bare Escape', () => {
  const decoder = new InputDecoder();
  assertEquals(decoder.feed(new Uint8Array([0x1b]), 0), []);
  assertEquals(decoder.poll(80), [{ kind: 'escape' }]);
  assertEquals(decoder.feed(new Uint8Array([0x63]), 81)[0]?.kind, 'printable');
  assertEquals(decoder.feed(new Uint8Array([0x1b, 0x5b, 0x44]), 82), [{ kind: 'left' }]);
  assertEquals(decoder.feed(new Uint8Array([0x1b, 0x5b, 0x41]), 83), [{ kind: 'up' }]);
});

const edit = (text: string, cursor: number): TuiEditor => {
  const editor = new TuiEditor();
  assert(editor.insert(text));
  assert(editor.setCursorScalar(cursor));
  return editor;
};

Deno.test('Keymap line movement', () => {
  const moved = edit('ab cd', 3);
  assert(moved.home());
  assertEquals(moved.cursorScalar, 0);
  assert(moved.end());
  assertEquals(moved.cursorScalar, 5);
});

Deno.test('Input history exposes navigation state for Up/Down-edge walk', () => {
  const history = new TuiEditorHistory();
  assertEquals(history.navigating, false);
  assert(history.record('first task'));
  assert(history.record('second task'));
  const draft = { text: '', cursorScalar: 0, byteLength: 0 };
  const back = history.previous(draft);
  assert(back !== null);
  assertEquals(back.text, 'second task');
  assertEquals(history.navigating, true);
  const older = history.previous(draft);
  assertEquals(older?.text, 'first task');
  const forward = history.next();
  assertEquals(forward?.text, 'second task');
  const restored = history.next();
  assertEquals(restored?.text, '');
  assertEquals(history.navigating, false);
});
