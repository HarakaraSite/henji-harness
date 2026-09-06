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
  assertEquals(state.log.entries.map((entry) => entry.label), ['user>', 'assistant>']);
  assert(!state.log.entries.some((entry) => /requests>|evidence>|readback>/.test(entry.text)));
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
    call: { callId: 'bash-2', name: 'bash', arguments: { command: 'long-running' } },
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
    message: { role: 'assistant', content: { kind: 'text', text: 'final answer' } },
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
  const footer = layoutUi(state, 80, 24).footer.text;
  assert(footer.includes('ready'));
  assert(footer.includes('agent default'));
  assert(footer.includes('session abcdef12 · turn 3'));
  assert(footer.includes('cwd /tmp/workspace'));
  assert(!footer.includes('F1 help'));
  assert(!footer.includes('turn 0'));
  assertEquals((footer.match(/agent default/g) ?? []).length, 1);
  assertEquals((footer.match(/session abcdef12/g) ?? []).length, 1);

  const contextRich = reduceUiAction(state, {
    kind: 'status',
    text:
      'session abcdef12 · agent default · turn 3 · ready · context through turn 3 · retain 2+ · semantic ≤123456B · ctx ≤64K/64K est · 4 omitted',
  });
  const contextFooter = layoutUi(contextRich, 80, 24).footer.text;
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
  const narrowFooter = layoutUi(narrow, 40, 24).footer.text;
  assert(narrowFooter.includes('cwd …'));
  assert(narrowFooter.includes('forgejo-agent'));
  assert(!narrowFooter.includes('F1 help'));

  const cancelling = reduceUiAction(narrow, {
    kind: 'status',
    text: 'cancelling context compaction; Ctrl-C again to discard and exit',
  });
  for (const columns of [40, 80]) {
    const cancellingFooter = layoutUi(cancelling, columns, 24).footer.text;
    assert(cancellingFooter.includes('cancelling'));
    assert(cancellingFooter.includes('cwd …/forgejo-agent'));
    assert(cancellingFooter.length <= columns);
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
  assertEquals(wrapped.input.map((row) => row.text), [`${'a'.repeat(75)}日`, '本語x']);
  assertEquals(wrapped.cursor.row, wrapped.log.length + 1);
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
