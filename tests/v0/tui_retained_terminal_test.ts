import { encodeScreenFrame, type ScreenFrame } from '../../v0/tui/terminal.ts';
import { createUiState, reduceUiAction, reduceUiEvent } from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { TuiEditor } from '../../v0/tui/input.ts';
import { ImmediateTuiRenderer as TuiRenderer } from './tui_renderer_fixture.ts';
import type {
  PresentationProjection,
  PresentationStartupState,
} from '../../v0/presentation/contract.ts';
import {
  BLINK_SGR,
  BOLD_SGR,
  DIM_SGR,
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  GREEN_SGR,
  RESET_SGR,
  TerminalLifecycle,
  type TerminalPort,
  YELLOW_SGR,
} from '../../v0/tui/terminal.ts';
import type { PendingMetadataSnapshot } from '../../v0/tui/pending_input.ts';
import {
  SHORTCUT_ONLY_OPERATIONS,
  SLASH_COMMANDS,
  slashCommandHelpLines,
  slashPickerCandidates,
} from '../../v0/tui/slash_command.ts';
import { startupHeaderLines } from '../../v0/tui/startup_render.ts';
import { projectRuntimeDisplayState } from '../../v0/agent/runtime/startup_orientation.ts';

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

const withoutSgr = (text: string): string => {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
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

  writeFrame(frame: ScreenFrame, onWritten?: () => void): void {
    this.write(encodeScreenFrame(frame));
    onWritten?.();
  }

  write(bytes: Uint8Array): void {
    this.writes.push(new TextDecoder().decode(bytes));
  }

  addSignal(): void {}

  removeSignal(): void {}
}

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
    terminal.writes.slice(0, enter).every((write) => !write.includes('\x1b[?2026h')),
    'a retained frame was written before alternate-screen entry',
  );
  assert(
    terminal.writes.slice(enter + 1).some((write) => write.includes('\x1b[?2026h')),
    'screen frames should be synchronized inside the alternate screen',
  );

  await lifecycle.restore();
  const exit = indexOfWrite(terminal.writes, EXIT_ALTERNATE_SCREEN);
  assert(exit > enter);
  assert(
    terminal.writes.slice(enter + 1, exit).some((write) => write.includes('\x1b[?2026h')),
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
  assertEquals(layout.footer[0].text, ' ⠋ working 00:00 · Esc cancel');
  assert(!layout.footer[0].text.includes('\x1b'));
  assertEquals(layout.footer[0].blinkScalarStart, undefined);
  assertEquals(layout.footer[0].blinkScalarLength, undefined);
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠋ working 00:00 · Esc cancel',
    ),
  );
  assert(!renderer.renderFrame(80, 24).includes(BLINK_SGR));

  now = 62_000;
  tick();
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    ' ⠙ working 01:02 · Esc cancel',
  );

  renderer.setStatus('busy · steer applied');
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠙ working 01:02 · steer applied · Esc cancel',
    ),
  );
  renderer.setSlashCommandCandidates(['/help', '/recall']);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    ' ⠙ working 01:02 · cmds: /help, /recall · steer applied · Esc cancel',
  );
  assertEquals(
    renderer.layoutSnapshot(40, 24).footer[0].text,
    ' ⠙ working 01:02 · cmds: /help, /recall',
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
    ' ⠙ working 01:02 · cmds: /provider · pending active_task:44B · Esc cancel',
  );
  renderer.setSlashCommandCandidates([]);
  renderer.setPendingMetadata(undefined);
  renderer.setStatus('busy; /provider waits for ready');
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠙ working 01:02 · /provider waits for ready · Esc cancel',
    ),
  );

  now = 3_661_000;
  tick();
  renderer.setStatus('cancelling context compaction');
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠹ cancelling 1:01:01 · context compaction · Esc cancel',
    ),
  );
  layout = renderer.layoutSnapshot(12, 24);
  assertEquals(layout.footer[0].text, ' cancelling');
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
  assertEquals(layout.footer[0].text, ' ● ready');
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
    ' contract_failure',
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
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'm',
      effort: 'high',
    },
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
  renderer.setProjection({
    lifecycle: 'starting',
    agentId: startup.agentId,
    sessionId: position.sessionId,
    committedTurn: position.committedTurn,
    workspace: startup.workspace,
    model: startup.model,
    trust: 'trusted_local',
    credentialPolicy: startup.credentialVerification,
    pending: [],
    capabilities: { canNavigate: true, canCompact: false },
    generation: 0,
  });
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
    `unknown command /${'x'.repeat(100)}, try: /help, /sessions, /detach`,
  );
  assert(
    renderer.layoutSnapshot(80, 10).footer[0].text.startsWith(' history start'),
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
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'm',
      effort: 'high',
    },
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
    {
      role: 'user' as const,
      content: { kind: 'text' as const, text: `question ${index}` },
    },
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
    const position = footer.match(/history record (\d+) of (\d+)/);
    if (position !== null) {
      assertEquals(Number(position[2]), messages.length);
      assert(
        Number(position[1]) <= previousEntry,
        'PageUp moved toward newer entries',
      );
      assert(!footer.includes('record line'));
      previousEntry = Number(position[1]);
    }
    const state = renderer.stateSnapshot();
    if (state.historyWindow?.start === 0 && state.scroll.kind === 'oldest') {
      break;
    }
  }
  const oldest = renderer.layoutSnapshot();
  assertEquals(renderer.stateSnapshot().historyWindow?.start, 0);
  assertEquals(renderer.stateSnapshot().scroll.kind, 'oldest');
  assert(
    oldest.allLog.length < oldest.log.length,
    'the oldest window should fit one viewport',
  );
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
  const body = Array.from({ length: 200 }, (_, index) => `- item ${index}`)
    .join('\n');
  renderer.eventSink({
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: body } },
  });
  const assistantRows = renderer.layoutSnapshot(80, 10).allLog.filter((row) =>
    row.entryId !== undefined
  );
  assert(
    assistantRows.length > 2,
    'assistant entry did not span multiple rows',
  );
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
    assert(
      starts[index] > starts[index - 1],
      'PageDown did not advance monotonically',
    );
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
      ...Array.from(
        { length: 90 },
        (_, index) => `| record-${index} | ${'detail '.repeat(8)} |`,
      ),
    ].join('\n'),
    Array.from(
      { length: 90 },
      (_, index) => `paragraph-${index} ${'word '.repeat(25)}`,
    ).join('\n'),
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
    model: {
      provider: 'openrouter-chat',
      profileId: 'test',
      modelId: 'm',
      effort: 'high',
    },
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
  for (let page = 0; page < 200; page += 1) {
    renderer.scrollPage('up');
    const scroll = renderer.stateSnapshot().scroll;
    assert(
      scroll.kind !== 'followLatest',
      'PageUp jumped to latest before reaching oldest',
    );
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

Deno.test('restored thinking stays ordered and PageUp reaches history beyond the old display limits', () => {
  const renderer = new TuiRenderer(new RecordingTerminal());
  const messages = Array.from({ length: 300 }, (_, index) => [
    {
      role: 'user' as const,
      content: { kind: 'text' as const, text: `question ${index}` },
    },
    {
      role: 'assistant' as const,
      content: { kind: 'text' as const, text: `answer ${index}` },
    },
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
  assertEquals(tail.map((entry) => entry.kind), [
    'user',
    'thinking',
    'assistant',
  ]);
  assert(
    renderer.layoutSnapshot().allLog.some((row) => row.text.includes('Read the final question.')),
  );
  for (let page = 0; page < 120; page += 1) {
    const state = renderer.stateSnapshot();
    if (state.historyWindow?.start === 0 && state.scroll.kind === 'oldest') {
      break;
    }
    renderer.scrollPage('up');
  }
  assertEquals(renderer.stateSnapshot().historyWindow?.start, 0);
  assertEquals(renderer.stateSnapshot().scroll.kind, 'oldest');
  assert(
    renderer.layoutSnapshot().allLog.some((row) => row.text.includes('question 0')),
  );
  for (let page = 0; page < 120; page += 1) {
    if (renderer.stateSnapshot().scroll.kind === 'followLatest') break;
    renderer.scrollPage('down');
  }
  assertEquals(renderer.stateSnapshot().scroll.kind, 'followLatest');
  assertEquals(renderer.stateSnapshot().historyWindow?.end, entries.length);
  renderer.latest();
  assert(
    renderer.layoutSnapshot().allLog.some((row) => row.text.includes('answer 299')),
  );
});

Deno.test('live conversation retains earlier entries beyond 512 for PageUp', () => {
  let state = createUiState();
  for (let turn = 1; turn <= 260; turn += 1) {
    state = reduceUiEvent(state, {
      kind: 'user_message',
      turn,
      message: {
        role: 'user',
        content: { kind: 'text', text: `question ${turn}` },
      },
    });
    state = reduceUiEvent(state, {
      kind: 'assistant_message',
      turn,
      message: {
        role: 'assistant',
        content: { kind: 'text', text: `answer ${turn}` },
      },
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
    {
      role: 'user' as const,
      content: { kind: 'text' as const, text: `question ${index}` },
    },
    {
      role: 'assistant' as const,
      content: { kind: 'text' as const, text: longAnswer },
    },
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
  assertEquals(
    renderer.stateSnapshot().log.entries.map((entry) => entry.kind),
    [
      'user',
      'thinking',
      'tool',
      'thinking',
      'assistant',
    ],
  );
  assertEquals(
    renderer.stateSnapshot().log.entries[3].label,
    'thinking summary>',
  );
});

Deno.test('history footer hints Esc latest while busy and only latest advertises cancel', () => {
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
  assert(busyFooter.includes('Esc latest'));
  assert(!busyFooter.includes('Esc cancel'));

  renderer.setRemoteFooter({
    activity: 'working',
    controls: ['F2 queue', 'F3 steer', 'Esc cancel', '/ commands'],
  });
  const remoteFooter = renderer.layoutSnapshot(80, 10).footer[0].text;
  assert(remoteFooter.includes('Esc latest'));
  assert(!remoteFooter.includes('Esc cancel'));

  renderer.latest();
  const latestFooter = renderer.layoutSnapshot(80, 10).footer[0].text;
  assert(!latestFooter.includes('history '));
  assert(latestFooter.includes('Esc cancel'));
  assert(!latestFooter.includes('Esc latest'));
});

Deno.test('remote execution clock leads the second footer row and survives repeated snapshots', () => {
  const terminal = new RecordingTerminal();
  let now = 100_000;
  let tick = () => {};
  let starts = 0;
  const stopped: unknown[] = [];
  const renderer = new TuiRenderer(terminal, {
    now: () => now,
    setInterval: (callback) => {
      tick = callback;
      return ++starts;
    },
    clearInterval: (id) => stopped.push(id),
  });
  const projection: PresentationProjection = {
    lifecycle: 'busy',
    workspace: '/tmp/remote-workspace',
    sessionId: 'session-clock',
    agentId: 'default',
    committedTurn: 0,
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: false, canCompact: false },
    generation: 1,
  };
  renderer.setProjection(projection, 62_000);
  renderer.setRemoteFooter({
    activity: 'working',
    controls: ['F2 queue', 'F3 steer', 'Esc cancel', '/ commands'],
  }, 62_000);
  let footer = renderer.layoutSnapshot(80, 24).footer;
  assert(footer[1].text.startsWith(' ⠋ working 00:38   '));
  assert(footer[1].text.includes('session-'));
  assert(!footer[0].text.includes('working'));
  for (
    const hint of [
      'F3 steer',
      'F2 queue',
      'Esc cancel',
    ]
  ) {
    assert(footer[0].text.includes(hint));
  }

  now = 102_000;
  renderer.setProjection({ ...projection, generation: 2 }, 62_000);
  tick();
  assertEquals(starts, 1);
  assert(
    renderer.layoutSnapshot(80, 24).footer[1].text.startsWith(
      ' ⠙ working 00:40   ',
    ),
  );
  renderer.setRemoteFooter({
    activity: 'working',
    controls: ['F2 queue', 'F3 steer', 'Esc cancel', '/ commands'],
  }, 62_000);
  assert(!renderer.layoutSnapshot(80, 24).footer.some((row) => row.text.includes('accepted')));

  renderer.setProjection({ ...projection, lifecycle: 'cancelling' }, 62_000);
  renderer.setRemoteFooter({ activity: 'cancelling', controls: ['/ commands'] }, 62_000);
  assertEquals(starts, 1);
  assert(
    renderer.layoutSnapshot(80, 24).footer[1].text.startsWith(
      ' ⠙ cancelling 00:40   ',
    ),
  );

  renderer.setProjection(projection, 102_000);
  renderer.setRemoteFooter(
    { activity: 'working', controls: ['Esc cancel', '/ commands'] },
    102_000,
  );
  assertEquals(starts, 2);
  assert(
    renderer.layoutSnapshot(80, 24).footer[1].text.startsWith(
      ' ⠋ working 00:00   ',
    ),
  );
  renderer.setProjection({ ...projection, lifecycle: 'idle' });
  renderer.setRemoteFooter({ activity: 'ready', controls: ['Enter submit', '/ commands'] });
  footer = renderer.layoutSnapshot(80, 24).footer;
  assert(!footer[1].text.includes('working'));
  assertEquals(stopped, [1, 2]);
  renderer.close();
});

Deno.test('remote footer shows contextual controls without constant global shortcuts', () => {
  const terminal = new RecordingTerminal();
  terminal.size = { columns: 80, rows: 24 };
  const renderer = new TuiRenderer(terminal, {
    now: () => 0,
    setInterval: () => 'busy-timer',
    clearInterval: () => {},
  });
  renderer.resize(80, 24);
  renderer.eventSink({ kind: 'turn_start', turn: 1 });
  renderer.setRemoteFooter({
    activity: 'working',
    controls: ['F2 queue', 'F3 steer', 'Esc cancel', '/ commands'],
  });
  const footer = renderer.layoutSnapshot(80, 24).footer[0].text;
  for (const hint of ['F3 steer', 'F2 queue', 'Esc cancel', '/ commands']) {
    assert(footer.includes(hint), `${hint} missing from ${footer}`);
  }
  for (const hint of ['F1', 'Ctrl-C', 'Ctrl-D', 'Ctrl-Q', 'credential']) {
    assert(!footer.includes(hint));
  }
  renderer.close();
});

Deno.test('Increment 159 full command picker keeps the selected command visible and help reaches all keys', () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal);
  renderer.resize(80, 23);
  const candidates = slashPickerCandidates('/')!;
  assertEquals(candidates.length, SLASH_COMMANDS.length);
  renderer.renderSlashPicker(candidates, candidates.length - 1);
  const picker = renderer.layoutSnapshot(80, 23);
  assert(picker.log.some((row) => row.text.includes('> /quit')));
  assert(picker.log.some((row) => row.text.includes('usage: /quit │ Ctrl-Q')));
  renderer.renderReadOnlyHelp(slashCommandHelpLines());
  const seen = new Set<string>();
  let previous = -1;
  while (renderer.stateSnapshot().overlay.kind === 'readOnlyHelp') {
    const overlay = renderer.stateSnapshot().overlay;
    if (overlay.kind !== 'readOnlyHelp') break;
    const offset = overlay.offset ?? 0;
    if (offset === previous) break;
    previous = offset;
    for (const row of renderer.layoutSnapshot(80, 23).log) seen.add(row.text);
    renderer.scrollHelp('down');
  }
  const text = [...seen].join('\n');
  for (const definition of SLASH_COMMANDS) {
    assert(text.includes(definition.usage));
  }
  for (const [description] of SHORTCUT_ONLY_OPERATIONS) assert(text.includes(description));
  assert(text.includes('Ctrl-U (masked input)'));
  assert(text.includes('none │ F2 (running)'));
  renderer.close();
});

Deno.test('Increment 159 footer preparation spins without invented time and settings update together', () => {
  const terminal = new RecordingTerminal();
  let now = 100_000;
  let tick = () => {};
  let starts = 0;
  let stops = 0;
  const renderer = new TuiRenderer(terminal, {
    now: () => now,
    setInterval: (callback) => {
      tick = callback;
      return ++starts;
    },
    clearInterval: () => {
      stops++;
    },
  });
  const projection: PresentationProjection = {
    lifecycle: 'idle',
    workspace: '/very/long/path/to/workspace',
    sessionId: 'session-footer',
    agentId: 'default',
    committedTurn: 0,
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: false, canCompact: false },
    generation: 1,
    model: { provider: 'opencode-go-chat', modelId: 'mimo-v2.6-pro', effort: 'auto' },
  };
  renderer.setProjection(projection);
  renderer.setRemoteFooter({ activity: 'working', controls: ['/ commands'] });
  {
    const footer = renderer.layoutSnapshot(80, 24).footer;
    assert(footer[1].text.startsWith(' ⠋ working   '));
    assert(!footer[1].text.includes('00:'));
    now += 2000;
    tick();
    assertEquals(starts, 1);
    assert(renderer.layoutSnapshot(80, 24).footer[1].text.startsWith(' ⠙ working   '));
  }
  renderer.setRemoteFooter(
    { activity: 'working', controls: ['Esc cancel', '/ commands'] },
    100_000,
  );
  assert(renderer.layoutSnapshot(80, 24).footer[1].text.startsWith(' ⠋ working 00:02   '));
  assert(renderer.layoutSnapshot(40, 24).footer[1].text.startsWith(' ⠋ working 00:02'));
  const fresh = new TuiRenderer(new RecordingTerminal(), {
    now: () => now,
    setInterval: () => 'reconnected',
    clearInterval() {},
  });
  fresh.setProjection({ ...projection, lifecycle: 'busy' });
  fresh.setRemoteFooter({ activity: 'working', controls: ['Esc cancel', '/ commands'] }, 100_000);
  assertEquals(
    fresh.layoutSnapshot(80, 24).footer[1].text,
    renderer.layoutSnapshot(80, 24).footer[1].text,
  );
  fresh.close();
  renderer.setRemoteFooter({ activity: 'ready', controls: ['Enter submit', '/ commands'] });
  assertEquals(stops, 2);
  let footer = renderer.layoutSnapshot(40, 24).footer;
  assert(footer[1].text.startsWith(' ● ready   '));
  assert(!footer[1].text.includes('00:'));
  renderer.setProjection({
    ...projection,
    generation: 2,
    model: { provider: 'opencode-go-responses', modelId: 'gpt-5.6-luna', effort: 'low' },
  });
  footer = renderer.layoutSnapshot(80, 24).footer;
  assertEquals(footer[2].text, ' opencode-go-responses / gpt-5.6-luna'.padEnd(76) + 'low');
  renderer.renderChoicePicker(['credential input'], ['Enter save', 'Ctrl-U clear', 'Esc cancel']);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    ' Enter save · Ctrl-U clear · Esc cancel',
  );
  renderer.clearModal();
  for (const activity of ['READ-ONLY', 'DISCONNECTED'] as const) {
    renderer.setRemoteFooter({ activity, controls: ['/ commands'] });
    assert(renderer.layoutSnapshot(40, 24).footer[1].text.startsWith(` ${activity}   `));
  }
  renderer.close();
});

Deno.test('Increment 160 footer aligns identity and styles only the intended visible fields', () => {
  const renderer = new TuiRenderer(new RecordingTerminal());
  const projection: PresentationProjection = {
    lifecycle: 'idle',
    workspace: '/tmp/日本/workspace',
    sessionId: 'abcdef12-footer',
    agentId: 'default',
    committedTurn: 0,
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: false, canCompact: false },
    generation: 1,
    model: { provider: 'opencode-go-chat', modelId: 'mimo-v2.6-pro', effort: 'auto' },
  };
  renderer.setProjection(projection);
  renderer.setRemoteFooter({ activity: 'ready', controls: ['Enter submit', '/ commands'] });
  const footer = renderer.layoutSnapshot(100, 24).footer;
  assertEquals(footer[0].text, ' Enter submit · / commands');
  assert(footer[1].text.startsWith(' ● ready   /tmp/日本/workspace'));
  assert(footer[1].text.endsWith('untitled · abcdef12'));
  assertEquals(footer[2].text, ' opencode-go-chat / mimo-v2.6-pro'.padEnd(95) + 'auto');
  const frame = renderer.renderFrame(100, 24);
  assert(frame.includes(`Enter${DIM_SGR} submit${RESET_SGR}`));
  assert(frame.includes(`${GREEN_SGR}● ready${RESET_SGR}`));
  assert(frame.includes(`${DIM_SGR}/tmp/日本/workspace${RESET_SGR}`));
  assert(frame.includes(`untitled${DIM_SGR} · abcdef12${RESET_SGR}`));
  assert(
    frame.includes(`${DIM_SGR}opencode-go-chat / ${RESET_SGR}${BOLD_SGR}mimo-v2.6-pro${RESET_SGR}`),
  );
  assert(frame.includes(`${DIM_SGR}auto${RESET_SGR}`));
  renderer.setRemoteFooter({
    activity: 'working',
    controls: ['F2 queue', 'F3 steer', 'Esc cancel'],
  });
  assert(renderer.renderFrame(100, 24).includes(`${YELLOW_SGR}⠋ working${RESET_SGR}`));
  renderer.setRemoteFooter({ activity: 'ready', controls: ['Enter submit', '/ commands'] });
  renderer.renderChoicePicker(['model selection'], ['↑/↓ select', 'Enter choose', 'Esc close']);
  assertEquals(
    renderer.layoutSnapshot(100, 24).footer[0].text,
    ' ↑/↓ select · Enter choose · Esc close',
  );
  assert(renderer.renderFrame(100, 24).includes(`↑/↓${DIM_SGR} select${RESET_SGR}`));
  renderer.close();
});
