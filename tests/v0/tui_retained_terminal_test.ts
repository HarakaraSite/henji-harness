import { createUiState, reduceUiAction } from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { TuiEditor, TuiEditorHistory } from '../../v0/tui/input.ts';
import { layoutEditorText, pendingMetadataRows, TuiRenderer } from '../../v0/tui/render.ts';
import { TuiController, TuiControllerError, type TuiSessionLike } from '../../v0/tui/controller.ts';
import {
  type PresentationIntentDispatcher,
  type PresentationIntentResult,
  type PresentationStartupState,
} from '../../v0/presentation/contract.ts';
import {
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  TerminalLifecycle,
  type TerminalPort,
} from '../../v0/tui/terminal.ts';
import { PendingInputCore, type PendingMetadataSnapshot } from '../../v0/tui/pending_input.ts';

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
  readonly rawCbreaks: boolean[] = [];
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

  setRaw(mode: boolean, options: { cbreak: boolean } = { cbreak: true }): void {
    this.rawModes.push(mode);
    this.rawCbreaks.push(options.cbreak);
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

class InteractiveTerminal extends RecordingTerminal {
  private readonly queued: Uint8Array[] = [];
  private readonly readers: Array<(value: Uint8Array | null) => void> = [];

  override read(): Promise<Uint8Array | null> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.readers.push(resolve));
  }

  push(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const reader = this.readers.shift();
    if (reader === undefined) this.queued.push(bytes);
    else reader(bytes);
  }

  override drainAndCloseInput(): Promise<void> {
    for (const reader of this.readers.splice(0)) reader(null);
    this.queued.splice(0);
    return Promise.resolve();
  }
}

class FallibleInteractiveTerminal extends InteractiveTerminal {
  failNextWrite = false;

  override write(bytes: Uint8Array): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('injected terminal write failure');
    }
    super.write(bytes);
  }
}

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
};

const fillConversation = (renderer: TuiRenderer): void => {
  for (let turn = 1; turn <= 6; turn += 1) {
    renderer.eventSink({
      kind: 'user_message',
      turn,
      message: {
        role: 'user',
        content: { kind: 'text', text: `question ${turn}` },
      },
    });
    renderer.eventSink({
      kind: 'assistant_message',
      turn,
      message: {
        role: 'assistant',
        content: { kind: 'text', text: `answer ${turn}` },
      },
    });
  }
};

const successfulSession = (submitted: string[]): TuiSessionLike => ({
  submit: (task) => {
    submitted.push(task);
    return Promise.resolve({
      ok: true,
      task,
      outcome: 'final',
      stopReason: 'final',
      finalText: 'done',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    });
  },
});

const indexOfWrite = (writes: readonly string[], value: string): number =>
  writes.findIndex((write) => write.includes(value));

Deno.test('retained rendering isolates redraws in the alternate screen', async () => {
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
  const exitBeforeRestore = indexOfWrite(
    terminal.writes,
    EXIT_ALTERNATE_SCREEN,
  );
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
  assertEquals(terminal.rawCbreaks, [false, true]);
  assertEquals(
    terminal.writes.filter((write) => write.includes(EXIT_ALTERNATE_SCREEN))
      .length,
    1,
  );
  assertEquals(terminal.writes.at(-1), '\x1b[?25h');

  await lifecycle.restore();
  assertEquals(
    terminal.writes.filter((write) => write.includes(EXIT_ALTERNATE_SCREEN))
      .length,
    1,
  );
});

Deno.test('retained footer omits editor bytes while keeping pending and recovery lanes', () => {
  const pending: PendingMetadataSnapshot = {
    lanes: [
      { kind: 'editor', lifecycle: 'draft', present: true, byteCount: 30 },
      {
        kind: 'active_task',
        lifecycle: 'active_uncommitted',
        present: true,
        byteCount: 4,
      },
      {
        kind: 'steering',
        lifecycle: 'admitted_unconsumed',
        present: false,
        byteCount: 0,
      },
      {
        kind: 'follow_up',
        lifecycle: 'queued_unsubmitted',
        present: false,
        byteCount: 0,
      },
      {
        kind: 'active_task',
        lifecycle: 'recoverable',
        present: true,
        byteCount: 6,
      },
      {
        kind: 'steering',
        lifecycle: 'recoverable',
        present: false,
        byteCount: 0,
      },
      {
        kind: 'follow_up',
        lifecycle: 'recoverable',
        present: false,
        byteCount: 0,
      },
    ],
    recoveryCount: 1,
  };
  const withPending = reduceUiAction(createUiState(), {
    kind: 'pending',
    snapshot: pending,
  });
  const footer = layoutUi(withPending, 160, 24).footer[0].text;
  assert(!footer.includes('editor:30B'));
  assert(footer.includes('active_task:4B'));
  assert(footer.includes('active_task:6B'));
  assertEquals(pendingMetadataRows(pending), ['p E:d:30 A:a:4', 'r A:6']);

  const editorOnly = reduceUiAction(createUiState(), {
    kind: 'pending',
    snapshot: {
      lanes: [{
        kind: 'editor',
        lifecycle: 'draft',
        present: true,
        byteCount: 30,
      }],
      recoveryCount: 0,
    },
  });
  assert(!layoutUi(editorOnly, 160, 24).footer[0].text.includes('pending'));
});

Deno.test('retained layout keeps fullwidth form cells consistent through edit and render', () => {
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

Deno.test('retained PageUp at the oldest boundary anchors the first conversation entry', () => {
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
  assertEquals(
    renderer.stateSnapshot().startup[1],
    'trusted-local · credentials checked only when sending',
  );
  terminal.size = { columns: 80, rows: 10 };
  renderer.resize(80, 10);
  for (let turn = 1; turn <= 6; turn += 1) {
    renderer.eventSink({
      kind: 'user_message',
      turn,
      message: {
        role: 'user',
        content: { kind: 'text', text: `question ${turn}` },
      },
    });
    renderer.eventSink({
      kind: 'assistant_message',
      turn,
      message: {
        role: 'assistant',
        content: { kind: 'text', text: `answer ${turn}` },
      },
    });
  }
  // Keep the startup projection present so the oldest page begins with a non-conversation row,
  // matching the production boundary that previously jumped back to the latest page.
  renderer.renderCompactStartup(startup);

  for (let page = 0; page < 4; page += 1) renderer.scrollPage('up');
  const oldest = renderer.stateSnapshot().scroll;
  assertEquals(oldest, {
    kind: 'anchored',
    entryId: 'turn-1:user',
    sourceScalarOffset: 0,
  });
  assertEquals(renderer.layoutSnapshot(80, 10).logStart, 2); // two startup rows precede conversation
  assert(
    renderer.layoutSnapshot(80, 10).footer[0].text.includes('history rows'),
  );
  assert(renderer.layoutSnapshot(80, 10).footer[0].text.includes('Esc latest'));

  renderer.setStatus(
    `unknown command /${'x'.repeat(100)}, try: /help, /sessions, /exit`,
  );
  assert(
    renderer.layoutSnapshot(80, 10).footer[0].text.startsWith('[history rows'),
  );

  renderer.renderStartupHelp();
  assert(
    !renderer.layoutSnapshot(80, 10).footer[0].text.includes('Esc latest'),
  );
  assert(
    renderer.layoutSnapshot(80, 10).overlay[0].text.includes('Esc return'),
  );
  renderer.clearModal();
  assert(renderer.layoutSnapshot(80, 10).footer[0].text.includes('Esc latest'));

  for (let page = 0; page < 4; page += 1) renderer.scrollPage('down');
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'followLatest' });
});

Deno.test('retained PageUp keeps latest when the conversation fits one page', () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  renderer.eventSink({
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'question' } },
  });
  renderer.eventSink({
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: 'answer' } },
  });

  renderer.scrollPage('up');
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'followLatest' });
});

Deno.test('retained controller Escape returns an anchored viewport to latest', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  renderer.resize(80, 10);
  fillConversation(renderer);
  renderer.scrollPage('up');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');

  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession([]),
    {
      pending: new PendingInputCore(),
    },
  );
  const run = controller.run();
  terminal.push('\x1b');
  await waitFor(() => renderer.stateSnapshot().scroll.kind === 'followLatest');
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('retained controller returns to latest only after ordinary task admission', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  renderer.resize(80, 10);
  fillConversation(renderer);
  renderer.scrollPage('up');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');

  const submitted: string[] = [];
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession(submitted),
    {
      pending: new PendingInputCore(),
    },
  );
  const run = controller.run();
  terminal.push('/unknown\r');
  await waitFor(() => renderer.stateSnapshot().status.startsWith('unknown command'));
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');
  terminal.push('\x15accepted task\r');
  await waitFor(() => submitted.length === 1 && controller.currentState === 'idle');
  assertEquals(submitted, ['accepted task']);
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'followLatest' });
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('retained controller keeps the anchor when ordinary task admission fails', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  renderer.resize(80, 10);
  fillConversation(renderer);
  renderer.scrollPage('up');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');

  const pending = new PendingInputCore();
  assert(pending.admitTask('existing task'));
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession([]),
    { pending },
  );
  const run = controller.run();
  terminal.push('\r');
  await waitFor(() => renderer.stateSnapshot().status === 'enter a task');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');
  terminal.push('blocked task\r');
  await waitFor(() => renderer.stateSnapshot().status === 'active task recovery pending');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');
  terminal.push('\x04\x04');
  assertEquals(await run, 0);
});

Deno.test('cancelled active task returns to the empty editor and can be resubmitted', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  let settleCancelled: (() => void) | undefined;
  const session: TuiSessionLike = {
    submit: (task) => {
      submitted.push(task);
      if (submitted.length > 1) {
        return Promise.resolve({
          ok: true,
          task,
          outcome: 'final',
          stopReason: 'final',
          finalText: 'done',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        });
      }
      return new Promise((resolve) => {
        settleCancelled = () =>
          resolve({
            ok: false,
            task,
            outcome: 'cancelled',
            stopReason: 'cancelled',
            error: 'cancelled',
            steps: 1,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          });
      });
    },
    cancelActiveTurn: () => {
      settleCancelled?.();
      return 'requested';
    },
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  const task = 'READMEを韓国語に翻訳して表示して';
  terminal.push(`${task}\r`);
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('\x1b');
  await waitFor(() => controller.currentState === 'idle' && controller.editor.text === task);
  assertEquals(renderer.stateSnapshot().status, 'recovered input; edit or resubmit');

  terminal.push('\r');
  await waitFor(() => submitted.length === 2 && controller.currentState === 'idle');
  assertEquals(submitted, [task, task]);
  assert(!renderer.stateSnapshot().status.includes('active task recovery pending'));
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('occupied editor keeps recoverable task until idle /recover', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let settleFailure: (() => void) | undefined;
  const session: TuiSessionLike = {
    submit: (task) =>
      new Promise((resolve) => {
        settleFailure = () =>
          resolve({
            ok: false,
            task,
            outcome: 'contract_failure',
            stopReason: 'contract_failure',
            error: 'failed',
            steps: 1,
            toolCallCount: 1,
            toolResultCount: 1,
            transcript: [],
          });
      }),
  };
  const pending = new PendingInputCore();
  const controller = new TuiController(lifecycle, renderer, session, { pending });
  const run = controller.run();
  terminal.push('original task\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('draft in progress');
  await waitFor(() => controller.editor.text === 'draft in progress');
  settleFailure?.();
  await waitFor(() => controller.currentState === 'idle');
  assertEquals(controller.editor.text, 'draft in progress');
  assert(pending.hasRecovery);
  assert(renderer.stateSnapshot().status.includes('tools may have changed the workspace'));

  terminal.push('\x15/recover\r');
  await waitFor(() => controller.editor.text === 'original task');
  assert(!pending.hasRecovery);
  assertEquals(
    renderer.stateSnapshot().status,
    'tools may have changed the workspace; inspect before resubmitting',
  );
  terminal.push('\x15\x04');
  assertEquals(await run, 0);
});

Deno.test('idle Ctrl-C clears input without arming or triggering exit', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  const history = new TuiEditorHistory();
  const controller = new TuiController(lifecycle, renderer, successfulSession(submitted), {
    pending: new PendingInputCore(),
    history,
  });
  let exited = false;
  const run = controller.run().then((code) => {
    exited = true;
    return code;
  });
  terminal.push('remember this\r');
  await waitFor(() => submitted.length === 1 && controller.currentState === 'idle');
  terminal.push('line one\x1b\rline two');
  await waitFor(() => controller.editor.text === 'line one\nline two');
  terminal.push('\x03');
  await waitFor(() => controller.editor.text.length === 0);
  assertEquals(controller.currentState, 'idle');
  assert(!exited);
  terminal.push('\x1b[A');
  await waitFor(() => history.navigating && controller.editor.text === 'remember this');
  terminal.push('\x03');
  await waitFor(() => controller.editor.text.length === 0 && !history.navigating);
  terminal.push('\x03');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(controller.currentState, 'idle');
  assert(!exited);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('history export serializes task, session listing, and duplicate export', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const intentsSeen: string[] = [];
  let resolveExport!: (result: PresentationIntentResult) => void;
  const intents: PresentationIntentDispatcher = {
    dispatch: (intent) => {
      intentsSeen.push(intent.kind);
      if (intent.kind === 'history_export') {
        return new Promise((resolve) => {
          resolveExport = resolve;
        });
      }
      if (intent.kind === 'ordinary_submit') {
        throw new Error('task admitted during history export');
      }
      if (intent.kind === 'list_sessions' || intent.kind === 'resume_session') {
        throw new Error('navigation admitted during history export');
      }
      return { kind: 'accepted' };
    },
  };
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession([]),
    { pending: new PendingInputCore(), intents },
  );
  const run = controller.run();
  terminal.push('/history export\r');
  await waitFor(() => controller.currentState === 'history-exporting');
  terminal.push('blocked task\r');
  await waitFor(() => renderer.stateSnapshot().status.includes('retry when ready'));
  terminal.push('\x15/sessions\r');
  terminal.push('\x15/history export\r');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(intentsSeen.filter((kind) => kind === 'history_export').length, 1);
  assert(!intentsSeen.includes('ordinary_submit'));
  assert(!intentsSeen.includes('list_sessions'));
  assert(!intentsSeen.includes('resume_session'));
  resolveExport({
    kind: 'history_export',
    path: '/tmp/history-export.md',
    throughTurn: 2,
  });
  await waitFor(() => controller.currentState === 'idle');
  assert(
    renderer.stateSnapshot().log.entries.some((entry) =>
      entry.text === 'history exported through turn 2: /tmp/history-export.md'
    ),
  );
  terminal.push('\x15\x04');
  assertEquals(await run, 0);
});

Deno.test('history export shutdown waits for settlement and emits no late receipt', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let resolveExport!: (result: PresentationIntentResult) => void;
  const intents: PresentationIntentDispatcher = {
    dispatch: (intent) => {
      if (intent.kind === 'history_export') {
        return new Promise((resolve) => {
          resolveExport = resolve;
        });
      }
      return { kind: 'accepted' };
    },
  };
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession([]),
    { pending: new PendingInputCore(), intents },
  );
  let settled = false;
  const run = controller.run().then((code) => {
    settled = true;
    return code;
  });
  terminal.push('/history export\r');
  await waitFor(() => controller.currentState === 'history-exporting');
  terminal.push('\x04');
  await waitFor(() => controller.currentState === 'exiting');
  assert(!settled);
  assertEquals(terminal.rawModes.at(-1), true);
  resolveExport({
    kind: 'history_export',
    path: '/tmp/late-history-export.md',
    throughTurn: 1,
  });
  assertEquals(await run, 0);
  assertEquals(terminal.rawModes.at(-1), false);
  assert(
    !renderer.stateSnapshot().log.entries.some((entry) =>
      entry.text.includes('late-history-export.md')
    ),
  );
});

Deno.test('history export output failure waits for the already-started writer', async () => {
  const terminal = new FallibleInteractiveTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let resolveExport!: (result: PresentationIntentResult) => void;
  const intents: PresentationIntentDispatcher = {
    dispatch: (intent) => {
      if (intent.kind !== 'history_export') return { kind: 'accepted' };
      terminal.failNextWrite = true;
      return new Promise((resolve) => {
        resolveExport = resolve;
      });
    },
  };
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession([]),
    { pending: new PendingInputCore(), intents },
  );
  let settled = false;
  const run = controller.run().then(
    (code) => {
      settled = true;
      return { kind: 'code' as const, code };
    },
    (error: unknown) => {
      settled = true;
      return { kind: 'error' as const, error };
    },
  );
  terminal.push('/history export\r');
  await waitFor(() => controller.currentState === 'failed');
  assert(!settled);
  assertEquals(terminal.rawModes.at(-1), true);
  resolveExport({
    kind: 'history_export',
    path: '/tmp/output-failure-history-export.md',
    throughTurn: 1,
  });
  const result = await run;
  assertEquals(result.kind, 'error');
  assert(result.kind === 'error' && result.error instanceof TuiControllerError);
  assertEquals(result.error.code, 'output_failure');
  assertEquals(terminal.rawModes.at(-1), false);
});
