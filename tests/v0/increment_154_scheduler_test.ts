import { deepStrictEqual, strictEqual } from 'node:assert';
import { TuiRenderer } from '../../v0/tui/tui_renderer.ts';
import { type ScreenFrame, type TerminalPort } from '../../v0/tui/terminal.ts';
import { markdownAssistantRenderer } from '../../v0/tui/assistant_layout.ts';

const fixture = (columns = 120, rows = 40, completeWrites = true) => {
  let now = 0;
  let id = 0;
  let interval = () => {};
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  const frames: ScreenFrame[] = [];
  const pendingWrites: Array<() => void> = [];
  const rendered: string[] = [];
  const terminal: TerminalPort = {
    stdinIsTerminal: () => true,
    stdoutIsTerminal: () => true,
    consoleSize: () => ({ columns, rows }),
    setRaw: () => {},
    read: () => Promise.resolve(null),
    drainAndCloseInput: () => Promise.resolve(),
    write: () => {},
    writeFrame: (frame, onWritten) => {
      frames.push(frame);
      if (completeWrites) onWritten?.();
      else if (onWritten !== undefined) pendingWrites.push(onWritten);
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
    assistantRenderer: {
      render: (text, phase, width) => {
        rendered.push(text);
        return markdownAssistantRenderer.render(text, phase, width);
      },
    },
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
    rendered,
    callbacks,
    delays,
    tick,
    spin: () => interval(),
    writeNext: () => pendingWrites.shift()?.(),
  };
};

Deno.test('Increment 154 setters update state immediately and merge display work into one frame', () => {
  const f = fixture();
  let layouts = 0;
  const original = f.renderer.layoutSnapshot.bind(f.renderer);
  f.renderer.layoutSnapshot = (...args) => {
    layouts++;
    return original(...args);
  };
  f.renderer.setEditor('abc');
  f.renderer.setStatus('ready');
  f.renderer.setSlashCommandCandidates([]);
  strictEqual(f.renderer.stateSnapshot().editor.text, 'abc');
  strictEqual(f.frames.length, 0);
  strictEqual(f.callbacks.size, 1);
  f.tick();
  strictEqual(layouts, 1);
  strictEqual(f.frames.length, 1);
  strictEqual(f.frames[0].rows.some((row) => row === '> abc'), true);
  f.renderer.close();
});

Deno.test('Increment 154 latest conversation projection is applied once within the reserved frame', () => {
  const f = fixture();
  const applied: number[] = [];
  f.renderer.updateConversation(() => {
    applied.push(1);
  });
  f.renderer.updateConversation(() => {
    applied.push(2);
    f.renderer.setConversationEntries([{
      id: 'a',
      kind: 'assistant',
      label: 'assistant>',
      text: 'latest',
      revision: 1,
      live: false,
    }], 0);
  });
  f.tick();
  deepStrictEqual(applied, [2]);
  strictEqual(f.frames.length, 1);
  strictEqual(f.callbacks.size, 0);
  strictEqual(f.frames[0].rows.some((row) => row.includes('latest')), true);
  f.renderer.close();
});

Deno.test('Increment 154 deferred Session projection preserves an overlay opened after switching', () => {
  const f = fixture();
  f.renderer.clearModal();
  f.renderer.latest();
  f.renderer.updateConversation(() => {
    f.renderer.setConversationEntries([], 0, true);
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

Deno.test('Increment 154 editor and spinner reuse body layout; changed entry alone is rendered again', () => {
  const f = fixture();
  const entries = ['first', 'second'].map((text, index) => ({
    id: `a-${index}`,
    kind: 'assistant' as const,
    label: 'assistant>',
    text,
    revision: 0,
    live: false,
  }));
  f.renderer.setConversationEntries(entries, 0);
  f.tick();
  deepStrictEqual(f.rendered, ['first', 'second']);
  f.renderer.setEditor('typed');
  f.renderer.setStatus('busy');
  f.tick();
  f.renderer.eventSink({ kind: 'turn_start', turn: 1 });
  f.tick();
  f.spin();
  f.tick();
  deepStrictEqual(f.rendered, ['first', 'second']);
  f.renderer.setConversationEntries(
    [entries[0], { ...entries[1], text: 'changed', revision: 1 }],
    0,
  );
  f.tick();
  deepStrictEqual(f.rendered, ['first', 'second', 'changed']);
  f.renderer.close();
});

Deno.test('Increment 154 resize notifications survive same-size frame merging and scope switch drops old projection', () => {
  const f = fixture();
  f.renderer.setEditor('');
  f.tick();
  f.renderer.resize(120, 20);
  f.renderer.resize(120, 40);
  f.tick();
  strictEqual(f.frames.length, 2);
  deepStrictEqual(f.frames[0].size, f.frames[1].size);
  strictEqual(
    f.frames[1].geometryGeneration,
    f.frames[0].geometryGeneration + 2,
  );
  let stale = false;
  f.renderer.updateConversation(() => {
    stale = true;
  });
  f.renderer.setDisplayScope('core:new-session');
  f.renderer.updateConversation(() => {});
  f.tick();
  strictEqual(stale, false);
  strictEqual(f.frames.at(-1)?.scope, 'core:new-session');
  f.renderer.close();
});

Deno.test('Increment 154 close cancels pending display and delayed rendering errors reach the exit handler', () => {
  const f = fixture();
  let failures = 0;
  f.renderer.subscribeRenderFailure(() => {
    failures++;
  });
  f.renderer.updateConversation(() => {
    throw new Error('projection failed');
  });
  f.tick();
  strictEqual(failures, 1);
  strictEqual(f.frames.length, 0);
  f.renderer.setEditor('pending');
  f.renderer.close();
  f.tick();
  strictEqual(f.frames.length, 0);
  strictEqual(f.callbacks.size, 0);
});

Deno.test('Increment 154 Page bursts and pending writes retain intermediate history windows', () => {
  for (const completeWrites of [true, false]) {
    const burst = fixture(80, 24, completeWrites);
    const separated = fixture(80, 24);
    const entries = Array.from({ length: 200 }, (_, index) => ({
      id: `m${index}`,
      kind: 'assistant' as const,
      label: 'assistant>',
      text: `message ${index}`,
      revision: 0,
      live: false,
    }));
    for (const f of [burst, separated]) {
      f.renderer.setConversationEntries(entries, 0);
      f.tick();
      f.writeNext();
      f.renderer.scrollPage('up');
      f.renderer.scrollPage('up');
      f.tick();
    }
    for (const direction of ['up', 'down'] as const) {
      for (let index = 0; index < 2; index++) {
        burst.renderer.scrollPage(direction);
        separated.renderer.scrollPage(direction);
        separated.tick();
      }
      burst.tick();
      burst.writeNext();
      deepStrictEqual(
        burst.renderer.stateSnapshot().historyWindow,
        separated.renderer.stateSnapshot().historyWindow,
      );
      deepStrictEqual(
        burst.renderer.stateSnapshot().scroll,
        separated.renderer.stateSnapshot().scroll,
      );
      deepStrictEqual(burst.frames.at(-1)?.rows, separated.frames.at(-1)?.rows);
    }
    burst.renderer.close();
    separated.renderer.close();
  }
});
