import {
  createUiState,
  reduceUiAction,
  reduceUiEvent,
  setUiProjection,
} from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';
import { TuiRenderer } from '../../v0/tui/render.ts';
import { type TerminalPort } from '../../v0/tui/terminal.ts';
import { TuiPresentationAdapter } from '../../v0/agent/tui_presentation_adapter.ts';
import { type AssistantContentRenderer } from '../../v0/tui/conversation_renderer.ts';

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

class FakeTerminal implements TerminalPort {
  readonly writes: string[] = [];
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

  setRaw(): void {}

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

Deno.test('conversation presentation keeps successful operational metadata out of the normal log', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'inspect' } },
  });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: 'done' } },
  });
  state = reduceUiEvent(state, {
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    turnProviderRequestCount: 2,
    runtimeProviderRequestCount: 2,
    providerEvidenceId: '11111111-1111-4111-8111-111111111111',
  });
  assertEquals(state.log.entries.map((entry) => entry.label), [
    'user>',
    'assistant>',
  ]);
  assert(
    !state.log.entries.some((entry) => /requests>|evidence>|readback>/.test(entry.text)),
  );
});

Deno.test('conversation layout stays plain while retained frame colors only settled role labels', () => {
  const terminal = new FakeTerminal();
  const phases: string[] = [];
  const assistantRenderer: AssistantContentRenderer = {
    render: (text, phase) => {
      phases.push(phase);
      return text;
    },
  };
  const renderer = new TuiRenderer(terminal, { retained: true, assistantRenderer });
  renderer.eventSink({
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: '質問' } },
  });
  renderer.eventSink({ kind: 'assistant_progress', turn: 1, text: '途中' });
  const streaming = renderer.layoutSnapshot(4, 24);
  assert(streaming.allLog.map((row) => row.text).join('').includes('assistant~'));
  assert(streaming.allLog.every((row) => !row.text.includes('\x1b')));
  renderer.eventSink({
    kind: 'assistant_message',
    turn: 1,
    message: { role: 'assistant', content: { kind: 'text', text: '回答' } },
  });
  const layout = renderer.layoutSnapshot(80, 24);
  assert(layout.allLog.every((row) => !row.text.includes('\x1b')));
  assert(layout.allLog.some((row) => row.labelTone === 'user'));
  assert(layout.allLog.some((row) => row.labelTone === 'assistant'));
  const frame = renderer.renderFrame(80, 24);
  assert(frame.includes('\x1b[34muser>\x1b[0m 質問'));
  assert(frame.includes('\x1b[33massistant>\x1b[0m 回答'));
  assert(!frame.includes('\x1b[33m回答'));
  assert(phases.includes('streaming'));
  assert(phases.includes('settled'));
});

Deno.test('presentation adapter accepts request counts through the 64-step root budget', async () => {
  const events: unknown[] = [];
  const adapter = new TuiPresentationAdapter(
    {
      submit: () =>
        Promise.resolve({
          ok: true,
          task: 'inspect',
          outcome: 'final' as const,
          stopReason: 'final' as const,
          finalText: 'done',
          turnProviderRequestCount: 64,
          runtimeProviderRequestCount: 128,
          steps: 64,
          toolCallCount: 63,
          toolResultCount: 63,
          transcript: [],
        }),
    },
    (event) => events.push(event),
  );

  const submitted = await adapter.submit('inspect');
  assertEquals(submitted.turnProviderRequestCount, 64);
  assertEquals(submitted.runtimeProviderRequestCount, 128);

  adapter.deliverCoreEvent({
    kind: 'turn_end',
    turn: 1,
    outcome: 'final',
    committed: true,
    turnProviderRequestCount: 64,
    runtimeProviderRequestCount: 128,
  });
  const ended = events.find((event) =>
    typeof event === 'object' && event !== null &&
    (event as { readonly kind?: unknown }).kind === 'turn_end'
  ) as {
    readonly turnProviderRequestCount?: number;
    readonly runtimeProviderRequestCount?: number;
  } | undefined;
  assertEquals(ended?.turnProviderRequestCount, 64);
  assertEquals(ended?.runtimeProviderRequestCount, 128);
});

Deno.test('conversation presentation reduces tool activity without source contents or raw JSON', () => {
  let state = createUiState();
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: { callId: 'read-1', name: 'read', arguments: { path: 'secret.txt' } },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_progress',
    turn: 1,
    callId: 'read-1',
    name: 'read',
    text: 'full file contents: do not display this',
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'read-1',
      name: 'read',
      text: '{"contents":"full file contents: do not display this"}',
      outcome: 'success',
    },
  });
  assertEquals(state.log.entries.length, 1);
  assertEquals(state.log.entries[0].text, 'read secret.txt ✓');
  assertEquals(state.log.entries[0].live, false);
  assert(!state.log.entries[0].text.includes('full file contents'));
  assert(!state.log.entries[0].text.includes('contents'));

  const pending = reduceUiEvent(createUiState(), {
    kind: 'tool_call',
    turn: 2,
    call: {
      callId: 'bash-2',
      name: 'bash',
      arguments: { command: 'long-running' },
    },
  });
  assertEquals(pending.log.entries[0].live, true);
  const cancelled = reduceUiEvent(pending, {
    kind: 'turn_end',
    turn: 2,
    outcome: 'cancelled',
    committed: false,
  });
  assertEquals(cancelled.log.entries, []);
});

Deno.test('conversation presentation settles assistant progress to the same assistant entry', () => {
  let state = reduceUiEvent(createUiState(), {
    kind: 'assistant_progress',
    turn: 1,
    text: 'draft answer',
  });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: {
      role: 'assistant',
      content: { kind: 'text', text: 'final answer' },
    },
  });
  assertEquals(state.log.entries.length, 1);
  assertEquals(state.log.entries[0].label, 'assistant>');
  assertEquals(state.log.entries[0].text, 'final answer');
  assertEquals(state.log.entries[0].live, false);
});

Deno.test('conversation footer uses the committed turn and emits identity facts once', () => {
  let state = setUiProjection(createUiState(), {
    lifecycle: 'idle',
    agentId: 'default',
    sessionId: 'abcdef12-3456-4789-8123-abcdefabcdef',
    committedTurn: 0,
    workspace: '/tmp/workspace',
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: true, canHistory: true, canCompact: true },
    generation: 0,
  });
  state = reduceUiEvent(state, {
    kind: 'turn_end',
    turn: 3,
    outcome: 'final',
    committed: true,
  });
  const footer = layoutUi(state, 80, 24).footer;
  assertEquals(footer.length, 2);
  assert(footer[0].text.includes('ready'));
  assert(footer[0].text.includes('agent default'));
  assert(footer[0].text.includes('session abcdef12 · turn 3'));
  assertEquals(footer[1].text, '[cwd /tmp/workspace]');
  assert(!footer.some((row) => row.text.includes('F1 help')));
  assert(!footer[0].text.includes('turn 0'));
  assertEquals((footer[0].text.match(/agent default/g) ?? []).length, 1);
  assertEquals((footer[0].text.match(/session abcdef12/g) ?? []).length, 1);

  const contextRich = reduceUiAction(state, {
    kind: 'status',
    text:
      'session abcdef12 · agent default · turn 3 · ready · context through turn 3 · retain 2+ · semantic ≤123456B · ctx ≤64K/64K est · 4 omitted',
  });
  const contextFooter = layoutUi(contextRich, 80, 24).footer[0].text;
  assert(contextFooter.includes('ready'));
  assert(contextFooter.includes('session abcdef12 · turn 3'));

  const narrow = setUiProjection(createUiState(), {
    lifecycle: 'idle',
    agentId: 'default',
    sessionId: 'abcdef12-3456-4789-8123-abcdefabcdef',
    committedTurn: 0,
    workspace: '/home/masat.guest/src/a/very/deep/path/forgejo-agent',
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: true, canHistory: true, canCompact: true },
    generation: 0,
  });
  const narrowFooter = layoutUi(narrow, 40, 24).footer;
  assert(narrowFooter[1].text.includes('cwd …'));
  assert(narrowFooter[1].text.includes('forgejo-agent'));
  assert(!narrowFooter.some((row) => row.text.includes('F1 help')));

  const cancelling = reduceUiAction(narrow, {
    kind: 'status',
    text: 'cancelling context compaction; Ctrl-C again to discard and exit',
  });
  for (const columns of [40, 80]) {
    const cancellingFooter = layoutUi(cancelling, columns, 24).footer;
    assert(cancellingFooter[0].text.includes('cancelling'));
    assert(cancellingFooter[1].text.includes('cwd '));
    assert(cancellingFooter[1].text.includes('forgejo-agent'));
    assert(cancellingFooter.every((row) => row.text.length <= columns));
  }
});

Deno.test('conversation layout derives turn and input boundaries without changing log entries', () => {
  let state = setUiProjection(createUiState(), {
    lifecycle: 'idle',
    agentId: 'default',
    sessionId: 'abcdef12-3456-4789-8123-abcdefabcdef',
    committedTurn: 2,
    workspace: '/tmp/workspace',
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: true, canHistory: true, canCompact: true },
    generation: 0,
  });
  state = reduceUiEvent(state, {
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'first' } },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      kind: 'tool_call',
      callId: 'read-1',
      name: 'read',
      arguments: { path: 'README.md' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'read-1',
      name: 'read',
      text: 'body',
      outcome: 'success',
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_call',
    turn: 1,
    call: {
      kind: 'tool_call',
      callId: 'bash-1',
      name: 'bash',
      arguments: { command: 'git status --short' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'tool_result',
    turn: 1,
    result: {
      kind: 'tool_result',
      callId: 'bash-1',
      name: 'bash',
      text: '',
      outcome: 'success',
    },
  });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 1,
    message: {
      role: 'assistant',
      content: { kind: 'text', text: 'first answer' },
    },
  });
  state = reduceUiEvent(state, {
    kind: 'user_message',
    turn: 2,
    message: { role: 'user', content: { kind: 'text', text: 'second' } },
  });
  state = reduceUiEvent(state, {
    kind: 'assistant_message',
    turn: 2,
    message: {
      role: 'assistant',
      content: { kind: 'text', text: 'second answer' },
    },
  });
  state = reduceUiAction(state, { kind: 'status', text: 'ready' });

  const layout = layoutUi(state, 80, 24);
  assertEquals(state.log.entries.length, 6);
  assertEquals(layout.allLog.map((row) => row.text), [
    'user> first',
    '',
    'tool> read README.md ✓',
    'tool> bash git status --short ✓',
    'assistant> first answer',
    '',
    'user> second',
    '',
    'assistant> second answer',
  ]);
  assertEquals(layout.beforeInput.map((row) => row.text), ['']);
  assertEquals(layout.afterInput.map((row) => row.text), ['']);
  assertEquals(layout.footer.map((row) => row.text), [
    '[ready · session abcdef12 · turn 2 · agent default]',
    '[cwd /tmp/workspace]',
  ]);

  const restored = reduceUiEvent(createUiState(), {
    kind: 'restored_log',
    omitted: 0,
    messages: [
      { role: 'user', content: { kind: 'text', text: 'first' } },
      {
        role: 'assistant',
        content: [
          {
            kind: 'tool_call',
            callId: 'read-1',
            name: 'read',
            arguments: { path: 'README.md' },
          },
          {
            kind: 'tool_call',
            callId: 'bash-1',
            name: 'bash',
            arguments: { command: 'git status --short' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            kind: 'tool_result',
            callId: 'read-1',
            name: 'read',
            text: 'body',
            outcome: 'success',
          },
          {
            kind: 'tool_result',
            callId: 'bash-1',
            name: 'bash',
            text: '',
            outcome: 'success',
          },
        ],
      },
      {
        role: 'assistant',
        content: { kind: 'text', text: 'first answer' },
      },
    ],
  });
  assertEquals(layoutUi(restored, 80, 24).allLog.map((row) => row.text), [
    'user> first',
    '',
    'tool> read README.md ✓',
    'tool> bash git status --short ✓',
    'assistant> first answer',
  ]);
});

Deno.test('conversation degraded height keeps only rows that physically fit', () => {
  let state = setUiProjection(
    createUiState({ text: 'draft', cursorScalar: 5, byteLength: 5 }),
    {
      lifecycle: 'idle',
      agentId: 'default',
      sessionId: 'abcdef12-3456-4789-8123-abcdefabcdef',
      committedTurn: 1,
      workspace: '/tmp/workspace',
      trust: 'trusted_local',
      credentialPolicy: 'before_each_provider_request',
      pending: [],
      capabilities: { canNavigate: true, canHistory: true, canCompact: true },
      generation: 0,
    },
  );
  state = reduceUiEvent(state, {
    kind: 'user_message',
    turn: 1,
    message: { role: 'user', content: { kind: 'text', text: 'question' } },
  });
  for (
    const [rows, expected] of [
      [4, { log: 1, footer: 2, cursor: 1 }],
      [3, { log: 0, footer: 2, cursor: 0 }],
      [2, { log: 0, footer: 1, cursor: 0 }],
      [1, { log: 0, footer: 0, cursor: 0 }],
    ] as const
  ) {
    const layout = layoutUi(state, 80, rows);
    assertEquals(layout.log.length, expected.log);
    assertEquals(layout.input.length, 1);
    assertEquals(layout.footer.length, expected.footer);
    assertEquals(layout.beforeInput.length, 0);
    assertEquals(layout.afterInput.length, 0);
    assertEquals(layout.cursor.row, expected.cursor);
    assertEquals(
      layout.log.length + layout.input.length + layout.footer.length,
      rows,
    );
  }
});

Deno.test('conversation cursor cells match ASCII, Japanese, mid-line, and wrapping', () => {
  const make = (text: string, cursorScalar: number, columns = 80) =>
    layoutUi(
      reduceUiEvent(
        createUiState({
          text,
          cursorScalar,
          byteLength: new TextEncoder().encode(text).byteLength,
        }),
        { kind: 'lifecycle', lifecycle: 'idle', generation: 0 },
      ),
      columns,
      24,
    );
  const mid = make('ab日本語', 3);
  assertEquals(mid.input, [{ text: 'ab日本語', kind: 'input' }]);
  assertEquals(mid.cursor.cell, 6); // prompt (2) + "ab日" (4)

  const endText = '1'.repeat(77);
  const end = make(endText, endText.length);
  assertEquals(end.input.length, 1);
  assertEquals(end.cursor.cell, 79); // prompt (2) + 77 editor cells

  const wrappedText = `${'a'.repeat(75)}日本語x`;
  const wrapped = make(wrappedText, [...wrappedText].length);
  assertEquals(wrapped.input.map((row) => row.text), [
    `${'a'.repeat(75)}日`,
    '本語x',
  ]);
  assertEquals(
    wrapped.cursor.row,
    wrapped.log.length + wrapped.beforeInput.length + 1,
  );
  assertEquals(wrapped.cursor.cell, 7); // prompt (2) + "本語x" (5 cells)
});

Deno.test('conversation failure display is short and keeps diagnostic readback elsewhere', () => {
  const diagnosticId = '22222222-2222-4222-8222-222222222222';
  const state = reduceUiEvent(createUiState(), {
    kind: 'failure_diagnostic',
    turn: 1,
    diagnostic: {
      schemaVersion: 1,
      diagnosticId,
      stage: 'response_parse',
      code: 'response_error',
      lane: 'parent',
      providerRequestCount: 1,
      occurredAt: '2026-09-02T00:00:00.000Z',
      turnNumber: 1,
      modelStep: 1,
      retryCount: 0,
    },
    durable: 'yes',
  });
  assertEquals(state.log.entries[0].text, 'provider response invalid');
  assert(!state.log.entries[0].text.includes(diagnosticId));
  assert(!state.log.entries[0].text.includes('readback>'));

  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal, { retained: true });
  renderer.eventSink({
    kind: 'failure_diagnostic',
    turn: 1,
    diagnostic: {
      schemaVersion: 1,
      diagnosticId,
      stage: 'response_parse',
      code: 'response_error',
      lane: 'parent',
      providerRequestCount: 1,
      occurredAt: '2026-09-02T00:00:00.000Z',
      turnNumber: 1,
      modelStep: 1,
      retryCount: 0,
    },
    durable: 'yes',
  });
  const frame = renderer.renderFrame();
  assert(frame.includes('failure> provider response invalid'));
  assert(!frame.includes(diagnosticId));
  assert(!frame.includes('diagnostics show'));

  const cancelled = reduceUiEvent(createUiState(), {
    kind: 'failure_diagnostic',
    turn: 1,
    diagnostic: {
      schemaVersion: 1,
      diagnosticId: '33333333-3333-4333-8333-333333333333',
      stage: 'cancellation_cleanup',
      code: 'turn_cancelled',
      lane: 'parent',
      providerRequestCount: 1,
      occurredAt: '2026-09-02T00:00:00.000Z',
      turnNumber: 1,
      modelStep: 1,
      retryCount: 0,
    },
    durable: 'yes',
  });
  assertEquals(cancelled.log.entries[0].text, 'cancelled');
});
