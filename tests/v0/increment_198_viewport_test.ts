import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { BodyDocument } from '../../v0/tui/body_document.ts';
import { KeyedConversationStore } from '../../v0/tui/keyed_conversation_store.ts';
import {
  createUiState,
  freezeUiLogEntry,
  reduceUiEvent,
  type UiLogEntry,
} from '../../v0/tui/state.ts';
import { TuiRenderer } from '../../v0/tui/tui_renderer.ts';
import type { ScreenFrame, TerminalPort } from '../../v0/tui/terminal.ts';

const entry = (id: string, text: string, kind: UiLogEntry['kind'] = 'thinking') =>
  freezeUiLogEntry({ id, text, kind, label: kind + '>', revision: 0, live: false });

const fixture = (entries: readonly UiLogEntry[], deferred = false) => {
  const store = new KeyedConversationStore();
  entries.forEach((row) => store.set(row.id, row));
  store.replaceSemanticOrder(entries.map((row) => row.id));
  let size = { columns: 80, rows: 24 };
  let ordinal = 0;
  const timers = new Map<number, () => void>();
  const receipts: Array<() => void> = [];
  const frames: ScreenFrame[] = [];
  const terminal: TerminalPort = {
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => size,
    setRaw: () => {},
    read: () => Promise.resolve(null),
    drainAndCloseInput: () => Promise.resolve(),
    write: () => {},
    writeFrame: (frame, receipt) => {
      frames.push(frame);
      if (receipt !== undefined) {
        if (deferred) receipts.push(receipt);
        else receipt();
      }
    },
    addSignal: () => {},
    removeSignal: () => {},
  };
  const renderer = new TuiRenderer(terminal, {
    setTimeout: (callback) => {
      timers.set(++ordinal, callback);
      return ordinal;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  });
  const flush = () => renderer.flushRender();
  renderer.setKeyedConversationStore(store, true, true, undefined, new Set(store.ids()));
  flush();
  return {
    renderer,
    store,
    flush,
    frames,
    receipt: () => receipts.shift()?.(),
    resize: (columns: number, rows: number) => {
      size = { columns, rows };
      renderer.resize(columns, rows);
    },
    update: (row: UiLogEntry) => {
      store.set(row.id, row);
      renderer.setKeyedConversationStore(store, false, false, undefined, new Set([row.id]));
    },
  };
};

Deno.test('Increment 198 dirty IDs accumulate before a frame; invisible updates preserve the viewport', () => {
  const rows = Array.from({ length: 60 }, (_, i) => entry(`e${i}`, `body-${i}`));
  const f = fixture(rows);
  try {
    const before = f.renderer.layoutSnapshot().viewport;
    f.update(entry('e0', 'invisible replacement'));
    f.flush();
    strictEqual(f.renderer.layoutSnapshot().viewport, before);
    f.update(entry('e58', 'first visible update'));
    f.update(entry('e59', 'second visible update'));
    f.flush();
    const final = f.frames.at(-1)!.rows.join('\n');
    ok(final.includes('first visible update') && final.includes('second visible update'));
    f.renderer.setEditor('draft');
    f.renderer.setStatus('new footer');
    f.flush();
    const stable = f.renderer.layoutSnapshot().viewport;
    f.renderer.setEditor('draft changed');
    f.flush();
    strictEqual(f.renderer.layoutSnapshot().viewport, stable);
  } finally {
    f.renderer.close();
  }
});

Deno.test('Increment 198 label settlement reuses the body and an overlay does no conversation rendering', () => {
  const f = fixture([entry('thought', 'normal body')]);
  const original = BodyDocument.prototype.render;
  let renders = 0;
  BodyDocument.prototype.render = function (...args) {
    renders++;
    return original.apply(this, args);
  };
  try {
    f.update(
      freezeUiLogEntry({ ...entry('thought', 'normal body'), label: 'thinking~', live: true }),
    );
    f.flush();
    // One label row is updated; the body row remains the same object and terminal text.
    strictEqual(renders, 1);
    f.renderer.renderReadOnlyHelp(['help covers the conversation']);
    f.flush();
    renders = 0;
    f.update(entry('thought', 'changed while covered'));
    f.flush();
    strictEqual(renders, 0);
    f.renderer.clearModal();
    f.flush();
    ok(f.frames.at(-1)!.rows.some((row) => row.includes('changed while covered')));
  } finally {
    BodyDocument.prototype.render = original;
    f.renderer.close();
  }
});

Deno.test('Increment 198 a single entry beyond terminal scrollback stays completely pageable', () => {
  const lines = Array.from({ length: 2300 }, (_, i) => `LINE_${String(i).padStart(4, '0')}`);
  const f = fixture([entry('large', lines.join('\n'))]);
  try {
    const seen = new Set<string>();
    const collect = () => {
      for (const row of f.renderer.layoutSnapshot().viewport!.rows) {
        if (row.text.startsWith('LINE_')) seen.add(row.text);
      }
    };
    collect();
    for (let i = 0; i < 150 && f.renderer.stateSnapshot().scroll.kind !== 'oldest'; i++) {
      f.renderer.scrollPage('up');
      f.flush();
      collect();
    }
    strictEqual(f.renderer.stateSnapshot().scroll.kind, 'oldest');
    strictEqual(seen.size, lines.length);
    f.renderer.setEditor('draft while browsing');
    f.update(entry('large', lines.join('\n') + '\nNEW_TAIL'));
    f.flush();
    strictEqual(f.renderer.stateSnapshot().scroll.kind, 'oldest');
    strictEqual(f.renderer.stateSnapshot().editor.text, 'draft while browsing');
    for (let i = 0; i < 150 && f.renderer.stateSnapshot().scroll.kind !== 'followLatest'; i++) {
      f.renderer.scrollPage('down');
      f.flush();
    }
    strictEqual(f.renderer.stateSnapshot().scroll.kind, 'followLatest');
    ok(f.frames.at(-1)!.rows.some((row) => row.includes('NEW_TAIL')));
  } finally {
    f.renderer.close();
  }
});

Deno.test('Increment 198 pending Page operations survive resize and an old output receipt', () => {
  const rows = [entry('long', Array.from({ length: 300 }, (_, i) => `row ${i}`).join('\n'))];
  const burst = fixture(rows, true);
  const sequential = fixture(rows);
  try {
    burst.receipt();
    for (const f of [burst, sequential]) f.renderer.scrollPage('up');
    burst.flush();
    sequential.flush();
    for (const f of [burst, sequential]) f.renderer.scrollPage('up');
    sequential.flush();
    burst.resize(40, 24);
    sequential.resize(40, 24);
    // A receipt from the previous width must not replace the pending position.
    burst.receipt();
    for (const f of [burst, sequential]) {
      f.renderer.scrollPage('up');
      f.flush();
    }
    deepStrictEqual(
      burst.renderer.stateSnapshot().scroll,
      sequential.renderer.stateSnapshot().scroll,
    );
    deepStrictEqual(burst.frames.at(-1)!.rows, sequential.frames.at(-1)!.rows);
  } finally {
    burst.renderer.close();
    sequential.renderer.close();
  }
});

Deno.test('Increment 198 resize resolves UTF-16 source text with wide and joined graphemes', () => {
  const text = '漢字👨‍👩‍👧‍👦é'.repeat(2000);
  const f = fixture([entry('unicode', text)]);
  try {
    f.renderer.scrollPage('up');
    f.flush();
    const source = f.renderer.layoutSnapshot().viewport!.cursors[0].sourceUtf16Offset;
    f.resize(31, 24);
    f.flush();
    const cursors = f.renderer.layoutSnapshot().viewport!.cursors;
    ok(
      cursors[0].sourceUtf16Offset <= source,
      JSON.stringify({
        source,
        cursors: cursors.slice(0, 2),
        scroll: f.renderer.stateSnapshot().scroll,
      }),
    );
    ok(cursors[1].sourceUtf16Offset > source);
    ok(f.renderer.layoutSnapshot().viewport!.rows.every((row) => !row.text.startsWith('\u200d')));
  } finally {
    f.renderer.close();
  }
});

Deno.test('Increment 198 only assistant answers apply Markdown styles', () => {
  const rows = [
    entry('thinking', '# Thought **plain**'),
    freezeUiLogEntry({
      ...entry('note', '# Note **plain**', 'assistant'),
      label: 'assistant note>',
    }),
    entry('answer', '# Answer **styled**', 'assistant'),
  ];
  const f = fixture(rows);
  try {
    const visible = f.renderer.layoutSnapshot().viewport!.rows;
    ok(
      visible.filter((row) => row.entryId === 'thinking' || row.entryId === 'note')
        .every((row) => (row.spans?.length ?? 0) === 0),
    );
    ok(visible.some((row) => row.entryId === 'answer' && (row.spans?.length ?? 0) > 0));
  } finally {
    f.renderer.close();
  }
});

Deno.test('Increment 198 latest then Page before drawing uses the latest logical position', () => {
  const rows = [entry('history', Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'))];
  const burst = fixture(rows);
  const sequential = fixture(rows);
  try {
    for (const f of [burst, sequential]) {
      f.renderer.scrollPage('up');
      f.flush();
      f.renderer.scrollPage('up');
      f.flush();
      f.renderer.latest();
    }
    sequential.flush();
    for (const f of [burst, sequential]) {
      f.renderer.scrollPage('up');
      f.flush();
    }
    deepStrictEqual(burst.frames.at(-1)!.rows, sequential.frames.at(-1)!.rows);
    deepStrictEqual(
      burst.renderer.stateSnapshot().scroll,
      sequential.renderer.stateSnapshot().scroll,
    );
  } finally {
    burst.renderer.close();
    sequential.renderer.close();
  }
});

Deno.test('Increment 198 viewport boundaries do not measure a covered earlier entry', () => {
  const original = BodyDocument.prototype.last;
  const old = entry('old', 'x'.repeat(900_000));
  const current = entry(
    'current',
    Array.from({ length: 100 }, (_, i) => `current ${i}`).join('\n'),
  );
  let oldMeasured = 0;
  BodyDocument.prototype.last = function (...args) {
    const row = original.apply(this, args);
    if (this.render(this.first(args[0]), args[0]).text === 'x'.repeat(80)) oldMeasured++;
    return row;
  };
  let f: ReturnType<typeof fixture> | undefined;
  try {
    f = fixture([old, current]);
    strictEqual(oldMeasured, 0);
    // At the exact first row of the current body, history flags must not touch the old document.
    for (let i = 0; i < 4; i++) {
      f.renderer.scrollPage('up');
      f.flush();
    }
    strictEqual(oldMeasured, 0);
  } finally {
    BodyDocument.prototype.last = original;
    f?.renderer.close();
  }
});

Deno.test('Increment 198 Page bursts compute positions without rendering intermediate pages', () => {
  const f = fixture([
    entry('history', Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')),
  ]);
  const original = BodyDocument.prototype.render;
  let generated = 0;
  BodyDocument.prototype.render = function (...args) {
    generated++;
    return original.apply(this, args);
  };
  try {
    f.renderer.scrollPage('up');
    f.renderer.scrollPage('up');
    f.renderer.scrollPage('up');
    strictEqual(generated, 0);
    f.flush();
    ok(generated > 0 && generated <= f.renderer.layoutSnapshot().log.length);
  } finally {
    BodyDocument.prototype.render = original;
    f.renderer.close();
  }
});

Deno.test('Increment 198 plain tail append retains unchanged visible rows and terminal styling', () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
  const f = fixture([entry('thought', text)]);
  const before = f.renderer.layoutSnapshot().viewport!.rows;
  const original = BodyDocument.prototype.render;
  let generated = 0;
  BodyDocument.prototype.render = function (...args) {
    generated++;
    return original.apply(this, args);
  };
  try {
    f.update(entry('thought', text + '!'));
    f.flush();
    const after = f.renderer.layoutSnapshot().viewport!.rows;
    strictEqual(generated, 1);
    for (let i = 0; i < before.length - 1; i++) strictEqual(after[i], before[i]);
    ok(f.frames.at(-1)!.rows.some((row) => row.includes('line 299!')));
  } finally {
    BodyDocument.prototype.render = original;
    f.renderer.close();
  }
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
