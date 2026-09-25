import { createUiState, reduceUiAction, reduceUiEvent } from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { TuiEditor, TuiEditorHistory } from '../../v0/tui/input.ts';
import { TuiRenderer } from '../../v0/tui/render.ts';
import {
  TuiController,
  TuiControllerError,
  type TuiNavigationLike,
  type TuiSessionLike,
} from '../../v0/tui/controller.ts';
import {
  type PresentationIntentDispatcher,
  type PresentationStartupState,
} from '../../v0/presentation/contract.ts';
import { presentationProjectionFromStartup } from '../../v0/presentation/adapter.ts';
import { createTuiPresentationAdapter } from '../../v0/presentation/adapter.ts';
import type { LoopOutcome } from '../../v0/agent/core/contracts.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import type { ModelSelection } from '../../v0/agent/provider/model_selection.ts';
import {
  BLINK_SGR,
  BRACKETED_PASTE_OFF,
  CoalescingWriter,
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  TerminalLifecycle,
  type TerminalPort,
} from '../../v0/tui/terminal.ts';
import { PendingInputCore, type PendingMetadataSnapshot } from '../../v0/tui/pending_input.ts';
import { startupHeaderLines } from '../../v0/tui/startup_render.ts';
import { projectRuntimeDisplayState } from '../../v0/agent/runtime/startup_orientation.ts';
import { WorkspacePathIndex } from '../../v0/tui/file_reference.ts';
import {
  failureRecallGuidance,
  failureRecallGuidanceFor,
} from '../../v0/tui/conversation_renderer.ts';

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

class RecoveringOutputTerminal extends InteractiveTerminal {
  private readonly outputHandlers = new Set<() => void>();
  private outputFailed = false;
  private rejectFrame = true;
  private readonly output = new CoalescingWriter((bytes) => {
    const value = new TextDecoder().decode(bytes);
    if (this.rejectFrame && value.startsWith('\x1b[2J\x1b[H')) {
      this.rejectFrame = false;
      throw new Error('frame write failed');
    }
    this.writes.push(value);
    return Promise.resolve();
  }, () => {
    this.outputFailed = true;
    for (const handler of this.outputHandlers) handler();
  });

  override write(bytes: Uint8Array): void {
    this.output.enqueue(bytes);
  }

  flush(): Promise<void> {
    return this.output.flush();
  }

  subscribeOutputFailure(handler: () => void): () => void {
    this.outputHandlers.add(handler);
    if (this.outputFailed) handler();
    return () => this.outputHandlers.delete(handler);
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

Deno.test('retained controller restores terminal after an asynchronous frame write fails', async () => {
  const terminal = new RecoveringOutputTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const controller = new TuiController(lifecycle, renderer, successfulSession([]));
  assertEquals(await controller.run(), 1);
  assertEquals(lifecycle.restoreStatus(), 'failed');
  assertEquals(terminal.rawModes.at(-1), false);
  assert(indexOfWrite(terminal.writes, BRACKETED_PASTE_OFF) >= 0);
  assert(indexOfWrite(terminal.writes, EXIT_ALTERNATE_SCREEN) >= 0);
  assertEquals(terminal.writes.at(-1), '\x1b[?25h');
});

Deno.test('retained editor keeps a new arrow and history Up after bare Escape', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  const controller = new TuiController(lifecycle, renderer, successfulSession(submitted), {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  terminal.push('ab');
  await waitFor(() => controller.editor.text === 'ab');
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 80));
  terminal.push('c\x1b[DX');
  await waitFor(() => controller.editor.text === 'abXc');
  terminal.push('\r');
  await waitFor(() => submitted.length === 1);
  terminal.push('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 80));
  terminal.push('\x1b[A');
  await waitFor(() => controller.editor.text === 'abXc');
  terminal.push('\x15\x04');
  assertEquals(await run, 0);
});

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
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[⠙ working 01:02 │ Esc cancel]',
  );

  renderer.setStatus('busy · steer applied');
  assert(
    renderer.renderFrame(80, 24).includes(
      '[⠙ working 01:02 │ steer applied │ Esc cancel]',
    ),
  );
  renderer.setSlashCommandCandidates(['/help', '/recall']);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[⠙ working 01:02 │ steer applied │ Esc cancel │ cmds: /help, /recall]',
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

  renderer.eventSink({
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
  });
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
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[contract_failure]',
  );
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
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${
      pad(date.getHours())
    }:${pad(date.getMinutes())}`;
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
    return zone === undefined || zone.length === 0 ? stamp : `${stamp} ${zone}`;
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
  assert(
    !rows.some((row) => row.includes('openrouter-chat') || row.includes('deepseek')),
  );
});

Deno.test('compact session picker keeps its selected session visible with the full footer', () => {
  const terminal = new RecordingTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal);
  const startup: PresentationStartupState = {
    productVersion: '0.3.0',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: { provider: 'openrouter-chat', profileId: 'test', modelId: 'm', effort: 'high' },
    sessionMode: { kind: 'new' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: [] },
    credentialVerification: 'before_each_provider_request',
  };
  const position = {
    sessionId: '00000000-0000-0000-0000-000000000000',
    createdAt: '2026-09-22T00:00:00Z',
    agent: 'default' as const,
    committedTurn: 0,
    messageCount: 0,
  };
  renderer.resize(80, 10);
  renderer.renderCompactStartup(startup, position);
  renderer.setProjection(presentationProjectionFromStartup(startup, position, {
    canNavigate: true,
    canCompact: false,
  }));
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    id: `0000000${index}-0000-0000-0000-000000000000`,
    agent: 'default' as const,
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
    title: `Saved session ${index}`,
    turnCount: 1,
    messageCount: 2,
    current: index === 0,
    resumed: false,
    mismatch: false,
  }));
  for (const selected of [0, 3, 7]) {
    renderer.renderSessionPicker({ sessions, skippedInvalid: 0 }, selected);
    const layout = renderer.layoutSnapshot(80, 10);
    assertEquals(layout.footer.length, 3);
    assert(layout.log.some((row) => row.text.includes('session picker')));
    const selectedRows = layout.log.filter((row) => row.text.startsWith('> '));
    assertEquals(selectedRows.length, 1);
    assert(selectedRows[0].text.includes(`Saved session ${selected}`));
    assert(selectedRows[0].text.includes(sessions[selected].id.slice(0, 8)));
  }
  renderer.resize(80, 24);
  renderer.renderSessionPicker({ sessions, skippedInvalid: 0 }, 0);
  const standard = renderer.layoutSnapshot(80, 24);
  assert(standard.log.some((row) => row.text.includes('Saved session 0')));
  assert(standard.log.some((row) => row.text.includes('Saved session 7')));
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
    renderer.stateSnapshot().status.includes(
      'credential missing: openai-responses',
    )
  );
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[ready │ credential missing: openai-responses]',
  );

  terminal.push('/');
  await waitFor(() => renderer.stateSnapshot().slashCommandCandidates.length === 9);
  const allCommandsFooter = renderer.layoutSnapshot(80, 24).footer[0].text;
  assert(allCommandsFooter.includes('cmds:'));
  assert(allCommandsFooter.includes('/help'));
  terminal.push('r');
  await waitFor(() => renderer.stateSnapshot().slashCommandCandidates.length === 2);
  assertEquals(controller.editor.text, '/r');
  assertEquals(controller.editor.cursorScalar, 2);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    '[ready │ cmds: /rename, /recall │ credential missing: openai-responses]',
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
  assertEquals(controller.editor.text, '/r');
  assertEquals(renderer.stateSnapshot().slashCommandCandidates.length, 2);

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

Deno.test('workspace path completion remains available beyond 1,024 files', () => {
  const paths = Array.from(
    { length: 1_200 },
    (_, index) => `docs/file-${index.toString().padStart(4, '0')}.md`,
  );
  const index = WorkspacePathIndex.fromCandidates(paths);
  assert(index.complete);
  assertEquals(index.completePath('docs/file-1199'), {
    kind: 'inserted',
    text: '"./docs/file-1199.md"',
    replacement: '"./docs/file-1199.md"',
  });
});

Deno.test('retained footer omits editor bytes while keeping pending lanes', () => {
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
    ],
  };
  const withPending = reduceUiAction(createUiState(), {
    kind: 'pending',
    snapshot: pending,
  });
  const footer = layoutUi(withPending, 160, 24).footer[0].text;
  assert(!footer.includes('editor:30B'));
  assert(footer.includes('active_task:4B'));

  const editorOnly = reduceUiAction(createUiState(), {
    kind: 'pending',
    snapshot: {
      lanes: [{
        kind: 'editor',
        lifecycle: 'draft',
        present: true,
        byteCount: 30,
      }],
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
  assertEquals(layout.input[0]?.text, pasted);
  assertEquals(layout.cursor.cell, 18); // prompt (2) + 16 display cells

  assert(editor.backspace());
  assertEquals(editor.text, '直近５コミット');
  assert(editor.insert('x'));
  snapshot = editor.snapshot();
  layout = layoutUi(createUiState(snapshot), 80, 24);
  assertEquals(editor.text, '直近５コミットx');
  assertEquals(layout.cursor.cell, 17); // prompt (2) + 15 display cells

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
  const expectedCreated = (() => {
    const date = new Date('2026-09-11T12:34:56.000Z');
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  })();
  assert(wideHeader[0].includes('Henji Harness v0.1.2'));
  assert(wideHeader.some((line) => line.includes(expectedCreated)));
  assert(wideHeader.some((line) => line.includes('· untitled')));
  assert(!wideHeader.some((line) => line.includes('12:34Z')));
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
    renderer.layoutSnapshot(80, 10).footer[0].text.includes('history start'),
  );
  assert(renderer.layoutSnapshot(80, 10).footer[0].text.includes('Esc latest'));

  renderer.setStatus(
    `unknown command /${'x'.repeat(100)}, try: /help, /sessions, /exit`,
  );
  assert(
    renderer.layoutSnapshot(80, 10).footer[0].text.startsWith('[history start'),
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

Deno.test('PageUp reaches a short oldest history window without returning to latest', () => {
  const terminal = new RecordingTerminal();
  terminal.size = { columns: 94, rows: 48 };
  const renderer = new TuiRenderer(terminal);
  renderer.resize(94, 48);
  renderer.renderCompactStartup({
    productVersion: '0.6.0',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: { provider: 'openrouter-chat', profileId: 'test', modelId: 'm', effort: 'high' },
    sessionMode: { kind: 'continue' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash'] },
    credentialVerification: 'before_each_provider_request',
  }, {
    sessionId: 'fc419637-1a60-4b81-be4e-9ec1a5843039',
    createdAt: '2026-09-25T12:00:00.000Z',
    agent: 'default',
    committedTurn: 30,
    messageCount: 60,
  });
  const messages = Array.from({ length: 30 }, (_, index) => [
    { role: 'user' as const, content: { kind: 'text' as const, text: `question ${index}` } },
    {
      role: 'assistant' as const,
      content: {
        kind: 'text' as const,
        text: index < 6 ? `answer ${index}` : `answer ${index}: ${'detail '.repeat(35)}`,
      },
    },
  ]).flat();
  renderer.renderRestored(messages, 0);
  assert((renderer.stateSnapshot().historyWindow?.start ?? 0) > 0);

  let previousEntry = renderer.stateSnapshot().log.entries.length;
  for (let page = 0; page < 80; page += 1) {
    renderer.scrollPage('up');
    const footer = renderer.layoutSnapshot().footer[0].text;
    const position = footer.match(
      /history record (\d+) of (\d+) · record line (\d+) of (\d+)/,
    );
    if (position !== null) {
      assertEquals(Number(position[2]), messages.length);
      assert(Number(position[1]) <= previousEntry, 'PageUp moved toward newer entries');
      previousEntry = Number(position[1]);
    }
    const state = renderer.stateSnapshot();
    if (state.historyWindow?.start === 0 && state.scroll.kind === 'oldest') break;
  }
  const oldest = renderer.layoutSnapshot();
  assertEquals(renderer.stateSnapshot().historyWindow?.start, 0);
  assertEquals(renderer.stateSnapshot().scroll.kind, 'oldest');
  assert(oldest.allLog.length < oldest.log.length, 'the oldest window should fit one viewport');
  assert(oldest.log.some((row) => row.text.includes('Henji Harness')));
  assert(oldest.footer[0].text.includes('history start'));
  renderer.scrollPage('up');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'oldest');
  assert(renderer.layoutSnapshot().footer[0].text.includes('history start'));

  for (let page = 0; page < 80; page += 1) {
    if (renderer.stateSnapshot().scroll.kind === 'followLatest') break;
    renderer.scrollPage('down');
  }
  assertEquals(renderer.stateSnapshot().scroll.kind, 'followLatest');
  assertEquals(renderer.stateSnapshot().historyWindow?.end, messages.length);
});

Deno.test('retained PageDown advances through a large assistant entry after oldest', () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.resize(80, 10);
  const body = Array.from({ length: 200 }, (_, index) => `- item ${index}`).join('\n');
  renderer.eventSink({
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: body } },
  });
  const assistantRows = renderer.layoutSnapshot(80, 10).allLog.filter((row) =>
    row.entryId !== undefined
  );
  assert(assistantRows.length > 2, 'assistant entry did not span multiple rows');
  for (let index = 1; index < assistantRows.length; index += 1) {
    assert(
      (assistantRows[index].sourceScalarOffset ?? 0) >
        (assistantRows[index - 1].sourceScalarOffset ?? 0),
      'assistant rows reuse the same source scalar offset',
    );
  }
  for (let page = 0; page < 100; page += 1) {
    if (renderer.stateSnapshot().scroll.kind === 'oldest') break;
    renderer.scrollPage('up');
  }
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'oldest' });
  const starts: number[] = [];
  for (let page = 0; page < 100; page += 1) {
    renderer.scrollPage('down');
    if (renderer.stateSnapshot().scroll.kind === 'followLatest') break;
    starts.push(renderer.layoutSnapshot(80, 10).logStart);
  }
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'followLatest' });
  assert(starts.length > 1, 'PageDown stopped inside the assistant entry');
  for (let index = 1; index < starts.length; index += 1) {
    assert(starts[index] > starts[index - 1], 'PageDown did not advance monotonically');
  }
});

Deno.test('retained assistant viewport stays on the same list item after resize', () => {
  const terminal = new RecordingTerminal();
  terminal.size = { columns: 80, rows: 24 };
  const renderer = new TuiRenderer(terminal);
  renderer.resize(80, 24);
  const body = Array.from(
    { length: 300 },
    (_, index) => `- item-${index} ${'long explanation '.repeat(8)}`,
  ).join('\n');
  renderer.eventSink({
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: body } },
  });
  for (let page = 0; page < 20; page += 1) {
    renderer.scrollPage('up');
    if (/item-\d+/.test(renderer.layoutSnapshot(80, 24).log[0].text)) break;
  }
  const before = renderer.layoutSnapshot(80, 24).log[0];
  assert(before.sourceLine !== undefined);
  const item = before.text.match(/item-\d+/)?.[0];
  assert(item !== undefined);
  terminal.size = { columns: 160, rows: 24 };
  renderer.resize(160, 24);
  const after = renderer.layoutSnapshot(160, 24).log;
  assertEquals(after[0].sourceLine, before.sourceLine);
  assert(after[0].text.includes(item));
});

Deno.test('table and paragraph history still page through after resize', () => {
  const bodies = [
    [
      '| Name | Detail |',
      '| --- | --- |',
      ...Array.from({ length: 90 }, (_, index) => `| record-${index} | ${'detail '.repeat(8)} |`),
    ].join('\n'),
    Array.from({ length: 90 }, (_, index) => `paragraph-${index} ${'word '.repeat(25)}`).join('\n'),
  ];
  for (const body of bodies) {
    const terminal = new RecordingTerminal();
    terminal.size = { columns: 80, rows: 10 };
    const renderer = new TuiRenderer(terminal);
    renderer.resize(80, 10);
    renderer.eventSink({
      kind: 'assistant_message',
      turn: 1,
      message: { role: 'assistant', content: { kind: 'text', text: body } },
    });
    for (let page = 0; page < 3; page += 1) renderer.scrollPage('up');
    terminal.size = { columns: 120, rows: 10 };
    renderer.resize(120, 10);
    for (let page = 0; page < 200; page += 1) {
      if (renderer.stateSnapshot().scroll.kind === 'oldest') break;
      renderer.scrollPage('up');
    }
    assertEquals(renderer.stateSnapshot().scroll.kind, 'oldest');
    let lastStart = -1;
    for (let page = 0; page < 200; page += 1) {
      renderer.scrollPage('down');
      if (renderer.stateSnapshot().scroll.kind === 'followLatest') break;
      const start = renderer.layoutSnapshot(120, 10).logStart;
      assert(start > lastStart);
      lastStart = start;
    }
    assertEquals(renderer.stateSnapshot().scroll.kind, 'followLatest');
  }
});

Deno.test('retained PageUp reaches oldest across the startup header', () => {
  const terminal = new RecordingTerminal();
  terminal.size = { columns: 100, rows: 45 };
  const renderer = new TuiRenderer(terminal);
  renderer.resize(100, 45);
  renderer.renderCompactStartup({
    productVersion: '0.3.0',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: { provider: 'openrouter-chat', profileId: 'test', modelId: 'm', effort: 'high' },
    sessionMode: { kind: 'continue' },
    instructions: { loaded: true, source: 'AGENTS.md' },
    skills: { count: 1, names: ['s'], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  }, {
    sessionId: 'e8e99332-1999-4443-8e7f-8d18d57104f2',
    createdAt: '2026-09-21T06:00:00.000Z',
    agent: 'default',
    committedTurn: 5,
    messageCount: 10,
  });
  for (let turn = 1; turn <= 40; turn += 1) {
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
  for (let page = 0; page < 200; page += 1) {
    renderer.scrollPage('up');
    const scroll = renderer.stateSnapshot().scroll;
    assert(scroll.kind !== 'followLatest', 'PageUp jumped to latest before reaching oldest');
    if (scroll.kind === 'oldest') break;
  }
  assertEquals(renderer.stateSnapshot().scroll, { kind: 'oldest' });
  assertEquals(renderer.layoutSnapshot(100, 45).logStart, 0);
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
    skills: {
      count: 7,
      names: ['one', 'two', 'three', 'four', 'five'],
      omitted: 2,
    },
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
  assert(
    startupHeaderLines(base, position).some((line) => line.includes('continue newest')),
  );
  assert(
    startupHeaderLines({ ...base, sessionMode: { kind: 'exact' } }, position)
      .some((line) => line.includes('exact session')),
  );
  const none = startupHeaderLines(
    { ...base, sessionMode: { kind: 'none' } },
    position,
  );
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
  assert(full.some((line) => line.includes('base instruction:')));
  assert(
    full.some((line) => line.includes('local/henji-base · external · 2e00f40b')),
  );
  assert(full.some((line) => /context:\s+none/.test(line)));
  const compact = startupHeaderLines(base, position, 40, 12);
  assert(!compact.some((line) => line.includes('base instruction:')));
});

Deno.test('startup header wraps a growing skills list across rows', () => {
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
    skills: {
      count: 12,
      names: [
        'alpha',
        'bravo',
        'charlie',
        'delta',
        'echo',
        'foxtrot',
        'golf',
        'hotel',
        'india',
        'juliet',
      ],
      omitted: 2,
    },
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
  const lines = startupHeaderLines(base, position, 80, 24);
  assert(lines.filter((line) => line.includes('skills:')).length === 1);
  const skillRows = lines.filter((line) => /(?:alpha|bravo|charlie|juliet)/.test(line));
  assert(skillRows.length >= 2);
  assert(lines.some((line) => line.includes('(+2 more)')));
  for (const line of lines) assert(line.length <= 80);
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
  await waitFor(() => renderer.stateSnapshot().status === 'active task pending');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'anchored');
  terminal.push('\x04\x04');
  assertEquals(await run, 0);
});

Deno.test('cancelled active task does not block a new task without a recovery lane', async () => {
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
  await waitFor(() => controller.currentState === 'idle');
  assertEquals(controller.editor.text, '');
  assert(
    renderer.stateSnapshot().status.includes(
      'cancelled; recoverable input available; press Up to resend',
    ),
  );

  terminal.push('next task\r');
  await waitFor(() => submitted.length === 2 && controller.currentState === 'idle');
  assertEquals(submitted, [task, 'next task']);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('interrupted active task does not block a new task without a recovery lane', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const submitted: string[] = [];
  let settleInterrupted: (() => void) | undefined;
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
        settleInterrupted = () =>
          resolve({
            ok: false,
            task,
            outcome: 'interrupted',
            stopReason: 'interrupted',
            error: 'worker settlement deadline exceeded',
            steps: 0,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          });
      });
    },
    cancelActiveTurn: () => {
      settleInterrupted?.();
      return 'requested';
    },
    isAvailable: () => true,
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  const task = '中断された依頼を回復する';
  terminal.push(`${task}\r`);
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('\x1b');
  await waitFor(() => controller.currentState === 'idle');
  assert(
    renderer.stateSnapshot().status.includes(
      'worker interrupted; recoverable input available; press Up to resend',
    ),
  );

  terminal.push('next task\r');
  await waitFor(() => submitted.length === 2 && controller.currentState === 'idle');
  assertEquals(submitted, [task, 'next task']);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('interrupted active task honors a repeated Ctrl-C exit intent', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  let settleInterrupted: (() => void) | undefined;
  let cancellationRequests = 0;
  const session: TuiSessionLike = {
    submit: (task) =>
      new Promise((resolve) => {
        settleInterrupted = () =>
          resolve({
            ok: false,
            task,
            outcome: 'interrupted',
            stopReason: 'interrupted',
            error: 'worker settlement deadline exceeded',
            steps: 0,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          });
      }),
    cancelActiveTurn: () => {
      cancellationRequests += 1;
      setTimeout(() => settleInterrupted?.(), 20);
      return 'requested';
    },
    isAvailable: () => true,
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  terminal.push('interrupt then exit\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('\x03\x03');
  assertEquals(await run, 0);
  assertEquals(cancellationRequests, 1);
});

Deno.test('modern controller cancels after Enter in the same input chunk', async () => {
  const runCase = async (sameChunk: boolean): Promise<number> => {
    const terminal = new InteractiveTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    await lifecycle.acquire();
    let finish: ((outcome: LoopOutcome) => void) | undefined;
    let cancellations = 0;
    const core = {
      submit: (_task: string) =>
        new Promise<LoopOutcome>((resolve) => {
          finish = resolve;
        }),
      cancelActiveTurn: () => {
        cancellations += 1;
        finish?.({
          ok: false,
          task: 'same chunk',
          outcome: 'cancelled',
          stopReason: 'cancelled',
          error: 'cancelled',
          steps: 0,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        });
        return 'requested' as const;
      },
    };
    const adapter = createTuiPresentationAdapter(core);
    const controller = new TuiController(lifecycle, renderer, adapter, {
      pending: new PendingInputCore(),
      intents: adapter,
    });
    const run = controller.run();
    terminal.push(sameChunk ? 'same chunk\r\x03' : 'same chunk\r');
    if (!sameChunk) {
      await waitFor(() => controller.currentState === 'busy');
      terminal.push('\x03');
    }
    await waitFor(() => cancellations === 1 && controller.currentState === 'idle');
    terminal.push('\x04');
    assertEquals(await run, 0);
    return cancellations;
  };
  assertEquals(await runCase(true), 1);
  assertEquals(await runCase(false), 1);
});

Deno.test('occupied editor is preserved after a recoverable stop without a recovery lane', async () => {
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
  const controller = new TuiController(lifecycle, renderer, session, {
    pending,
  });
  const run = controller.run();
  terminal.push('original task\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('draft in progress');
  await waitFor(() => controller.editor.text === 'draft in progress');
  settleFailure?.();
  await waitFor(() => controller.currentState === 'idle');
  assertEquals(controller.editor.text, 'draft in progress');
  assert(!pending.hasActiveTask);
  assert(
    renderer.stateSnapshot().status.includes(
      'tools may have changed the workspace',
    ),
  );
  terminal.push('\x15\x04');
  assertEquals(await run, 0);
});

Deno.test('/recall selects next-task-only context', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const startup: PresentationStartupState = {
    productVersion: '0.5.0',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: {
      provider: 'mock-chat',
      profileId: 'mock-chat-key',
      modelId: 'mock-s11',
      effort: 'auto',
    },
    sessionMode: { kind: 'new' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  renderer.renderCompactStartup(startup, {
    sessionId: '1a7b0740-1a7a-449a-81cd-2374448d00d9',
    createdAt: '2026-09-24T00:00:00.000Z',
    agent: 'default' as const,
    committedTurn: 0,
    messageCount: 0,
  });
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
  assertEquals(
    intentsSeen.filter((kind) => kind === 'recall_execution').length,
    1,
  );

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
  renderer.eventSink({
    kind: 'failure_diagnostic',
    turn: 1,
    diagnostic: {
      schemaVersion: 1,
      diagnosticId: '66666666-6666-4666-8666-666666666666',
      stage: 'cancellation_cleanup',
      code: 'turn_cancelled',
      lane: 'parent',
      providerRequestCount: 1,
      occurredAt: '2026-09-24T00:00:00.000Z',
      turnNumber: 1,
      modelStep: 1,
      retryCount: 0,
    },
    durable: 'yes',
  });
  const failureRows = renderer.layoutSnapshot(80, 24).allLog.filter((row) =>
    row.entryId?.startsWith('failure:')
  );
  assert(failureRows.length > 0);
  assertEquals(
    failureRows.map((row) => row.text).join(''),
    `failure> cancelled · ${failureRecallGuidance}`,
  );
  assert(failureRows.every((row) => row.rowTone === 'failure'));
  const failureFrame = renderer.renderFrame(80, 24);
  assert(failureFrame.includes('\x1b[31mfailure> cancelled · /recall'));
  terminal.push('\x03\x04');
  assertEquals(await run, 0);
});

Deno.test('/recall is unavailable with --no-session and its failure row keeps the reason only', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const startup: PresentationStartupState = {
    productVersion: '0.5.0',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: {
      provider: 'mock-chat',
      profileId: 'mock-chat-key',
      modelId: 'mock-s11',
      effort: 'auto',
    },
    sessionMode: { kind: 'none' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  renderer.renderCompactStartup(startup, {
    sessionId: '1a7b0740-1a7a-449a-81cd-2374448d00d9',
    createdAt: '2026-09-24T00:00:00.000Z',
    agent: 'default' as const,
    committedTurn: 0,
    messageCount: 0,
  });
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
  renderer.eventSink({
    kind: 'failure_diagnostic',
    turn: 1,
    diagnostic: {
      schemaVersion: 1,
      diagnosticId: '55555555-5555-4555-8555-555555555555',
      stage: 'cancellation_cleanup',
      code: 'turn_cancelled',
      lane: 'parent',
      providerRequestCount: 1,
      occurredAt: '2026-09-24T00:00:00.000Z',
      turnNumber: 1,
      modelStep: 1,
      retryCount: 0,
    },
    durable: 'yes',
  });
  const failureRows = renderer.layoutSnapshot(80, 24).allLog.filter((row) =>
    row.entryId?.startsWith('failure:')
  );
  assert(failureRows.length > 0);
  assertEquals(failureRows.map((row) => row.text).join(''), 'failure> cancelled');
  assert(failureRows.every((row) => row.rowTone === 'failure'));
  const frame = renderer.renderFrame(80, 24);
  assert(frame.includes('\x1b[31mfailure> cancelled\x1b[0m'));
  assert(!frame.includes(failureRecallGuidance));
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
    submitted &&
    (controller.currentState === 'idle' || controller.currentState === 'failed')
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
      if (title.length === 0) return Promise.resolve('unchanged');
      renamed.push(title);
      return Promise.resolve('renamed');
    },
    switchTo: () => Promise.reject(new Error('not used')),
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
      canCompact: false,
    }),
  );
  renderer.eventSink({
    kind: 'user_message',
    turn: 1,
    message: {
      role: 'user',
      content: { kind: 'text', text: 'old conversation' },
    },
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
  assertEquals(
    renderer.stateSnapshot().projection?.sessionId,
    newPosition.sessionId,
  );
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
    renderer.stateSnapshot().status ===
      'new session failed; current session unchanged'
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
  const controller = new TuiController(
    lifecycle,
    renderer,
    successfulSession(submitted),
    {
      pending: new PendingInputCore(),
      history,
    },
  );
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

Deno.test('restored thinking stays ordered and PageUp reaches history beyond the old display limits', () => {
  const renderer = new TuiRenderer(new RecordingTerminal());
  const messages = Array.from({ length: 300 }, (_, index) => [
    { role: 'user' as const, content: { kind: 'text' as const, text: `question ${index}` } },
    { role: 'assistant' as const, content: { kind: 'text' as const, text: `answer ${index}` } },
  ]).flat();
  renderer.renderRestored(messages, 0, [{
    beforeMessageIndex: 599,
    turn: 300,
    modelStep: 1,
    thinkingKind: 'summary',
    text: 'Read the final question.',
    complete: true,
  }]);
  const entries = renderer.stateSnapshot().log.entries;
  assert(entries.length > 512);
  assertEquals(renderer.stateSnapshot().log.omittedCount, 0);
  const tail = entries.slice(-3);
  assertEquals(tail.map((entry) => entry.kind), ['user', 'thinking', 'assistant']);
  assert(
    renderer.layoutSnapshot().allLog.some((row) => row.text.includes('Read the final question.')),
  );
  for (let page = 0; page < 120; page += 1) {
    const state = renderer.stateSnapshot();
    if (state.historyWindow?.start === 0 && state.scroll.kind === 'oldest') break;
    renderer.scrollPage('up');
  }
  assertEquals(renderer.stateSnapshot().historyWindow?.start, 0);
  assertEquals(renderer.stateSnapshot().scroll.kind, 'oldest');
  assert(renderer.layoutSnapshot().allLog.some((row) => row.text.includes('question 0')));
  for (let page = 0; page < 120; page += 1) {
    if (renderer.stateSnapshot().scroll.kind === 'followLatest') break;
    renderer.scrollPage('down');
  }
  assertEquals(renderer.stateSnapshot().scroll.kind, 'followLatest');
  assertEquals(renderer.stateSnapshot().historyWindow?.end, entries.length);
  renderer.latest();
  assert(renderer.layoutSnapshot().allLog.some((row) => row.text.includes('answer 299')));
});

Deno.test('live conversation retains earlier entries beyond 512 for PageUp', () => {
  let state = createUiState();
  for (let turn = 1; turn <= 260; turn += 1) {
    state = reduceUiEvent(state, {
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text: `question ${turn}` } },
    });
    state = reduceUiEvent(state, {
      kind: 'assistant_message',
      turn,
      message: { role: 'assistant', content: { kind: 'text', text: `answer ${turn}` } },
    });
  }
  assertEquals(state.log.entries.length, 520);
  assertEquals(state.log.entries[0].text, 'question 1');
  assertEquals(state.log.omittedCount, 0);
  assert((state.historyWindow?.start ?? 0) > 0);
});

Deno.test('restored conversation retains more than 2 MiB of entry text', () => {
  const longAnswer = 'A'.repeat(710 * 1024);
  const messages = Array.from({ length: 3 }, (_, index) => [
    { role: 'user' as const, content: { kind: 'text' as const, text: `question ${index}` } },
    { role: 'assistant' as const, content: { kind: 'text' as const, text: longAnswer } },
  ]).flat();
  const state = reduceUiEvent(createUiState(), {
    kind: 'restored_log',
    messages,
    omitted: 0,
  });
  assertEquals(state.log.entries.length, 6);
  assertEquals(state.log.entries[1].text.length, longAnswer.length);
  assertEquals(state.log.entries[5].text.length, longAnswer.length);
  assertEquals(state.log.omittedCount, 0);
  assert((state.historyWindow?.start ?? 0) > 0);
});

Deno.test('restored model steps place thinking around a tool result and final answer', () => {
  const renderer = new TuiRenderer(new RecordingTerminal());
  renderer.renderRestored(
    [
      { role: 'user', content: { kind: 'text', text: 'Compare the READMEs' } },
      {
        role: 'assistant',
        content: [{
          kind: 'tool_call',
          callId: 'read-1',
          name: 'read',
          arguments: { path: 'README.md' },
        }],
      },
      {
        role: 'tool',
        content: [{
          kind: 'tool_result',
          callId: 'read-1',
          name: 'read',
          text: 'README contents',
          outcome: 'success',
        }],
      },
      { role: 'assistant', content: { kind: 'text', text: 'They match.' } },
    ],
    0,
    [
      {
        beforeMessageIndex: 1,
        turn: 1,
        modelStep: 1,
        thinkingKind: 'text',
        text: 'Read both files.',
        complete: true,
      },
      {
        beforeMessageIndex: 3,
        turn: 1,
        modelStep: 2,
        thinkingKind: 'summary',
        text: 'Comparison done.',
        complete: true,
      },
    ],
    [1, 1, 1, 1],
  );
  assertEquals(renderer.stateSnapshot().log.entries.map((entry) => entry.kind), [
    'user',
    'thinking',
    'tool',
    'thinking',
    'assistant',
  ]);
  assertEquals(renderer.stateSnapshot().log.entries[3].label, 'thinking summary>');
});

Deno.test('failure row shows the execution ID that /recall accepts for a stopped run', async () => {
  const terminal = new InteractiveTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  const startup: PresentationStartupState = {
    productVersion: '0.5.0',
    workspace: '/tmp/henji-ui',
    agentId: 'default',
    model: {
      provider: 'mock-chat',
      profileId: 'mock-chat-key',
      modelId: 'mock-s11',
      effort: 'auto',
    },
    sessionMode: { kind: 'new' },
    instructions: { loaded: false, source: 'none' },
    skills: { count: 0, names: [], omitted: 0 },
    trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
    credentialVerification: 'before_each_provider_request',
  };
  renderer.renderCompactStartup(startup, {
    sessionId: '1a7b0740-1a7a-449a-81cd-2374448d00d9',
    createdAt: '2026-09-24T00:00:00.000Z',
    agent: 'default' as const,
    committedTurn: 0,
    messageCount: 0,
  });
  const sourceExecutionId = '2300b666-1111-4111-8111-111111111111';
  const intentsSeen: string[] = [];
  const intents: PresentationIntentDispatcher = {
    dispatch: (intent) => {
      intentsSeen.push(intent.kind);
      if (intent.kind === 'recall_execution') {
        assertEquals(intent.id, '2300b666');
        return { kind: 'recall', sourceExecutionId, evidence: 'available' };
      }
      return { kind: 'accepted' };
    },
  };
  const controller = new TuiController(lifecycle, renderer, successfulSession([]), {
    pending: new PendingInputCore(),
    intents,
  });
  const run = controller.run();
  renderer.eventSink({
    kind: 'failure_diagnostic',
    turn: 1,
    diagnostic: {
      schemaVersion: 1,
      diagnosticId: '77777777-7777-4777-8777-777777777777',
      stage: 'cancellation_cleanup',
      code: 'turn_cancelled',
      lane: 'parent',
      providerRequestCount: 1,
      occurredAt: '2026-09-24T00:00:00.000Z',
      turnNumber: 1,
      modelStep: 1,
      retryCount: 0,
    },
    durable: 'yes',
    executionId: sourceExecutionId,
  });
  const rows = renderer.layoutSnapshot(80, 24).allLog.filter((row) =>
    row.entryId?.startsWith('failure:')
  );
  assert(rows.length > 0);
  assertEquals(
    rows.map((row) => row.text).join(''),
    `failure> cancelled · execution 2300b666 · ${failureRecallGuidanceFor('2300b666')}`,
  );
  assert(rows.every((row) => row.rowTone === 'failure'));

  // The displayed ID is exactly the reference `/recall` accepts and resolves.
  terminal.push('/recall 2300b666\r');
  await waitFor(() => renderer.stateSnapshot().status === 'recall 2300b666 ready · next task only');
  assertEquals(intentsSeen.filter((kind) => kind === 'recall_execution').length, 1);
  terminal.push('\x03\x04');
  assertEquals(await run, 0);
});

Deno.test('busy PageUp pages the retained history while the turn keeps streaming', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  renderer.resize(80, 10);
  fillConversation(renderer);

  const submitted: string[] = [];
  let settle: (() => void) | undefined;
  const session: TuiSessionLike = {
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
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  terminal.push('long task\r');
  await waitFor(() => controller.currentState === 'busy');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'followLatest');

  terminal.push('\x1b[5~');
  await waitFor(() => renderer.stateSnapshot().scroll.kind !== 'followLatest');
  const pagedTop = renderer.layoutSnapshot(80, 10).log[0]?.text;
  assert(
    renderer.layoutSnapshot(80, 10).log.some((row) => row.text.includes('question')),
    'PageUp during the turn did not reveal older history',
  );
  assert(renderer.layoutSnapshot(80, 10).footer[0].text.includes('history '));

  renderer.eventSink({
    kind: 'assistant_progress',
    turn: 7,
    text: 'streaming while scrolled',
  });
  renderer.eventSink({
    kind: 'user_message',
    turn: 7,
    message: { role: 'user', content: { kind: 'text', text: 'late question' } },
  });
  assertEquals(renderer.stateSnapshot().scroll.kind !== 'followLatest', true);
  assertEquals(renderer.layoutSnapshot(80, 10).log[0]?.text, pagedTop);
  assert(renderer.stateSnapshot().newBelowCount > 0, 'new-below indicator did not count');

  for (let page = 0; page < 8; page += 1) terminal.push('\x1b[6~');
  await waitFor(() => renderer.stateSnapshot().scroll.kind === 'followLatest');
  assert(!renderer.layoutSnapshot(80, 10).footer[0].text.includes('history '));

  settle!();
  await waitFor(() => controller.currentState === 'idle');
  assertEquals(renderer.stateSnapshot().scroll.kind, 'followLatest');
  assertEquals(submitted, ['long task']);
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('busy Escape still cancels the turn while the history is anchored', async () => {
  const terminal = new InteractiveTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  await lifecycle.acquire();
  renderer.resize(80, 10);
  fillConversation(renderer);

  const submitted: string[] = [];
  let settleCancelled: (() => void) | undefined;
  const session: TuiSessionLike = {
    submit: (task) => {
      submitted.push(task);
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
    isAvailable: () => true,
  };
  const controller = new TuiController(lifecycle, renderer, session, {
    pending: new PendingInputCore(),
  });
  const run = controller.run();
  terminal.push('cancel task\r');
  await waitFor(() => controller.currentState === 'busy');
  terminal.push('\x1b[5~');
  await waitFor(() => renderer.stateSnapshot().scroll.kind !== 'followLatest');
  terminal.push('\x1b');
  await waitFor(() => controller.currentState === 'idle');
  assert(
    renderer.stateSnapshot().status.includes(
      'cancelled; recoverable input available; press Up to resend',
    ),
  );
  assertEquals(submitted, ['cancel task']);
  assert(renderer.stateSnapshot().scroll.kind !== 'followLatest');
  terminal.push('\x04');
  assertEquals(await run, 0);
});

Deno.test('busy history footer hints PgDn to latest while Esc stays cancel', () => {
  const terminal = new RecordingTerminal();
  terminal.size = { columns: 80, rows: 10 };
  const renderer = new TuiRenderer(terminal, {
    now: () => 0,
    setInterval: () => 'busy-timer',
    clearInterval: () => {},
  });
  renderer.resize(80, 10);
  fillConversation(renderer);
  renderer.scrollPage('up');
  assert(renderer.stateSnapshot().scroll.kind !== 'followLatest');
  const idleFooter = renderer.layoutSnapshot(80, 10).footer[0].text;
  assert(idleFooter.includes('history '));
  assert(idleFooter.includes('Esc latest'));

  renderer.eventSink({ kind: 'turn_start', turn: 7 });
  const busyFooter = renderer.layoutSnapshot(80, 10).footer[0].text;
  assert(busyFooter.includes('history '));
  assert(busyFooter.includes('PgDn latest'));
  assert(busyFooter.includes('Esc cancel'));
  assert(!busyFooter.includes('Esc latest'));

  renderer.latest();
  const latestFooter = renderer.layoutSnapshot(80, 10).footer[0].text;
  assert(!latestFooter.includes('history '));
  assert(latestFooter.includes('Esc cancel'));
  assert(!latestFooter.includes('Esc latest'));
});
