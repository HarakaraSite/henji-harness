import { assert, assertEquals } from './test_helpers.ts';
import {
  INPUT_ESC_TIMEOUT_MS,
  InputDecodeError,
  InputDecoder,
  TuiEditor,
} from '../../v0/tui/input.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

Deno.test('input decoder accepts UTF-8 split at every byte boundary', () => {
  const source = bytes('A😀é中Z');
  for (let split = 0; split <= source.length; split += 1) {
    const decoder = new InputDecoder();
    const events = [
      ...decoder.feed(source.slice(0, split)),
      ...decoder.feed(source.slice(split)),
    ];
    assertEquals(events.filter((event) => event.kind === 'printable').map((event) => event.text), [
      'A',
      '😀',
      'é',
      '中',
      'Z',
    ]);
    decoder.end();
  }
});

Deno.test('malformed UTF-8 is rejected without a replacement character', () => {
  const decoder = new InputDecoder();
  const events = decoder.feed(new Uint8Array([0xc3, 0x28]));
  assertEquals(events.map((event) => event.kind), ['invalid_utf8', 'printable']);
  assertEquals(events[1].kind === 'printable' ? events[1].text : '', '(');
  assert(!events.some((event) => event.kind === 'printable' && event.text === '�'));
});

Deno.test('overlong UTF-8 encodings are rejected without replacement characters', () => {
  const decoder = new InputDecoder();
  const events = decoder.feed(
    new Uint8Array([
      0xc0,
      0xaf, // overlong U+002F
      0xe0,
      0x80,
      0x80, // overlong three-byte encoding
    ]),
  );
  assertEquals(events.map((event) => event.kind), [
    'invalid_utf8',
    'invalid_utf8',
    'invalid_utf8',
    'invalid_utf8',
    'invalid_utf8',
  ]);
  assert(!events.some((event) => event.kind === 'printable' && event.text === '�'));
  decoder.end();
});

Deno.test('CR, LF, and CRLF each have exact enter semantics', () => {
  for (
    const input of [
      new Uint8Array([0x0d]),
      new Uint8Array([0x0a]),
      new Uint8Array([0x0d, 0x0a]),
    ]
  ) {
    const decoder = new InputDecoder();
    assertEquals(decoder.feed(input), [{ kind: 'enter' }]);
    decoder.end();
  }
  const split = new InputDecoder();
  assertEquals(split.feed(new Uint8Array([0x0d])), [{ kind: 'enter' }]);
  assertEquals(split.feed(new Uint8Array([0x0a])), []);
  split.end();
});

Deno.test('CRLF is one enter and backspace removes one Unicode code point', () => {
  const decoder = new InputDecoder();
  const events = decoder.feed(new Uint8Array([0x0d, 0x0a, 0x08, 0x7f, 0x04, 0x03]));
  assertEquals(events.map((event) => event.kind), [
    'enter',
    'backspace',
    'backspace',
    'ctrl_d',
    'ctrl_c',
  ]);
  const editor = new TuiEditor();
  assert(editor.append('😀é'));
  assert(editor.backspace());
  assertEquals(editor.text, '😀');
  assert(editor.backspace());
  assertEquals(editor.text, '');
});

Deno.test('bracketed paste is atomic and split framing is accepted', () => {
  const sequence = bytes('\x1b[200~line1\nline2\t\x1b[201~');
  const decoder = new InputDecoder();
  const events = [];
  for (const byte of sequence) events.push(...decoder.feed(new Uint8Array([byte])));
  assertEquals(events, [{ kind: 'paste', text: 'line1\nline2\t' }]);
  decoder.end();
  const editor = new TuiEditor();
  assert(editor.append(events[0].kind === 'paste' ? events[0].text : ''));
  assertEquals(editor.text, 'line1\nline2\t');
});

Deno.test('oversized paste is rejected as a whole', () => {
  const decoder = new InputDecoder();
  const events = decoder.feed(bytes(`\x1b[200~${'x'.repeat(65_537)}\x1b[201~`));
  assertEquals(events, [{ kind: 'paste_rejected' }]);
  decoder.end();
});

Deno.test('bare escape uses the fixed timeout and unknown CSI does not mutate input', () => {
  const decoder = new InputDecoder();
  const start = 10_000;
  assertEquals(decoder.feed(new Uint8Array([0x1b]), start), []);
  assertEquals(decoder.poll(start + INPUT_ESC_TIMEOUT_MS - 1), []);
  assertEquals(decoder.poll(start + INPUT_ESC_TIMEOUT_MS), [{ kind: 'escape' }]);
  assertEquals(decoder.feed(new Uint8Array([0x1b, 0x5b, 0x41])), [{ kind: 'unknown' }]);
});

Deno.test('incomplete escape or paste at EOF is an input failure', () => {
  for (const input of [new Uint8Array([0x1b]), bytes('\x1b[200~partial')]) {
    const decoder = new InputDecoder();
    decoder.feed(input);
    let threw = false;
    try {
      decoder.end();
    } catch (error) {
      threw = error instanceof InputDecodeError;
    }
    assert(threw);
  }
});

Deno.test('editor enforces exact 65,536-byte boundary and atomic overflow', () => {
  const editor = new TuiEditor();
  assert(editor.append('x'.repeat(65_536)));
  assertEquals(editor.byteLength, 65_536);
  assert(!editor.append('y'));
  assertEquals(editor.text.at(-1), 'x');
  const paste = new TuiEditor();
  assert(!paste.append('😀'.repeat(16_384) + 'x'));
  assertEquals(paste.text, '');
  assertEquals(paste.submit(), null);
});

Deno.test('Alt+Enter accepts the exact legacy forms and suppresses CRLF', () => {
  const start = 20_000;
  for (const suffix of [new Uint8Array([0x0d]), new Uint8Array([0x0a])]) {
    const decoder = new InputDecoder();
    assertEquals(decoder.feed(new Uint8Array([0x1b]), start), []);
    assertEquals(decoder.feed(suffix, start + INPUT_ESC_TIMEOUT_MS - 1), [{ kind: 'alt_enter' }]);
    if (suffix[0] === 0x0d) {
      assertEquals(decoder.feed(new Uint8Array([0x0a]), start + 1), []);
    }
    decoder.end();
  }
  const splitCrLf = new InputDecoder();
  assertEquals(splitCrLf.feed(new Uint8Array([0x1b, 0x0d]), start), [{ kind: 'alt_enter' }]);
  assertEquals(splitCrLf.feed(new Uint8Array([0x0a]), start + 1), []);
  splitCrLf.end();
});

Deno.test('legacy Alt+Enter crossing the 50 ms deadline remains Escape plus Enter', () => {
  for (const suffix of [0x0d, 0x0a]) {
    const decoder = new InputDecoder();
    const start = 30_000;
    assertEquals(decoder.feed(new Uint8Array([0x1b]), start), []);
    assertEquals(
      decoder.feed(new Uint8Array([suffix]), start + INPUT_ESC_TIMEOUT_MS),
      [{ kind: 'escape' }, { kind: 'enter' }],
    );
    decoder.end();
  }
});

Deno.test('xterm Alt+Enter is atomic at every split before the deadline', () => {
  const sequence = new Uint8Array([
    0x1b,
    0x5b,
    0x32,
    0x37,
    0x3b,
    0x33,
    0x3b,
    0x31,
    0x33,
    0x7e,
  ]);
  const start = 40_000;
  for (let split = 0; split <= sequence.length; split += 1) {
    const decoder = new InputDecoder();
    const events = [
      ...decoder.feed(sequence.slice(0, split), start),
      ...decoder.feed(sequence.slice(split), start + INPUT_ESC_TIMEOUT_MS - 1),
    ];
    assertEquals(events, [{ kind: 'alt_enter' }], `split ${split}`);
    decoder.end();
  }
});

Deno.test('xterm Alt+Enter at or after the deadline becomes Escape plus printable remainder', () => {
  const sequence = new Uint8Array([
    0x1b,
    0x5b,
    0x32,
    0x37,
    0x3b,
    0x33,
    0x3b,
    0x31,
    0x33,
    0x7e,
  ]);
  const expected = '[27;3;13~';
  for (const split of Array.from({ length: sequence.length - 1 }, (_, index) => index + 1)) {
    for (const elapsed of [INPUT_ESC_TIMEOUT_MS, INPUT_ESC_TIMEOUT_MS + 1]) {
      const decoder = new InputDecoder();
      const start = 50_000;
      const events = [
        ...decoder.feed(sequence.slice(0, split), start),
        ...decoder.feed(sequence.slice(split), start + elapsed),
      ];
      assertEquals(events.map((event) => event.kind), [
        'escape',
        ...[...expected].map(() => 'printable' as const),
      ], `split ${split} elapsed ${elapsed}`);
      assertEquals(
        events.slice(1).map((event) => event.kind === 'printable' ? event.text : ''),
        [...expected],
      );
      decoder.end();
    }
  }
});

Deno.test('timed-out unknown and divergent CSI discard buffered payload like the baseline decoder', () => {
  const start = 60_000;
  const unknown = new InputDecoder();
  assertEquals(unknown.feed(new Uint8Array([0x1b, 0x5b]), start), []);
  assertEquals(unknown.feed(new Uint8Array([0x41]), start + INPUT_ESC_TIMEOUT_MS), [
    { kind: 'escape' },
    { kind: 'printable', text: 'A', codePoint: 0x41 },
  ]);
  unknown.end();

  const divergent = new InputDecoder();
  assertEquals(divergent.feed(new Uint8Array([0x1b, 0x5b, 0x32, 0x37, 0x3b]), start), []);
  assertEquals(divergent.feed(new Uint8Array([0x34]), start + INPUT_ESC_TIMEOUT_MS), [
    { kind: 'escape' },
    { kind: 'printable', text: '4', codePoint: 0x34 },
  ]);
  divergent.end();
});

Deno.test('expired xterm candidate is retained through poll, exact completion replays once, and EOF is clean', () => {
  const start = 70_000;
  const expected = '[27;3;13~';
  const decoder = new InputDecoder();
  assertEquals(decoder.feed(new Uint8Array([0x1b, 0x5b, 0x32, 0x37]), start), []);
  assertEquals(decoder.poll(start + INPUT_ESC_TIMEOUT_MS), [{ kind: 'escape' }]);
  assertEquals(decoder.feed(new Uint8Array([0x3b, 0x33, 0x3b, 0x31, 0x33, 0x7e]), start + 1), [
    ...[...expected].map((text) => ({
      kind: 'printable' as const,
      text,
      codePoint: text.codePointAt(0)!,
    })),
  ]);
  decoder.end();

  const incomplete = new InputDecoder();
  incomplete.feed(new Uint8Array([0x1b, 0x5b, 0x32, 0x37]), start);
  assertEquals(incomplete.poll(start + INPUT_ESC_TIMEOUT_MS), [{ kind: 'escape' }]);
  incomplete.end();
});

Deno.test('Kitty CSI-u and unknown CSI remain unsupported', () => {
  const decoder = new InputDecoder();
  assertEquals(decoder.feed(new Uint8Array([0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75])), [
    { kind: 'unknown' },
  ]);
  decoder.end();
});
