import { TerminalScreen } from './terminal_screen_fixture.ts';
import {
  createUiState,
  reduceUiAction,
  reduceUiEvent,
  uiConversationCount,
  uiConversationWindow,
} from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { TuiEditor } from '../../v0/tui/input.ts';
import { ImmediateTuiRenderer as TuiRenderer } from './tui_renderer_fixture.ts';
import type { ConversationEntity } from '../../v0/conversation/model.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { conversationPosition, tuiClientState, tuiSnapshot } from './tui_entity_fixture.ts';
import type {
  PresentationProjection,
  PresentationStartupState,
} from '../../v0/presentation/contract.ts';
import {
  BLINK_SGR,
  BLUE_SGR,
  DIM_SGR,
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

const projectEntities = (
  renderer: TuiRenderer,
  entities: Readonly<Record<string, ConversationEntity>>,
  order: readonly string[],
): void => {
  const update = new SnapshotConversationProjector().project(
    tuiClientState(tuiSnapshot(entities, order)),
    'retained-terminal-test',
  );
  renderer.setKeyedConversationStore(update.store);
};

const rendererEntries = (renderer: TuiRenderer) => {
  const state = renderer.stateSnapshot();
  return uiConversationWindow(state, 0, uiConversationCount(state));
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

  private readonly screen = new TerminalScreen();
  write(bytes: Uint8Array): void {
    const size = this.consoleSize();
    this.screen.resize(size.columns, size.rows);
    this.screen.write(bytes);
    this.writes.push(new TextDecoder().decode(bytes));
  }

  addSignal(): void {}

  removeSignal(): void {}
}

const indexOfWrite = (writes: readonly string[], value: string): number =>
  writes.findIndex((write) => write.includes(value));

Deno.test('terminal lifecycle requests extended keys and restores the previous mode', async () => {
  const terminal = new RecordingTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);

  await lifecycle.acquire();
  assertEquals(
    terminal.writes.filter((write) => write === '\x1b[>4;1m').length,
    1,
  );
  assert(
    indexOfWrite(terminal.writes, '\x1b[?2004h') < indexOfWrite(terminal.writes, '\x1b[>4;1m'),
    'extended keys should be requested after paste mode is enabled',
  );

  await lifecycle.restore();
  assertEquals(
    terminal.writes.filter((write) => write === '\x1b[>4;0m').length,
    1,
  );
  assert(
    indexOfWrite(terminal.writes, '\x1b[?2004l') < indexOfWrite(terminal.writes, '\x1b[>4;0m'),
    'paste mode should be restored before the extended keys mode',
  );

  await lifecycle.restore();
  assertEquals(
    terminal.writes.filter((write) => write === '\x1b[>4;1m').length,
    1,
  );
  assertEquals(
    terminal.writes.filter((write) => write === '\x1b[>4;0m').length,
    1,
  );
});

Deno.test('retained working footer spins its primary status and shows F1 cancel help', () => {
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
  assertEquals(layout.footer[0].text, ' ⠋ working 00:00 · F1 cancel');
  assert(!layout.footer[0].text.includes('\x1b'));
  assertEquals(layout.footer[0].blinkScalarStart, undefined);
  assertEquals(layout.footer[0].blinkScalarLength, undefined);
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠋ working 00:00 · F1 cancel',
    ),
  );
  assert(!renderer.renderFrame(80, 24).includes(BLINK_SGR));

  now = 62_000;
  tick();
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    ' ⠙ working 01:02 · F1 cancel',
  );

  renderer.setStatus('busy · steer applied');
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠙ working 01:02 · steer applied · F1 cancel',
    ),
  );
  renderer.setSlashCommandCandidates(['/help', '/recall']);
  assertEquals(
    renderer.layoutSnapshot(80, 24).footer[0].text,
    ' ⠙ working 01:02 · cmds: /help, /recall · steer applied · F1 cancel',
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
    ' ⠙ working 01:02 · cmds: /provider · pending active_task:44B · F1 cancel',
  );
  renderer.setSlashCommandCandidates([]);
  renderer.setPendingMetadata(undefined);
  renderer.setStatus('busy; /provider waits for ready');
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠙ working 01:02 · /provider waits for ready · F1 cancel',
    ),
  );

  now = 3_661_000;
  tick();
  renderer.setStatus('cancelling context compaction');
  assert(
    withoutSgr(renderer.renderFrame(80, 24)).includes(
      ' ⠹ cancelling 1:01:01 · context compaction · F1 cancel',
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
    renderer.layoutSnapshot(80, 24).log.some((row) => row.text.includes('API research')),
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
  const switched = renderer.layoutSnapshot(80, 24).log.map((row) => row.text);
  assert(switched.some((line) => line.includes('Restored session')));
  assert(switched.some((line) => line.includes('exact session · bbbbbbbb')));

  terminal.size = { columns: 50, rows: 12 };
  renderer.resize(50, 12);
  const compact = renderer.layoutSnapshot(50, 12).log.map((row) => row.text);
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
});

Deno.test('keyed conversation retains more than 2 MiB of entry text', () => {
  const longAnswer = 'A'.repeat(710 * 1024);
  const entities: Record<string, ConversationEntity> = {};
  const order: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const executionId = `execution-${index}`;
    const userId = `question-${index}`;
    const answerId = `answer-${index}`;
    entities[userId] = {
      kind: 'message',
      id: userId,
      executionId,
      turn: index + 1,
      version: 0,
      position: conversationPosition(index, -1, -1),
      role: 'user',
      text: `question ${index}`,
      complete: true,
    };
    entities[answerId] = {
      kind: 'message',
      id: answerId,
      executionId,
      turn: index + 1,
      version: 0,
      position: conversationPosition(index, 1, 1),
      role: 'assistant',
      text: longAnswer,
      complete: true,
    };
    order.push(userId, answerId);
  }
  const renderer = new TuiRenderer(new RecordingTerminal());
  projectEntities(renderer, entities, order);
  const entries = rendererEntries(renderer);
  assertEquals(entries.length, 6);
  assertEquals(entries[1]?.text.length, longAnswer.length);
  assertEquals(entries[5]?.text.length, longAnswer.length);
  assertEquals(renderer.stateSnapshot().keyedConversation?.omitted, 0);
});

Deno.test('keyed model steps place thinking around a tool result and final answer', () => {
  const renderer = new TuiRenderer(new RecordingTerminal());
  const executionId = 'compare-execution';
  const entities: Record<string, ConversationEntity> = {
    task: {
      kind: 'message',
      id: 'task',
      executionId,
      turn: 1,
      version: 0,
      position: conversationPosition(0, -1, -1),
      role: 'user',
      text: 'Compare the READMEs',
      complete: true,
    },
    beforeTool: {
      kind: 'thinking',
      id: 'beforeTool',
      executionId,
      turn: 1,
      requestKey: { executionId, modelStep: 1, requestOrdinal: 1 },
      thinkingKind: 'text',
      version: 0,
      position: conversationPosition(0, 1, 1),
      text: 'Read both files.',
      complete: true,
    },
    tool: {
      kind: 'tool',
      id: 'tool',
      started: true,
      executionId,
      turn: 1,
      requestKey: { executionId, modelStep: 1, requestOrdinal: 1 },
      version: 1,
      position: conversationPosition(0, 1, 2),
      callId: 'read-1',
      name: 'read',
      arguments: { path: 'README.md' },
      result: { text: 'README contents', outcome: 'success' },
    },
    afterTool: {
      kind: 'thinking',
      id: 'afterTool',
      executionId,
      turn: 1,
      requestKey: { executionId, modelStep: 2, requestOrdinal: 2 },
      thinkingKind: 'summary',
      version: 0,
      position: conversationPosition(0, 2, 1),
      text: 'Comparison done.',
      complete: true,
    },
    answer: {
      kind: 'message',
      id: 'answer',
      executionId,
      turn: 1,
      version: 0,
      position: conversationPosition(0, 2, 2),
      role: 'assistant',
      text: 'They match.',
      complete: true,
    },
  };
  projectEntities(renderer, entities, ['task', 'beforeTool', 'tool', 'afterTool', 'answer']);
  const entries = rendererEntries(renderer);
  assertEquals(entries.map((entry) => entry.kind), [
    'user',
    'thinking',
    'tool',
    'thinking',
    'assistant',
  ]);
  assertEquals(entries[3]?.label, 'thinking summary>');
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
    controls: ['F1 cancel', 'F2 queue', 'F3 steer', 'F4 sessions', '/ commands'],
  }, 62_000);
  let footer = renderer.layoutSnapshot(80, 24).footer;
  assert(footer[1].text.startsWith(' ⠋ working 00:38   '));
  assert(footer[1].text.includes('session-'));
  assert(!footer[0].text.includes('working'));
  for (
    const hint of [
      'F3 steer',
      'F2 queue',
      'F1 cancel',
      'F4 sessions',
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
    controls: ['F1 cancel', 'F2 queue', 'F3 steer', 'F4 sessions', '/ commands'],
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
    { activity: 'working', controls: ['F1 cancel', '/ commands'] },
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

Deno.test('remote footer shows active execution, queue, steering, and Session controls', () => {
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
    controls: ['F1 cancel', 'F2 queue', 'F3 steer', 'F4 sessions', '/ commands'],
  });
  const footer = renderer.layoutSnapshot(80, 24).footer[0].text;
  for (const hint of ['F1 cancel', 'F2 queue', 'F3 steer', 'F4 sessions', '/ commands']) {
    assert(footer.includes(hint), `${hint} missing from ${footer}`);
  }
  for (const hint of ['Ctrl-C', 'Ctrl-D', 'Ctrl-Q', 'credential']) {
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
  assert(text.includes('none │ F1 (running)'));
  assert(text.includes('/sessions │ F4'));
  assert(!text.includes('Navigate input history'));
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
    { activity: 'working', controls: ['F1 cancel', '/ commands'] },
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
  fresh.setRemoteFooter({ activity: 'working', controls: ['F1 cancel', '/ commands'] }, 100_000);
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
  assert(frame.includes(`${BLUE_SGR}● ready${RESET_SGR}`));
  assert(frame.includes(`${DIM_SGR}/tmp/日本/workspace${RESET_SGR}`));
  assert(frame.includes(`untitled${DIM_SGR} · abcdef12${RESET_SGR}`));
  assert(
    frame.includes(`${DIM_SGR}opencode-go-chat / ${RESET_SGR}mimo-v2.6-pro`),
  );
  assert(frame.includes(`${DIM_SGR}auto${RESET_SGR}`));
  renderer.setRemoteFooter({
    activity: 'working',
    controls: ['F1 cancel', 'F2 queue', 'F3 steer', 'F4 sessions'],
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
