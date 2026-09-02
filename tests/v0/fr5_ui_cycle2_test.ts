import { createUiState, reduceUiAction } from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { TuiEditor } from '../../v0/tui/input.ts';
import { layoutEditorText, pendingMetadataRows, TuiRenderer } from '../../v0/tui/render.ts';
import { type PresentationStartupState } from '../../v0/presentation/contract.ts';
import {
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  TerminalLifecycle,
  type TerminalPort,
} from '../../v0/tui/terminal.ts';
import { type PendingMetadataSnapshot } from '../../v0/tui/pending_input.ts';

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

class RecordingTerminal implements TerminalPort {
  readonly writes: string[] = [];
  readonly rawModes: boolean[] = [];
  size = { columns: 80, rows: 24 };

  stdinIsTerminal(): boolean {
    return true;
  }

  stdoutIsTerminal(): boolean {
    return true;
  }

  consoleSize(): { columns: number; rows: number } {
    return this.size;
  }

  setRaw(mode: boolean): void {
    this.rawModes.push(mode);
  }

  read(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  drainAndCloseInput(): Promise<void> {
    return Promise.resolve();
  }

  write(bytes: Uint8Array): void {
    this.writes.push(new TextDecoder().decode(bytes));
  }

  addSignal(): void {}

  removeSignal(): void {}
}

const indexOfWrite = (writes: readonly string[], value: string): number =>
  writes.findIndex((write) => write.includes(value));

Deno.test('Cycle 2 retained rendering isolates redraws in the alternate screen', async () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);

  await lifecycle.acquire();
  renderer.setEditor('draft');
  renderer.eventSink({
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'inspect' } },
  });
  renderer.eventSink({
    kind: 'tool_progress',
    turn: 1,
    callId: 'read-1',
    name: 'read',
    text: 'running',
  });
  renderer.eventSink({
    kind: 'assistant_progress',
    turn: 1,
    text: 'working',
  });

  const enter = indexOfWrite(terminal.writes, ENTER_ALTERNATE_SCREEN);
  const exitBeforeRestore = indexOfWrite(terminal.writes, EXIT_ALTERNATE_SCREEN);
  assert(enter >= 0);
  assertEquals(exitBeforeRestore, -1);
  assert(
    terminal.writes.slice(0, enter).every((write) => !write.includes('\x1b[2J')),
    'a retained frame was written before alternate-screen entry',
  );
  assert(
    terminal.writes.slice(enter + 1).some((write) => write.includes('\x1b[2J\x1b[H')),
    'redraws should remain full-frame updates inside the alternate screen',
  );

  await lifecycle.restore();
  const exit = indexOfWrite(terminal.writes, EXIT_ALTERNATE_SCREEN);
  assert(exit > enter);
  assert(
    terminal.writes.slice(enter + 1, exit).some((write) => write.includes('\x1b[2J\x1b[H')),
  );
  assertEquals(terminal.rawModes, [true, false]);
  assertEquals(terminal.writes.filter((write) => write.includes(EXIT_ALTERNATE_SCREEN)).length, 1);
  assertEquals(terminal.writes.at(-1), '\x1b[?25h');

  await lifecycle.restore();
  assertEquals(terminal.writes.filter((write) => write.includes(EXIT_ALTERNATE_SCREEN)).length, 1);
});

Deno.test('Cycle 2 footer omits editor bytes while retaining pending and recovery lanes', () => {
  const pending: PendingMetadataSnapshot = {
    lanes: [
      { kind: 'editor', lifecycle: 'draft', present: true, byteCount: 30 },
      { kind: 'active_task', lifecycle: 'active_uncommitted', present: true, byteCount: 4 },
      { kind: 'steering', lifecycle: 'admitted_unconsumed', present: false, byteCount: 0 },
      { kind: 'follow_up', lifecycle: 'queued_unsubmitted', present: false, byteCount: 0 },
      { kind: 'active_task', lifecycle: 'recoverable', present: true, byteCount: 6 },
      { kind: 'steering', lifecycle: 'recoverable', present: false, byteCount: 0 },
      { kind: 'follow_up', lifecycle: 'recoverable', present: false, byteCount: 0 },
    ],
    recoveryCount: 1,
  };
  const withPending = reduceUiAction(createUiState(), { kind: 'pending', snapshot: pending });
  const footer = layoutUi(withPending, 160, 24).footer.text;
  assert(!footer.includes('editor:30B'));
  assert(footer.includes('active_task:4B'));
  assert(footer.includes('active_task:6B'));
  assertEquals(pendingMetadataRows(pending), ['p E:d:30 A:a:4', 'r A:6']);

  const editorOnly = reduceUiAction(createUiState(), {
    kind: 'pending',
    snapshot: {
      lanes: [{ kind: 'editor', lifecycle: 'draft', present: true, byteCount: 30 }],
      recoveryCount: 0,
    },
  });
  assert(!layoutUi(editorOnly, 160, 24).footer.text.includes('pending'));
});

Deno.test('Cycle 2 keeps verified fullwidth form cells consistent through edit and render layout', () => {
  const editor = new TuiEditor();
  const pasted = '直近５コミットの';
  assert(editor.paste(pasted));
  let snapshot = editor.snapshot();
  let layout = layoutUi(createUiState(snapshot), 80, 24);
  let rendered = layoutEditorText(snapshot, 80, 8);
  assertEquals(layout.input[0]?.text, pasted);
  assertEquals(layout.cursor.cell, 18); // prompt (2) + 16 display cells
  assertEquals(rendered.cursorCell, 16);
  assertEquals(layout.cursor.cell, rendered.cursorCell + 2);

  assert(editor.backspace());
  assertEquals(editor.text, '直近５コミット');
  assert(editor.insert('x'));
  snapshot = editor.snapshot();
  layout = layoutUi(createUiState(snapshot), 80, 24);
  rendered = layoutEditorText(snapshot, 80, 8);
  assertEquals(editor.text, '直近５コミットx');
  assertEquals(layout.cursor.cell, 17); // prompt (2) + 15 display cells
  assertEquals(rendered.cursorCell, 15);
  assertEquals(layout.cursor.cell, rendered.cursorCell + 2);

  const halfwidth = new TuiEditor();
  assert(halfwidth.paste('５ﾊ'));
  const halfwidthLayout = layoutUi(createUiState(halfwidth.snapshot()), 80, 24);
  assertEquals(halfwidthLayout.cursor.cell, 5); // prompt (2) + fullwidth 2 + halfwidth 1
});

Deno.test('Cycle 2 PageUp at the oldest boundary anchors the first conversation entry', () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const startup: PresentationStartupState = {
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: { provider: 'openrouter', profileId: 'test' },
    sessionMode: { kind: 'new' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  renderer.renderCompactStartup(startup);
  terminal.size = { columns: 80, rows: 10 };
  renderer.resize(80, 10);
  for (let turn = 1; turn <= 6; turn += 1) {
    renderer.eventSink({
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text: `question ${turn}` } },
    });
    renderer.eventSink({
      kind: 'assistant_message',
      turn,
      message: { role: 'assistant', content: { kind: 'text', text: `answer ${turn}` } },
    });
  }
  // Keep the startup projection present so the oldest page begins with a non-conversation row,
  // matching the production boundary that previously jumped back to the latest page.
  renderer.renderCompactStartup(startup);

  renderer.scrollPage('up');
  const oldest = renderer.stateSnapshot().scroll;
  assertEquals(oldest, {
    kind: 'anchored',
    entryId: 'turn-1:user',
    sourceScalarOffset: 0,
  });
  assertEquals(renderer.layoutSnapshot(80, 10).logStart, 2); // two startup rows precede conversation

  renderer.scrollPage('down');
  assert(renderer.stateSnapshot().scroll.kind === 'anchored');
  renderer.latest();
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'followLatest' });
});
