import { deepStrictEqual, strictEqual } from 'node:assert';
import { TuiRenderer } from '../../v0/tui/tui_renderer.ts';
import { type ScreenFrame, type TerminalPort } from '../../v0/tui/terminal.ts';
import { KeyedConversationStore } from '../../v0/tui/keyed_conversation_store.ts';
import { freezeUiLogEntry, type UiLogEntry } from '../../v0/tui/state.ts';

const keyedStore = (entries: readonly UiLogEntry[]): KeyedConversationStore => {
  const store = new KeyedConversationStore();
  for (const entry of entries) store.set(entry.id, entry);
  store.replaceSemanticOrder(entries.map((entry) => entry.id));
  return store;
};

const fixture = (columns = 120, rows = 40) => {
  let now = 0;
  let id = 0;
  let interval = () => {};
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  const frames: ScreenFrame[] = [];
  const terminal: TerminalPort = {
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => ({ columns, rows }),
    setRaw: () => {},
    read: () => Promise.resolve(null),
    drainAndCloseInput: () => Promise.resolve(),
    write: () => {
      frames.push(renderer.renderScreenFrame());
    },
    addSignal: () => {},
    removeSignal: () => {},
  };
  const renderer = new TuiRenderer(terminal, {
    now: () => now,
    setTimeout: (callback, delay) => {
      callbacks.set(++id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeout: (id) => {
      callbacks.delete(id as number);
    },
    setInterval: (callback) => {
      interval = callback;
      return 'busy';
    },
    clearInterval: () => {},
  });
  const tick = () => {
    now += 16;
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  };
  return {
    renderer,
    frames,
    callbacks,
    delays,
    tick,
    spin: () => interval(),
  };
};

Deno.test('Increment 154 setters update state immediately and merge display work into one frame', () => {
  const f = fixture();
  f.renderer.setEditor('abc');
  f.renderer.setStatus('ready');
  f.renderer.setSlashCommandCandidates([]);
  strictEqual(f.renderer.stateSnapshot().editor.text, 'abc');
  strictEqual(f.frames.length, 0);
  strictEqual(f.callbacks.size, 1);
  f.tick();
  strictEqual(f.frames.length, 1);
  strictEqual(f.frames[0].rows.some((row) => row === '> abc'), true);
  f.renderer.close();
});

Deno.test('Increment 154 applies each conversation update and merges only the frame', () => {
  const f = fixture();
  const applied: number[] = [];
  f.renderer.updateConversation(() => {
    applied.push(1);
  });
  f.renderer.updateConversation(() => {
    applied.push(2);
    f.renderer.setKeyedConversationStore(
      keyedStore([freezeUiLogEntry({
        id: 'a',
        kind: 'assistant',
        label: 'assistant>',
        text: 'latest',
        revision: 1,
        live: false,
      })]),
    );
  });
  deepStrictEqual(applied, [1, 2]);
  f.tick();
  deepStrictEqual(applied, [1, 2]);
  strictEqual(f.frames.length, 1);
  strictEqual(f.callbacks.size, 0);
  strictEqual(f.frames[0].rows.some((row) => row.includes('latest')), true);
  f.renderer.close();
});

Deno.test('Increment 154 deferred Session projection preserves an overlay opened after switching', () => {
  const f = fixture();
  f.renderer.clearModal();
  f.renderer.updateConversation(() => {
    f.renderer.setKeyedConversationStore(new KeyedConversationStore());
  });
  f.renderer.renderReadOnlyHelp(['new context after Session switch']);
  f.tick();
  strictEqual(f.renderer.stateSnapshot().overlay.kind, 'readOnlyHelp');
  strictEqual(
    f.frames[0].rows.some((row) => row.includes('new context')),
    true,
  );
  f.renderer.close();
});

Deno.test('212 scope replacement replays saved conversation even when its content is identical', () => {
  const f = fixture();
  f.renderer.setDisplayScope('session-a');
  f.renderer.setKeyedConversationStore(
    keyedStore([
      freezeUiLogEntry({
        id: 'answer',
        kind: 'assistant',
        label: 'assistant>',
        text: 'saved answer',
        live: false,
        revision: 0,
      }),
    ]),
  );
  f.tick();
  strictEqual(f.frames.length, 1);
  f.renderer.setDisplayScope('session-b');
  f.tick();
  strictEqual(f.frames.length, 2);
  strictEqual(f.frames[1].rows.some((row) => row.includes('saved answer')), true);
  f.renderer.close();
});

Deno.test('Increment 154 display work is synchronous and close cancels the reserved frame', () => {
  const f = fixture();
  let failures = 0;
  f.renderer.subscribeRenderFailure(() => {
    failures++;
  });
  let threw = false;
  try {
    f.renderer.updateConversation(() => {
      throw new Error('projection failed');
    });
  } catch {
    threw = true;
  }
  strictEqual(threw, true);
  strictEqual(failures, 0);
  strictEqual(f.frames.length, 0);
  f.renderer.setEditor('pending');
  f.renderer.close();
  f.tick();
  strictEqual(f.frames.length, 0);
  strictEqual(f.callbacks.size, 0);
});
