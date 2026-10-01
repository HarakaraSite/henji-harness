import { encodeScreenFrame, type ScreenFrame } from '../../v0/tui/terminal.ts';
import { deepStrictEqual, strictEqual } from 'node:assert';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const encoder = new TextEncoder();
const sessionId = '14000000-0000-4000-8000-000000000001';

const build = {
  schemaVersion: 1,
  productVersion: '0.1.0',
  buildId: 'a'.repeat(64),
  sourceRevision: 'remote-tui-test',
  sourceDirty: false,
  denoVersion: '2.9.7',
  target: 'x86_64-unknown-linux-gnu',
  embeddedRuntimeSha256: 'b'.repeat(64),
  supportedAgentDefinitionApiContracts: ['henji-agent-definition-v2'],
  supportedToolDefinitionApiContracts: ['henji-tool-definition-v1'],
};

const snapshot = {
  schemaVersion: 1,
  cursor: { coreEpoch: 'remote-test-epoch', sessionId, revision: 4 },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-09-27T00:00:00.000Z',
      title: 'Remote saved Session',
      agent: 'default',
      committedTurn: 1,
      messageCount: 2,
    },
    selection: {
      provider: 'openrouter-responses',
      modelId: 'test/model',
      effort: 'high',
    },
    startup: apiStartupFixture({ status: 'unevaluated' }),
  },
  runtime: {
    active: false,
    activeSessionId: null,
    phase: 'idle',
    execution: null,
    operations: [],
  },
  conversation: {
    messages: [
      {
        id: 'remote-user-1',
        executionId: 'remote-execution-1',
        turn: 1,
        role: 'user',
        text: 'What is in the saved note?',
      },
      {
        id: 'remote-assistant-1',
        executionId: 'remote-execution-1',
        turn: 1,
        role: 'assistant',
        text: 'The note says remote history is available.',
      },
    ],
    tools: [],
    thinking: [],
    executions: [],
    requests: [],
    omitted: 0,
  },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'unknown' },
  context: {},
};

class FakeTerminal implements TerminalPort {
  readonly output: string[] = [];
  readonly signals = new Map<string, () => void>();
  raw = false;
  onWrite?: (text: string) => void;
  private readonly input: Uint8Array[] = [];
  private pendingRead: ((value: Uint8Array | null) => void) | undefined;
  private readonly outputFailureHandlers = new Set<() => void>();

  stdinIsTerminal(): boolean {
    return true;
  }
  stdoutIsTerminal(): boolean {
    return true;
  }
  consoleSize(): { columns: number; rows: number } {
    return { columns: 80, rows: 24 };
  }
  setRaw(mode: boolean): void {
    this.raw = mode;
  }
  read(): Promise<Uint8Array | null> {
    const next = this.input.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve) => this.pendingRead = resolve);
  }
  pushInput(text: string): void {
    const bytes = encoder.encode(text);
    if (this.pendingRead !== undefined) {
      const resolve = this.pendingRead;
      this.pendingRead = undefined;
      resolve(bytes);
    } else this.input.push(bytes);
  }
  drainAndCloseInput(): Promise<void> {
    const resolve = this.pendingRead;
    this.pendingRead = undefined;
    resolve?.(null);
    return Promise.resolve();
  }
  writeFrame(frame: ScreenFrame, onWritten?: () => void): void {
    this.write(encodeScreenFrame(frame));
    onWritten?.();
  }

  write(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    this.output.push(text);
    this.onWrite?.(text);
  }
  addSignal(
    signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP',
    handler: () => void,
  ): void {
    this.signals.set(signal, handler);
  }
  removeSignal(
    signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP',
    handler: () => void,
  ): void {
    if (this.signals.get(signal) === handler) this.signals.delete(signal);
  }
  subscribeOutputFailure(handler: () => void): () => void {
    this.outputFailureHandlers.add(handler);
    return () => this.outputFailureHandlers.delete(handler);
  }
}

const coreRead = (activeSessionId: string | null) => ({
  apiVersion: 1,
  coreEpoch: 'remote-test-epoch',
  build,
  workspace: '/tmp/remote-workspace',
  activeSessionId,
  phase: 'idle',
  implementedOperations: [
    'core.read',
    'session.read',
    'session.subscribe',
    'task.submit',
    'execution.cancel',
    'execution.read',
    'command.read',
  ],
});

Deno.test('Increment 140 remote TUI renders the SSE snapshot and detaches without core mutation', async () => {
  const requests: { method: string; path: string }[] = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path });
      if (path === '/api/v1/core') return Response.json(coreRead(sessionId));
      if (path === `/api/v1/sessions/${sessionId}/events`) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ kind: 'session.snapshot', snapshot })}\n\n`,
            ));
          },
        });
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('unexpected remote TUI request', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  let stderr = '';
  let interaction = 0;
  terminal.onWrite = (text) => {
    if (interaction === 0 && text.includes('Remote saved Session')) {
      interaction = 1;
      terminal.pushInput('/help\r\r');
    } else if (
      interaction === 1 &&
      text.includes('help · PageUp/Down scroll · Esc return')
    ) {
      interaction = 2;
      terminal.pushInput('\x1b');
    } else if (
      interaction === 2 &&
      text.includes('The note says remote history is available.')
    ) {
      interaction = 3;
      terminal.pushInput('/detach\r\r');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2_000);
  try {
    const result = await runRemoteTui(
      `http://127.0.0.1:${server.addr.port}`,
      sessionId,
      {
        terminal,
        writeStderr: (text) => {
          stderr += text;
        },
      },
    );

    strictEqual(result, 0);
    strictEqual(interaction, 3);
    strictEqual(stderr, '');
    const rendered = terminal.output.join('');
    for (
      const text of [
        'Henji Harness v0.1.0',
        'context:          not evaluated',
        'skills:           not evaluated',
        '/tmp/remote-workspace',
        'Remote saved Session',
        'openrouter-responses',
        'test/model',
        'What is in the saved note?',
        'The note says remote history is available.',
        'READ-ONLY',
        'List sessions │ /sessions │ F1',
        'PageUp/Down scroll',
        'help · PageUp/Down scroll · Esc return',
        'Ctrl-D',
        'none',
      ]
    ) {
      if (!rendered.includes(text)) {
        throw new Error(`remote TUI output omitted ${text}`);
      }
    }
    strictEqual(terminal.raw, false);
    strictEqual(terminal.signals.size, 0);
    strictEqual(rendered.includes('\x1b[?1049l'), true);
    deepStrictEqual(requests, [
      { method: 'GET', path: '/api/v1/core' },
      { method: 'GET', path: `/api/v1/sessions/${sessionId}/events` },
    ]);
    const stillReady = await fetch(
      `http://127.0.0.1:${server.addr.port}/api/v1/core`,
    );
    strictEqual(stillReady.status, 200);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('remote TUI refreshes header evaluation and title from a session-only update', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/core') return Response.json(coreRead(sessionId));
      if (path.endsWith('/events')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ kind: 'session.snapshot', snapshot })}\n\n`,
              ));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('unexpected request', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  let updated = false;
  terminal.onWrite = (text) => {
    if (
      !updated && text.includes('Updated title') &&
      text.includes('header-skill')
    ) {
      updated = true;
      strictEqual(text.includes('AGENTS.md'), true);
      strictEqual(text.includes('not evaluated'), false);
      terminal.pushInput('\x04');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2_000);
  try {
    strictEqual(
      await runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, {
        terminal,
        afterAcquire: () => {
          stream.enqueue(encoder.encode(`data: ${
            JSON.stringify({
              kind: 'session.update',
              previousRevision: 4,
              cursor: { ...snapshot.cursor, revision: 5 },
              changes: [{
                kind: 'session.replace',
                session: {
                  ...snapshot.session,
                  position: {
                    ...snapshot.session.position,
                    title: 'Updated title',
                  },
                  startup: apiStartupFixture({
                    instructions: { loaded: true, source: 'AGENTS.md' },
                    skills: { count: 1, names: ['header-skill'], omitted: 0 },
                  }),
                },
              }],
            })
          }\n\n`));
        },
      }),
      0,
    );
    strictEqual(updated, true);
    strictEqual(
      terminal.output.join('').includes(
        'The note says remote history is available.',
      ),
      true,
    );
  } finally {
    clearTimeout(fallback);
    terminal.pushInput('\x04');
    await server.shutdown();
  }
});

Deno.test('Increment 140 remote TUI explains a missing active Session without acquiring the terminal', async () => {
  const requests: string[] = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      requests.push(new URL(request.url).pathname);
      return Response.json(coreRead(null));
    },
  );
  const terminal = new FakeTerminal();
  let stderr = '';
  try {
    const result = await runRemoteTui(
      `http://127.0.0.1:${server.addr.port}`,
      undefined,
      {
        terminal,
        writeStderr: (text) => {
          stderr += text;
        },
      },
    );
    strictEqual(result, 1);
    strictEqual(
      stderr,
      'core has no active Session; open a Session through API or specify --session\n',
    );
    deepStrictEqual(requests, ['/api/v1/core']);
    strictEqual(terminal.output.length, 0);
    strictEqual(terminal.raw, false);
  } finally {
    await server.shutdown();
  }
});

Deno.test('Increment 140 remote TUI keeps disconnected status after read-only input', async () => {
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      if (new URL(request.url).pathname === '/api/v1/core') {
        return Response.json(coreRead(sessionId));
      }
      return new Response(
        `data: ${JSON.stringify({ kind: 'session.snapshot', snapshot })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  );
  const terminal = new FakeTerminal();
  const disconnectedOutput: string[] = [];
  let disconnected = false;
  let detachQueued = false;
  terminal.onWrite = (text) => {
    if (!disconnected && text.includes('DISCONNECTED')) {
      disconnected = true;
      terminal.pushInput('hello\r');
    } else if (disconnected) {
      disconnectedOutput.push(text);
      if (!detachQueued) {
        detachQueued = true;
        terminal.pushInput('\x04');
      }
    }
  };
  try {
    strictEqual(
      await runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, {
        terminal,
        writeStderr: (text) => {
          throw new Error(text);
        },
      }),
      0,
    );
    strictEqual(disconnected, true);
    strictEqual(detachQueued, true);
    strictEqual(disconnectedOutput.join('').includes('READ-ONLY'), false);
    strictEqual(disconnectedOutput.join('').includes('DISCONNECTED'), true);
  } finally {
    await server.shutdown();
  }
});
