import { createUiState, reduceUiAction } from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { TuiEditor, TuiEditorHistory } from '../../v0/tui/input.ts';
import { layoutEditorText, pendingMetadataRows, TuiRenderer } from '../../v0/tui/render.ts';
import {
  TuiController,
  TuiControllerError,
  type TuiNavigationLike,
  type TuiSessionLike,
} from '../../v0/tui/controller.ts';
import {
  type PresentationIntentDispatcher,
  type PresentationIntentResult,
  type PresentationStartupState,
} from '../../v0/presentation/contract.ts';
import { presentationProjectionFromStartup } from '../../v0/presentation/adapter.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { ModelSelection } from '../../v0/agent/provider/model_selection.ts';
import {
  BLINK_SGR,
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  TerminalLifecycle,
  type TerminalPort,
} from '../../v0/tui/terminal.ts';
import { PendingInputCore, type PendingMetadataSnapshot } from '../../v0/tui/pending_input.ts';
import { startupHeaderLines } from '../../v0/tui/startup_render.ts';
import { projectRuntimeDisplayState } from '../../v0/agent/runtime/startup_orientation.ts';
import { WorkspacePathIndex } from '../../v0/tui/file_reference.ts';

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
  const renderer = new TuiRenderer(terminal);
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

Deno.test('retained working footer spins its primary status and shows cancel help', () => {
  const terminal = new RecordingTerminal();
  let now = 0;
  let tick = () => {};
  const cleared: unknown[] = [];
  const renderer = new TuiRenderer(terminal, {
    now: () => now,
    setInterval: (callback, milliseconds) => {
      assertEquals(milliseconds, 120);
      tick = callback;
      return 'busy-timer';
    },
    clearInterval: (id) => cleared.push(id),
  });

  renderer.eventSink({ kind: 'turn_start', turn: 1 });
  let layout = renderer.layoutSnapshot(80, 24);
  assertEquals(layout.footer[0].text, '[⠋ working 00:00 │ Esc cancel]');
  assert(!layout.footer[0].text.includes('\x1b'));
  assertEquals(layout.footer[0].blinkScalarStart, undefined);
  assertEquals(layout.footer[0].blinkScalarLength, undefined);
  assert(
    renderer.renderFrame(80, 24).includes('[⠋ working 00:00 │ Esc cancel]'),
  );
  assert(!renderer.renderFrame(80, 24).includes(BLINK_SGR));

  now = 62_000;
  tick();
  assertEquals(renderer.layoutSnapshot(80, 24).footer[0].text, '[⠙ working 01:02 │ Esc cancel]');

  renderer.setStatus('busy · steer applied');
  assert(
    renderer.renderFrame(80, 24).includes('[⠙ working 01:02 │ steer applied │ Esc cancel]'),
  );
  renderer.setSlashCommandCandidates(['/help', '/history export']);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[⠙ working 01:02 │ steer applied │ Esc cancel │ cmds: /help, /history export]',
  );
  assertEquals(
    renderer.layoutSnapshot(40, 24).footer[0].text,
    '[⠙ working 01:02 │ Esc cancel]',
  );
  renderer.setSlashCommandCandidates([]);
  renderer.setStatus('busy');
  renderer.setPendingMetadata({
    lanes: [{
      kind: 'active_task',
      lifecycle: 'active_uncommitted',
      present: true,
      byteCount: 44,
    }],
    recoveryCount: 0,
  });
  renderer.setSlashCommandCandidates(['/provider']);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[⠙ working 01:02 │ pending active_task:44B │ Esc cancel │ cmds: /provider]',
  );
  renderer.setSlashCommandCandidates([]);
  renderer.setPendingMetadata(undefined);
  renderer.setStatus('busy; /provider waits for ready');
  assert(
    renderer.renderFrame(80, 24).includes(
      '[⠙ working 01:02 │ /provider waits for ready │ Esc cancel]',
    ),
  );

  now = 3_661_000;
  tick();
  renderer.setStatus('cancelling context compaction');
  assert(
    renderer.renderFrame(80, 24).includes(
      '[⠹ cancelling 1:01:01 │ context compaction │ Esc cancel]',
    ),
  );
  layout = renderer.layoutSnapshot(12, 24);
  assertEquals(layout.footer[0].text, '[cancelling]');
  assertEquals(layout.footer[0].blinkScalarStart, undefined);
  assertEquals(layout.footer[0].blinkScalarLength, undefined);

  renderer.eventSink({ kind: 'turn_end', turn: 1, outcome: 'final', committed: true });
  assertEquals(cleared, ['busy-timer']);
  layout = renderer.layoutSnapshot(80, 24);
  assertEquals(layout.footer[0].text, '[ready]');
  assertEquals(layout.footer[0].blinkScalarStart, undefined);
  assertEquals(layout.footer[0].blinkScalarLength, undefined);
  assert(!renderer.renderFrame(80, 24).includes(BLINK_SGR));

  renderer.eventSink({ kind: 'turn_start', turn: 2 });
  renderer.eventSink({
    kind: 'turn_end',
    turn: 2,
    outcome: 'contract_failure',
    committed: false,
  });
  assertEquals(renderer.layoutSnapshot(80, 24).footer[0].text, '[contract_failure]');
  assert(!renderer.renderFrame(80, 24).includes(BLINK_SGR));

  renderer.eventSink({ kind: 'turn_start', turn: 3 });
  assertEquals(renderer.stateSnapshot().busyElapsedSeconds, 0);
  assertEquals(renderer.stateSnapshot().busySpinnerFrame, 0);
  renderer.close();
  assertEquals(renderer.stateSnapshot().busyElapsedSeconds, undefined);
  assertEquals(renderer.stateSnapshot().busySpinnerFrame, undefined);
  assertEquals(cleared, ['busy-timer', 'busy-timer', 'busy-timer']);
});

Deno.test('retained session picker identifies sessions by updated time and human title', () => {
  const renderer = new TuiRenderer(new RecordingTerminal());
  renderer.renderSessionPicker({
    sessions: [{
      id: 'fc419637-1a60-4b81-be4e-9ec1a5843039',
      agent: 'default',
      createdAt: '2026-09-10T08:00:00.000Z',
      updatedAt: '2026-09-10T08:39:06.612Z',
      title: 'Release notes',
      turnCount: 3,
      messageCount: 6,
      current: true,
      resumed: true,
      mismatch: false,
      modelSelection: {
        provider: 'openrouter-chat',
        modelId: 'deepseek/deepseek-v4-pro-0813',
        effort: 'high',
      },
    }, {
      id: '10761646-79a8-4a8d-8ae0-6aaee23af1b2',
      agent: 'default',
      createdAt: '2026-09-09T04:00:00.000Z',
      updatedAt: '2026-09-09T04:05:00.000Z',
      turnCount: 1,
      messageCount: 2,
      current: false,
      resumed: false,
      mismatch: false,
    }],
    skippedInvalid: 0,
  });
  const rows = renderer.layoutSnapshot(80, 24).overlay.map((row) => row.text);
  const expectedMinute = (iso: string): string => {
    const date = new Date(iso);
    const pad = (part: number): string => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${
      pad(date.getHours())
    }:${pad(date.getMinutes())}`;
  };
  assert(
    rows.includes(
      `> ${
        expectedMinute('2026-09-10T08:39:06.612Z')
      }  Release notes · fc419637 · 3 turns · current`,
    ),
  );
  assert(
    rows.includes(
      `  ${expectedMinute('2026-09-09T04:05:00.000Z')}  untitled · 10761646 · 1 turns · resumable`,
    ),
  );
  assert(!rows.some((row) => row.includes('Z')));
  assert(!rows.some((row) => row.includes('openrouter-chat') || row.includes('deepseek')));
});

Deno.test('retained controller completes a sole slash candidate and preserves path completion', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let credentialStatus: 'missing' | 'present' = 'missing';
  const session: TuiSessionLike = {
    submit: () => Promise.reject(new Error('not used')),
    modelSelectionSnapshot: () => ({
      provider: 'openai-responses',
      api: 'openai-responses',
      authProfile: 'openai-api-key',
      modelId: 'gpt-5.6',
      effort: 'medium',
    }),
    credentialAvailabilitySnapshot: () => ({
      authProfile: 'openai-api-key',
      status: credentialStatus,
    }),
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
    pathIndex: WorkspacePathIndex.fromCandidates(['docs/readme.md']),
  });
  const run = controller.run();
  await waitFor(() =>
    renderer.stateSnapshot().status.includes('credential missing: openai-responses')
  );
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[ready │ credential missing: openai-responses]',
  );

  terminal.push('/');
  await waitFor(() => renderer.stateSnapshot().slashCommandCandidates.length === 13);
  const allCommandsFooter = renderer.layoutSnapshot(80, 24).footer[0].text;
  assert(allCommandsFooter.includes('cmds:'));
  assert(allCommandsFooter.includes('/help'));
  terminal.push('h');
  await waitFor(() => renderer.stateSnapshot().slashCommandCandidates.length === 4);
  assertEquals(controller.editor.text, '/h');
  assertEquals(controller.editor.cursorScalar, 2);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[ready │ cmds: /help, /history, /histor… │ credential missing: openai-responses]',
  );
  assertEquals(
    renderer.layoutSnapshot(36, 24).footer[0].text,
    '[ready]',
  );
  renderer.setStatus(
    'session 12345678 · agent default · turn 9 · ready · context through 8 · retain 9+ · semantic ≤65536B · credential missing: openai-responses',
  );
  assertEquals(
    renderer.layoutSnapshot(36, 24).footer[0].text,
    '[ready]',
  );

  const writesBeforeAmbiguousTab = terminal.writes.length;
  terminal.push('\t');
  await waitFor(() => terminal.writes.length > writesBeforeAmbiguousTab);
  assertEquals(controller.editor.text, '/h');
  assertEquals(renderer.stateSnapshot().slashCommandCandidates.length, 4);

  terminal.push('\x15/n');
  await waitFor(() => renderer.stateSnapshot().slashCommandCandidates.length === 1);
  terminal.push('\t');
  await waitFor(() => controller.editor.text === '/new');
  assertEquals(controller.editor.cursorScalar, 4);

  terminal.push('\x15docs/r\t');
  await waitFor(() => controller.editor.text === '"./docs/readme.md"');
  assertEquals(controller.editor.cursorScalar, 18);

  terminal.push('\x15ordinary');
  await waitFor(() => controller.editor.text === 'ordinary');
  assertEquals(renderer.stateSnapshot().slashCommandCandidates, []);
  credentialStatus = 'present';
  terminal.push('\x03');
  await waitFor(() => renderer.stateSnapshot().status === 'ready');
  assertEquals(renderer.layoutSnapshot(80, 24).footer[0].text, '[ready]');
  terminal.push('\x04');
  assertEquals(await run, 0);
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

Deno.test('retained PageUp at the oldest boundary shows the startup header', () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal);
  const startup: PresentationStartupState = {
    productVersion: '0.1.2',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'deepseek/deepseek-v4-pro-0813',
      effort: 'high',
    },
    sessionMode: { kind: 'new' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  const startupPosition = {
    sessionId: 'fc419637-1a60-4b81-be4e-9ec1a5843039',
    createdAt: '2026-09-11T12:34:56.000Z',
    agent: 'default' as const,
    committedTurn: 0,
    messageCount: 0,
  };
  renderer.renderCompactStartup(startup, startupPosition);
  assertEquals(renderer.stateSnapshot().startup?.position, startupPosition);
  const wideHeader = renderer.layoutSnapshot(80, 24).allLog.map((row) => row.text);
  assertEquals(wideHeader.length, 9);
  assert(wideHeader[0].includes('Henji Harness v0.1.2'));
  assert(wideHeader.some((line) => line.includes('2026-09-11 12:34Z · untitled')));
  assert(wideHeader.some((line) => line.includes('new (autosave) · fc419637')));
  assert(wideHeader.some((line) => line.includes('runtime:')));
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
  for (let page = 0; page < 4; page += 1) renderer.scrollPage('up');
  const oldest = renderer.stateSnapshot().scroll;
  assertEquals(oldest, { kind: 'oldest' });
  assertEquals(renderer.layoutSnapshot(80, 10).logStart, 0);
  assert(
    renderer.layoutSnapshot(80, 10).log.some((row) => row.text.includes('Henji Harness')),
  );
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

Deno.test('startup header follows rename, session replacement, and terminal size', () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal);
  const startup: PresentationStartupState = {
    productVersion: '0.1.2',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'deepseek/deepseek-v4.1-flash',
      effort: 'high',
    },
    sessionMode: { kind: 'new' },
    instructions: { loaded: true, source: 'AGENTS.md' },
    skills: { count: 7, names: ['one', 'two', 'three', 'four', 'five'], omitted: 2 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  renderer.renderCompactStartup(startup, {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-11T01:02:03.000Z',
    agent: 'default',
    committedTurn: 0,
    messageCount: 0,
  });
  renderer.setSessionTitle('API research');
  assert(
    renderer.layoutSnapshot(80, 24).allLog.some((row) => row.text.includes('API research')),
  );

  renderer.eventSink({
    kind: 'session_binding_replaced',
    position: {
      sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      createdAt: '2026-09-10T04:05:06.000Z',
      title: 'Restored session',
      agent: 'default',
      committedTurn: 3,
      messageCount: 6,
    },
  });
  const switched = renderer.layoutSnapshot(80, 24).allLog.map((row) => row.text);
  assert(switched.some((line) => line.includes('Restored session')));
  assert(switched.some((line) => line.includes('exact session · bbbbbbbb')));

  terminal.size = { columns: 50, rows: 12 };
  renderer.resize(50, 12);
  const compact = renderer.layoutSnapshot(50, 12).allLog.map((row) => row.text);
  assertEquals(compact.length, 2);
  assert(compact[0].includes('Henji Harness v0.1.2'));
  assert(compact[1].includes('exact session · bbbbbbbb'));
  assert(compact[1].includes('henji-ui'));
});

Deno.test('startup header distinguishes continue, exact, and no-session modes', () => {
  const base: PresentationStartupState = {
    productVersion: '0.1.2',
    workspace: '/tmp/henji-ui',
    agentId: 'planner',
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'deepseek/deepseek-v4.1-flash',
      effort: 'high',
    },
    sessionMode: { kind: 'continue' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: [] },
    credentialVerification: 'before_each_provider_request',
  };
  const position = {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-11T01:02:03.000Z',
    agent: 'planner' as const,
    committedTurn: 4,
    messageCount: 8,
  };
  assert(startupHeaderLines(base, position).some((line) => line.includes('continue newest')));
  assert(
    startupHeaderLines({ ...base, sessionMode: { kind: 'exact' } }, position).some((line) =>
      line.includes('exact session')
    ),
  );
  const none = startupHeaderLines({ ...base, sessionMode: { kind: 'none' } }, position);
  assert(none.some((line) => line.includes('no session')));
  assert(!none.some((line) => line.includes('aaaaaaaa')));
});

Deno.test('startup header shows the selected Henji base instruction', () => {
  const base: PresentationStartupState = {
    productVersion: '0.1.3',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'deepseek/deepseek-v4.1-flash',
      effort: 'high',
    },
    sessionMode: { kind: 'new' },
    instructions: { loaded: false, source: 'none' },
    baseInstruction: {
      resourceId: 'local/henji-base',
      selectionSource: 'external',
      revisionDigest: '2e00f40b9d3160f6047eda0a3c7e3f325b3fcfc85766ad16d57549e27b70355f',
    },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  const position = {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-11T01:02:03.000Z',
    agent: 'default' as const,
    committedTurn: 0,
    messageCount: 0,
  };
  const full = startupHeaderLines(base, position, 100, 24);
  assert(full.some((line) => line.includes('local/henji-base · external · 2e00f40b')));
  assert(full.some((line) => /context:\s+none/.test(line)));
  const compact = startupHeaderLines(base, position, 40, 12);
  assert(!compact.some((line) => line.includes('base:')));
});

Deno.test('runtime display state carries a bounded base instruction only when resolved', () => {
  const selected = projectRuntimeDisplayState({
    productVersion: '0.1.3',
    workspaceRoot: '/tmp/henji-ui',
    agentId: 'default',
    profileId: 'test',
    sessionMode: 'new',
    baseInstruction: {
      resourceId: 'local/henji-base',
      selectionSource: 'external',
      revisionDigest: '2e00f40b9d3160f6047eda0a3c7e3f325b3fcfc85766ad16d57549e27b70355f',
    },
    skillNames: [],
  });
  assert(selected.baseInstruction?.resourceId === 'local/henji-base');
  assert(selected.baseInstruction?.selectionSource === 'external');
  const absent = projectRuntimeDisplayState({
    productVersion: '0.1.3',
    workspaceRoot: '/tmp/henji-ui',
    agentId: 'default',
    profileId: 'test',
    sessionMode: 'none',
    skillNames: [],
  });
  assert(absent.baseInstruction === undefined);
});

Deno.test('retained PageUp keeps latest when the conversation fits one page', () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal);
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
  const renderer = new TuiRenderer(terminal);
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

Deno.test('anchored slash remains ordinary editor input without history search', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal);
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
    { pending: new PendingInputCore() },
  );
  const run = controller.run();
  terminal.push('/ordinary');
  await waitFor(() => controller.editor.text === '/ordinary');
  assertEquals(renderer.stateSnapshot().overlay.kind, 'none');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');
  terminal.push('\x15\x04');
  assertEquals(await run, 0);
});

Deno.test('provider selection confirmation clears on the next editor input', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 100, rows: 12 };
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  renderer.resize(100, 12);

  let selection: ModelSelection = ROOT_DEFAULT_MODEL_SELECTION;
  const session: TuiSessionLike = {
    ...successfulSession([]),
    modelSelectionSnapshot: () => selection,
    selectModel: (next) => {
      selection = next;
      return Promise.resolve('selected' as const);
    },
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();

  terminal.push('/provider\r');
  await waitFor(() => renderer.stateSnapshot().overlay.kind === 'choicePicker');
  terminal.push('\x1b[B\x1b[B\r');
  await waitFor(() => selection.provider === 'openai-chat');
  await waitFor(() => renderer.stateSnapshot().status.includes('provider openai-chat'));
  assert(renderer.stateSnapshot().status.includes('model gpt-5.6-sol'));

  terminal.push('x');
  await waitFor(() => controller.editor.text === 'x');
  assert(!renderer.stateSnapshot().status.includes('provider openai-chat'));
  assertEquals(renderer.stateSnapshot().status, 'ready');

  terminal.push('\x15\x04');
  assertEquals(await run, 0);
});

Deno.test('retained controller returns to latest only after ordinary task admission', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal);
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
  terminal.push('accepted task');
  await waitFor(() => controller.editor.text === 'accepted task');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');
  terminal.push('\r');
  await waitFor(() => submitted.length === 1 && controller.currentState === 'idle');
  assertEquals(submitted, ['accepted task']);
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'followLatest' });
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('retained controller keeps the anchor when ordinary task admission fails', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal);
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
  const renderer = new TuiRenderer(terminal);
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
  const renderer = new TuiRenderer(terminal);
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

Deno.test('/recall selects next-task-only context while /recover remains input recovery', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  const intentsSeen: string[] = [];
  let clearCount = 0;
  const intents: PresentationIntentDispatcher = {
    dispatch: (intent) => {
      intentsSeen.push(intent.kind);
      if (intent.kind === 'recall_execution') {
        return {
          kind: 'recall',
          sourceExecutionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          evidence: 'available',
        };
      }
      if (intent.kind === 'clear_recall') {
        clearCount += 1;
        return { kind: 'accepted' };
      }
      if (intent.kind === 'ordinary_submit') {
        submitted.push(intent.text);
        return {
          kind: 'outcome',
          outcome: {
            ok: true,
            task: intent.text,
            outcome: 'final',
            stopReason: 'final',
            finalText: 'done',
            steps: 1,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          },
        };
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

  terminal.push('/recall aaaaaaaa\r');
  await waitFor(() =>
    controller.currentState === 'idle' &&
    renderer.stateSnapshot().status === 'recall aaaaaaaa ready · next task only'
  );
  assertEquals(controller.editor.text, '');
  terminal.push('what was completed?\r');
  await waitFor(() => submitted.length === 1 && controller.currentState === 'idle');
  assertEquals(submitted, ['what was completed?']);
  assert(!renderer.stateSnapshot().status.startsWith('recall '));

  terminal.push('/recover\r');
  await waitFor(() => renderer.stateSnapshot().status === 'no recoverable input');
  assertEquals(intentsSeen.filter((kind) => kind === 'recall_execution').length, 1);

  terminal.push('/recall aaaaaaaa\r');
  await waitFor(() => renderer.stateSnapshot().status.startsWith('recall aaaaaaaa ready'));
  terminal.push('draft');
  await waitFor(() => controller.editor.text === 'draft');
  terminal.push('\x03');
  await waitFor(() => controller.editor.text === '' && clearCount === 1);
  assert(!renderer.stateSnapshot().status.startsWith('recall '));

  terminal.push('/recall short\r');
  await waitFor(() => renderer.stateSnapshot().status.startsWith('invalid recall id'));
  assertEquals(controller.editor.text, '/recall short');
  terminal.push('\x03\x04');
  assertEquals(await run, 0);
});

Deno.test('/recall is unavailable with --no-session and keeps the command in the editor', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession([]),
    { pending: new PendingInputCore() },
  );
  const run = controller.run();
  terminal.push('/recall\r');
  await waitFor(() => renderer.stateSnapshot().status === 'recall unavailable with --no-session');
  assertEquals(controller.editor.text, '/recall');
  terminal.push('\x03\x04');
  assertEquals(await run, 0);
});

Deno.test('genuine cancellation cleanup failure does not return to reusable ready', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let available = true;
  let submitted = false;
  const session: TuiSessionLike = {
    submit: () => Promise.reject(new Error('intent owns submission')),
    isAvailable: () => available,
  };
  const intents: PresentationIntentDispatcher = {
    dispatch: (intent) => {
      if (intent.kind !== 'ordinary_submit') return { kind: 'accepted' };
      submitted = true;
      available = false;
      return {
        kind: 'outcome',
        outcome: {
          ok: false,
          task: intent.text,
          outcome: 'contract_failure',
          stopReason: 'contract_failure',
          error: 'cancellation cleanup failed',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
          diagnostic: {
            schemaVersion: 1,
            diagnosticId: '39393939-3939-4939-8939-393939393939',
            stage: 'cancellation_cleanup',
            code: 'cleanup_error',
            lane: 'parent',
            providerRequestCount: 1,
            occurredAt: '2026-09-12T00:00:00.000Z',
            turnNumber: 1,
            modelStep: 0,
            retryCount: 0,
          },
        },
      };
    },
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
    intents,
  });
  const run = controller.run().then(
    (code) => ({ kind: 'code' as const, code }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  terminal.push('trigger cleanup failure\r');
  await waitFor(() =>
    submitted && (controller.currentState === 'idle' || controller.currentState === 'failed')
  );
  const returnedReady = controller.currentState === 'idle';
  if (returnedReady) terminal.push('\x03\x04');
  const result = await run;
  assert(!returnedReady);
  assert(result.kind === 'error' && result.error instanceof TuiControllerError);
  assertEquals(result.error.code, 'agent_failure');
});

Deno.test('busy /recall stays in the editor and is not dispatched as steering', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let settle: (() => void) | undefined;
  const steering: string[] = [];
  const session: TuiSessionLike = {
    submit: (task) =>
      new Promise((resolve) => {
        settle = () =>
          resolve({
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
      }),
    steerActiveTurn: (text) => {
      steering.push(text);
      return 'accepted';
    },
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  terminal.push('active task\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('/recall aaaaaaaa\r');
  await waitFor(() => renderer.stateSnapshot().status === 'busy; /recall waits for ready');
  assertEquals(controller.editor.text, '/recall aaaaaaaa');
  assertEquals(steering, []);
  settle?.();
  await waitFor(() => controller.currentState === 'idle');
  terminal.push('\x03\x04');
  assertEquals(await run, 0);
});

Deno.test('busy /provider waits for idle instead of steering the active turn', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let settle: (() => void) | undefined;
  const steering: string[] = [];
  const session: TuiSessionLike = {
    submit: (task) =>
      new Promise((resolve) => {
        settle = () =>
          resolve({
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
      }),
    steerActiveTurn: (text) => {
      steering.push(text);
      return 'accepted';
    },
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  terminal.push('active task\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('/provider\r');
  await waitFor(() => renderer.stateSnapshot().status === 'busy; /provider waits for ready');
  assertEquals(steering, []);
  assertEquals(controller.editor.text, '/provider');
  assertEquals(renderer.stateSnapshot().slashCommandCandidates, ['/provider']);
  settle?.();
  await waitFor(() => controller.currentState === 'idle');
  terminal.push('\x15\x04');
  assertEquals(await run, 0);
});

Deno.test('busy /rename waits for idle and then renames without model submission', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let settle: (() => void) | undefined;
  const steering: string[] = [];
  const renamed: string[] = [];
  const session: TuiSessionLike = {
    submit: (task) =>
      new Promise((resolve) => {
        settle = () =>
          resolve({
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
      }),
    steerActiveTurn: (text) => {
      steering.push(text);
      return 'accepted';
    },
  };
  const navigation: TuiNavigationLike = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [], skippedInvalid: 0 }),
    renameCurrent: (title) => {
      if (title.length === 0) return 'unchanged';
      renamed.push(title);
      return 'renamed';
    },
    switchTo: () => Promise.reject(new Error('not used')),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => ({
      sessionId: 'fc419637-1a60-4b81-be4e-9ec1a5843039',
      createdAt: '2026-09-11T00:00:00.000Z',
      agent: 'default',
      committedTurn: 0,
      messageCount: 0,
    }),
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
    navigation,
  });
  const run = controller.run();
  terminal.push('active task\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('/rename Release notes\r');
  await waitFor(() => renderer.stateSnapshot().status === 'busy; /rename waits for ready');
  assertEquals(steering, []);
  assertEquals(renamed, []);
  assertEquals(controller.editor.text, '/rename Release notes');

  settle?.();
  await waitFor(() => controller.currentState === 'idle');
  terminal.push('\r');
  await waitFor(() => renderer.stateSnapshot().status === 'session renamed');
  assertEquals(renamed, ['Release notes']);

  terminal.push('/rename\r');
  await waitFor(() => renderer.stateSnapshot().status === 'session title unchanged');
  assertEquals(renamed, ['Release notes']);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('/rename is unavailable when Session persistence is disabled', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession(submitted),
    { pending: new PendingInputCore() },
  );
  const run = controller.run();
  terminal.push('/rename\r');
  await waitFor(() => renderer.stateSnapshot().status === 'session rename unavailable');
  assertEquals(submitted, []);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('busy /new waits for ready then replaces the retained Session without submission', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let settle: (() => void) | undefined;
  const submitted: string[] = [];
  const steering: string[] = [];
  const inherited = defaultModelSelectionFor('openai-responses');
  const oldSession: TuiSessionLike = {
    submit: (task) => {
      submitted.push(task);
      return new Promise((resolve) => {
        settle = () =>
          resolve({
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
      });
    },
    steerActiveTurn: (text) => {
      steering.push(text);
      return 'accepted';
    },
  };
  const newSession: TuiSessionLike = {
    ...successfulSession(submitted),
    modelSelectionSnapshot: () => inherited,
  };
  const oldPosition = {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-12T00:00:00.000Z',
    agent: 'default' as const,
    committedTurn: 1,
    messageCount: 2,
  };
  const newPosition = {
    sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    createdAt: '2026-09-12T00:01:00.000Z',
    agent: 'default' as const,
    committedTurn: 0,
    messageCount: 0,
  };
  let currentPosition = oldPosition;
  let createCount = 0;
  const navigation: TuiNavigationLike = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [], skippedInvalid: 0 }),
    createNew: () => {
      createCount += 1;
      currentPosition = newPosition;
      return Promise.resolve({
        session: newSession,
        position: newPosition,
        restored: { messages: [], omitted: 0 },
      });
    },
    switchTo: () => Promise.reject(new Error('not used')),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => currentPosition,
  };
  const startup: PresentationStartupState = {
    productVersion: '0.1.2',
    workspace: '/tmp/henji-new-session',
    agentId: 'default',
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'z-ai/glm-5.3-flash',
      effort: 'low',
    },
    sessionMode: { kind: 'new' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: [] },
    credentialVerification: 'before_each_provider_request',
  };
  renderer.renderCompactStartup(startup, oldPosition);
  renderer.setProjection(
    presentationProjectionFromStartup(startup, oldPosition, {
      canNavigate: true,
      canHistory: true,
      canCompact: false,
    }),
  );
  renderer.eventSink({
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'old conversation' } },
  });
  const controller = new TuiController(lifecycle, renderer, oldSession, {
    pending: new PendingInputCore(),
    navigation,
  });
  const run = controller.run();

  terminal.push('active task\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('/new\r');
  await waitFor(() => renderer.stateSnapshot().status === 'busy; /new waits for ready');
  assertEquals(controller.editor.text, '/new');
  assertEquals(steering, []);
  assertEquals(createCount, 0);

  settle?.();
  await waitFor(() => controller.currentState === 'idle');
  terminal.push('\r');
  await waitFor(() => renderer.stateSnapshot().status === 'new session ready');
  assertEquals(createCount, 1);
  assertEquals(submitted, ['active task']);
  assertEquals(controller.editor.text, '');
  assertEquals(renderer.stateSnapshot().log.entries, []);
  assertEquals(renderer.stateSnapshot().startup?.position, newPosition);
  assertEquals(renderer.stateSnapshot().projection?.sessionId, newPosition.sessionId);
  assertEquals(renderer.stateSnapshot().projection?.committedTurn, 0);
  assertEquals(renderer.stateSnapshot().projection?.model, {
    provider: inherited.provider,
    modelId: inherited.modelId,
    effort: inherited.effort,
  });

  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('/new is unavailable without persistent Session navigation', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession(submitted),
    { pending: new PendingInputCore() },
  );
  const run = controller.run();
  terminal.push('/new\r');
  await waitFor(() => renderer.stateSnapshot().status === 'new session unavailable');
  assertEquals(submitted, []);
  assertEquals(controller.editor.text, '');
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('/new setup failure keeps the current retained Session', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  const position = {
    sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: '2026-09-12T00:00:00.000Z',
    agent: 'default' as const,
    committedTurn: 1,
    messageCount: 2,
  };
  const navigation: TuiNavigationLike = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [], skippedInvalid: 0 }),
    createNew: () => Promise.reject(new Error('target setup failed')),
    switchTo: () => Promise.reject(new Error('not used')),
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => position,
  };
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession(submitted),
    { pending: new PendingInputCore(), navigation },
  );
  const run = controller.run();
  terminal.push('/new\r');
  await waitFor(() =>
    renderer.stateSnapshot().status === 'new session failed; current session unchanged'
  );
  assertEquals(navigation.currentPosition(), position);
  assertEquals(submitted, []);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('idle Ctrl-C clears input without arming or triggering exit', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
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
  const renderer = new TuiRenderer(terminal);
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

Deno.test('human history viewer owns navigation, detail, search, and restores conversation scroll', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const submitted: string[] = [];
  const page = {
    schemaVersion: 1 as const,
    sessionId: '43000000-0000-4000-8000-000000000001',
    entries: [
      {
        id: 'execution:43000000-0000-4000-8002-000000000001',
        executionId: '43000000-0000-4000-8002-000000000001',
        turn: 1,
        attempt: 1,
        kind: 'execution' as const,
        label: 'turn 1 · attempt 1',
        text: 'cancelled non_canonical',
        detailId: 'execution:43000000-0000-4000-8002-000000000001',
      },
      {
        id: 'task:43000000-0000-4000-8002-000000000001',
        executionId: '43000000-0000-4000-8002-000000000001',
        turn: 1,
        attempt: 1,
        kind: 'task' as const,
        label: 'task>',
        text: 'literal nonce',
        detailId: 'task:43000000-0000-4000-8002-000000000001',
      },
    ],
    executionCount: 1,
    atOldest: true,
    atNewest: true,
  };
  const intents: PresentationIntentDispatcher = {
    dispatch(intent): PresentationIntentResult {
      if (intent.kind === 'human_history_open' || intent.kind === 'human_history_page') {
        return { kind: 'human_history_page', page };
      }
      if (intent.kind === 'human_history_detail') {
        return {
          kind: 'human_history_detail',
          detail: {
            schemaVersion: 1,
            sessionId: page.sessionId,
            detailId: intent.detailId,
            title: 'task',
            text: 'literal nonce exact detail',
            scalarOffset: 0,
            scalarLength: 26,
            totalScalars: 26,
          },
        };
      }
      if (intent.kind === 'human_history_search') {
        return {
          kind: 'human_history_search',
          hit: {
            query: intent.query,
            entryId: page.entries[1].id,
            detailId: page.entries[1].detailId,
            sourceScalarOffset: 8,
            detail: {
              schemaVersion: 1,
              sessionId: page.sessionId,
              detailId: page.entries[1].detailId,
              title: 'task',
              text: 'literal nonce exact detail',
              scalarOffset: 0,
              scalarLength: 26,
              totalScalars: 26,
            },
            detailMatchScalarOffset: 8,
            wrapped: true,
            page,
          },
        };
      }
      return { kind: 'rejected', reason: 'unavailable' };
    },
  };
  renderer.eventSink({
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'retained row' } },
  });
  renderer.scrollPage('up');
  const scroll = renderer.stateSnapshot().scroll;
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession(submitted),
    { pending: new PendingInputCore(), intents },
  );
  const run = controller.run();
  terminal.push('/history\r');
  await waitFor(() => renderer.stateSnapshot().overlay.kind === 'humanHistory');
  assert(!renderer.renderFrame(80, 24).includes('> /history'));
  terminal.push('k\r');
  await waitFor(() => {
    const overlay = renderer.stateSnapshot().overlay;
    return overlay.kind === 'humanHistory' && overlay.detail !== undefined;
  });
  assert(renderer.renderFrame(80, 24).includes('literal nonce exact detail'));
  terminal.push('\x1b');
  await waitFor(() => {
    const overlay = renderer.stateSnapshot().overlay;
    return overlay.kind === 'humanHistory' && overlay.detail === undefined;
  });
  terminal.push('/nonce\r');
  await waitFor(() => {
    const overlay = renderer.stateSnapshot().overlay;
    return overlay.kind === 'humanHistory' && overlay.query === 'nonce' &&
      overlay.detail !== undefined;
  });
  assert(renderer.renderFrame(80, 24).includes(BLINK_SGR));
  terminal.push('\x1b');
  await waitFor(() => {
    const overlay = renderer.stateSnapshot().overlay;
    return overlay.kind === 'humanHistory' && overlay.detail === undefined;
  });
  terminal.push('q');
  await waitFor(() => renderer.stateSnapshot().overlay.kind === 'none');
  assertEquals(renderer.stateSnapshot().scroll, scroll);
  assertEquals(submitted, []);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('human history keeps one wrapped document while loading adjacent storage batches', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const sessionId = '43000000-0000-4000-8000-000000000009';
  const newest = {
    schemaVersion: 1 as const,
    sessionId,
    entries: [{
      id: 'task:43000000-0000-4000-8002-000000000009',
      executionId: '43000000-0000-4000-8002-000000000009',
      turn: 2,
      attempt: 1,
      kind: 'task' as const,
      label: 'task>',
      text: 'newest '.repeat(700),
      detailId: 'task:43000000-0000-4000-8002-000000000009',
    }],
    executionCount: 1,
    olderCursor: 'older-cursor',
    atOldest: false,
    atNewest: true,
  };
  const oldest = {
    schemaVersion: 1 as const,
    sessionId,
    entries: [{
      id: 'task:43000000-0000-4000-8002-000000000008',
      executionId: '43000000-0000-4000-8002-000000000008',
      turn: 1,
      attempt: 1,
      kind: 'task' as const,
      label: 'task>',
      text: 'oldest row',
      detailId: 'task:43000000-0000-4000-8002-000000000008',
    }],
    executionCount: 1,
    newerCursor: 'newer-cursor',
    atOldest: true,
    atNewest: false,
  };
  let olderReads = 0;
  const intents: PresentationIntentDispatcher = {
    dispatch(intent): PresentationIntentResult {
      if (intent.kind === 'human_history_open') {
        return { kind: 'human_history_page', page: newest };
      }
      if (intent.kind === 'human_history_page' && intent.direction === 'older') {
        olderReads += 1;
        return { kind: 'human_history_page', page: oldest };
      }
      return { kind: 'rejected', reason: 'unavailable' };
    },
  };
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession([]),
    { pending: new PendingInputCore(), intents },
  );
  const run = controller.run();
  terminal.push('/history\r');
  await waitFor(() => renderer.stateSnapshot().overlay.kind === 'humanHistory');
  terminal.push('\x1b[5~');
  await waitFor(() => {
    const overlay = renderer.stateSnapshot().overlay;
    return overlay.kind === 'humanHistory' &&
      overlay.anchorEntryId === newest.entries[0].id &&
      (overlay.anchorScalarOffset ?? Number.MAX_SAFE_INTEGER) < Number.MAX_SAFE_INTEGER;
  });
  assertEquals(olderReads, 0);
  terminal.push('k');
  await waitFor(() => olderReads === 1);
  await waitFor(() => {
    const overlay = renderer.stateSnapshot().overlay;
    return overlay.kind === 'humanHistory' && overlay.page?.entries.length === 2;
  });
  const overlay = renderer.stateSnapshot().overlay;
  if (overlay.kind !== 'humanHistory' || overlay.page === undefined) {
    throw new Error('history viewer missing');
  }
  assertEquals(overlay.page.entries.map((entry) => entry.id), [
    oldest.entries[0].id,
    newest.entries[0].id,
  ]);
  assertEquals(overlay.page.entries[overlay.selected].id, oldest.entries[0].id);
  terminal.push('q');
  await waitFor(() => renderer.stateSnapshot().overlay.kind === 'none');
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('history export shutdown waits for settlement and emits no late receipt', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
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
  const renderer = new TuiRenderer(terminal);
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
