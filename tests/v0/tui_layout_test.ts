import { assert, assertEquals } from './test_helpers.ts';
import { createUiState, reduceUiAction, reduceUiEvent } from '../../v0/tui/state.ts';
import { layoutUi, MAX_FRAME_BYTES } from '../../v0/tui/layout.ts';

Deno.test('layout always exposes log, bounded input, and one footer row at 80x24', () => {
  let state = createUiState();
  state = reduceUiAction(state, {
    kind: 'editor',
    snapshot: { text: '', cursorScalar: 0, byteLength: 0 },
  });
  state = reduceUiEvent(state, {
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'hello' } },
  });
  const layout = layoutUi(state, 80, 24);
  assertEquals(layout.columns, 80);
  assertEquals(layout.rows, 24);
  assertEquals(layout.footer.kind, 'footer');
  assertEquals(layout.input.length, 1);
  assert(layout.log.length >= 3);
  assert(layout.sourceBytes < 256 * 1024);
});

Deno.test('multiline input grows only within its bound and narrow terminals degrade deterministically', () => {
  const state = reduceUiAction(createUiState(), {
    kind: 'editor',
    snapshot: {
      text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine',
      cursorScalar: 9,
      byteLength: 42,
    },
  });
  const normal = layoutUi(state, 80, 24);
  const narrow = layoutUi(state, 12, 4);
  assert(normal.input.length <= 8);
  assert(narrow.degraded);
  assertEquals(narrow.footer.kind, 'footer');
  assertEquals(narrow.input.length, 1);
  assert(
    new TextEncoder().encode(narrow.log.map((row) => row.text).join('\n')).byteLength <=
      MAX_FRAME_BYTES,
  );
});
