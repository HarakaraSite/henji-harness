import { encodeScreenFrame, type ScreenFrame } from '../../v0/tui/terminal.ts';
import { deepStrictEqual, strictEqual } from 'node:assert';
import type { CoreOperationName, ExecutionView, SessionSnapshot } from '../../v0/api/contract.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const encoder = new TextEncoder();
const sessionId = '14100000-0000-4000-8000-000000000001';
const executionId = '14100000-0000-4000-8000-000000000002';
const coreEpoch = 'increment-141-remote-tui';

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

const execution = (
  task: string,
  submittedByCommandId?: string,
  lifecycle: ExecutionView['lifecycle'] = 'active',
  outcome: ExecutionView['outcome'] = 'unknown',
  adoption: ExecutionView['adoption'] = 'non_canonical',
  processSettlement: ExecutionView['processSettlement'] = 'running',
): ExecutionView => ({
  executionId,
  sessionId,
  task,
  turn: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
  ...(submittedByCommandId === undefined ? {} : { submittedByCommandId }),
  lifecycle,
  outcome,
  adoption,
  processSettlement,
  requestCount: 0,
  durability: {
    acknowledgement: 'durable',
    generationAvailability: 'available',
    diagnosticCapture: 'not_required',
    artifactCapture: 'not_required',
    contextCapture: 'none',
  },
});

const snapshot = (options: {
  readonly revision?: number;
  readonly active?: boolean;
  readonly phase?:
    | 'idle'
    | 'preparing'
    | 'running'
    | 'cancelling'
    | 'settling'
    | 'unavailable';
  readonly currentExecution?: ExecutionView | null;
  readonly operations?: readonly CoreOperationName[];
  readonly messages?: SessionSnapshot['conversation']['messages'];
} = {}): SessionSnapshot => ({
  schemaVersion: 1,
  cursor: {
    coreEpoch,
    sessionId,
    revision: options.revision ?? 4,
  },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-09-28T00:00:00.000Z',
      title: 'Increment 141 task Session',
      agent: 'default',
      committedTurn: 0,
      messageCount: options.messages?.length ?? 0,
    },
    selection: {
      provider: 'openrouter-responses',
      modelId: 'test/model',
      effort: 'high',
    },
    startup: apiStartupFixture(),
  },
  runtime: {
    active: options.active ?? false,
    activeSessionId: sessionId,
    phase: options.phase ?? 'idle',
    execution: options.currentExecution ?? null,
    operations: options.operations ?? ['task.submit', 'command.read'],
  },
  conversation: {
    messages: options.messages ?? [],
    tools: [],
    thinking: [],
    requests: [],
    omitted: 0,
  },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'unknown' },
  context: {},
});

const coreRead = {
  apiVersion: 1,
  coreEpoch,
  build,
  workspace: '/tmp/increment-141-workspace',
  activeSessionId: sessionId,
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
};

class FakeTerminal implements TerminalPort {
  readonly output: string[] = [];
  readonly frames: ScreenFrame[] = [];
  readonly signals = new Map<string, () => void>();
  raw = false;
  onWrite?: (text: string) => void;
  private readonly input: Uint8Array[] = [];
  private pendingRead: ((value: Uint8Array | null) => void) | undefined;

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
    this.frames.push(frame);
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
  subscribeOutputFailure(_handler: () => void): () => void {
    return () => {};
  }
}

const sseResponse = (
  onController: (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ) => void,
): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        onController(controller);
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const sendSnapshot = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  value: SessionSnapshot,
): void => {
  controller.enqueue(
    encoder.encode(
      `data: ${JSON.stringify({ kind: 'session.snapshot', snapshot: value })}\n\n`,
    ),
  );
};

Deno.test('Increment 141 remote TUI submits once, preserves newer draft, and detaches without cancel', async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let taskText: unknown;
  let taskCount = 0;
  let commandReadCount = 0;
  let submittedCommandId = '';
  let cancelCount = 0;
  let releaseSubmit!: () => void;
  const submitGate = new Promise<void>((resolve) => releaseSubmit = resolve);
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/api/v1/core') {
        return Response
          .json(coreRead);
      }
      if (
        request.method === 'GET' &&
        path === `/api/v1/sessions/${sessionId}/events`
      ) {
        return sseResponse((controller) => {
          streamController = controller;
          sendSnapshot(controller, snapshot());
        });
      }
      if (
        request.method === 'POST' &&
        path === `/api/v1/sessions/${sessionId}/tasks`
      ) {
        taskCount += 1;
        const body = await request.json() as {
          commandId: string;
          text: string;
        };
        taskText = body.text;
        submittedCommandId = body.commandId;
        await submitGate;
        if (streamController === undefined) {
          throw new Error('SSE controller was not initialized');
        }
        sendSnapshot(
          streamController,
          snapshot({
            revision: 5,
            active: true,
            phase: 'running',
            currentExecution: execution(body.text, body.commandId),
            operations: ['execution.cancel', 'execution.read', 'command.read'],
            messages: [{
              id: 'increment-141-user-message',
              executionId,
              turn: 1,
              role: 'user',
              text: body.text,
            }],
          }),
        );
        return Response.json({
          error: { message: 'response lost after admission' },
        }, {
          status: 500,
        });
      }
      if (
        request.method === 'GET' &&
        path === `/api/v1/commands/${submittedCommandId}`
      ) {
        commandReadCount += 1;
        if (commandReadCount === 1) {
          return Response.json({
            kind: 'processing',
            commandId: submittedCommandId,
          });
        }
        return Response.json({
          kind: 'accepted',
          commandId: submittedCommandId,
          target: { kind: 'session', sessionId },
          cursor: { coreEpoch, sessionId, revision: 5 },
          value: { executionId },
        });
      }
      if (path.endsWith('/cancel')) cancelCount += 1;
      return new Response('not found', { status: 404 });
    },
  );

  const terminal = new FakeTerminal();
  let typedNewDraft = false;
  let released = false;
  let detached = false;
  terminal.onWrite = (text) => {
    if (!typedNewDraft && text.includes('awaiting receipt')) {
      typedNewDraft = true;
      terminal.pushInput('new draft');
    }
    if (typedNewDraft && !released && text.includes('> new draft')) {
      released = true;
      releaseSubmit();
    }
    if (!detached && text.includes('accepted')) {
      detached = true;
      terminal.pushInput('\x04');
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
          throw new Error(text);
        },
        afterAcquire: () => terminal.pushInput('first task\r'),
      },
    );
    strictEqual(result, 0);
    strictEqual(taskCount, 1);
    strictEqual(commandReadCount, 2);
    strictEqual(taskText, 'first task');
    strictEqual(cancelCount, 0);
    strictEqual(detached, true);
    const rendered = terminal.output.join('');
    strictEqual(rendered.includes('first task'), true);
    strictEqual(rendered.includes('new draft'), true);
    strictEqual(rendered.includes('Ctrl-D detach'), true);
    strictEqual(rendered.includes('Esc cancel'), true);
    strictEqual(rendered.includes('working │ Esc cancel]'), false);
    strictEqual(terminal.raw, false);
    strictEqual(terminal.signals.size, 0);
    const stillRunning = await fetch(
      `http://127.0.0.1:${server.addr.port}/api/v1/core`,
    );
    strictEqual(stillRunning.status, 200);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('remote TUI clears busy drafts with Ctrl-C, cancels with Escape and detaches with Ctrl-D', async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancellations: {
    path: string;
    commandId: string;
    executionId: string;
  }[] = [];
  const initial = snapshot({
    active: true,
    phase: 'running',
    currentExecution: execution('running task'),
    operations: ['execution.cancel', 'execution.read', 'command.read'],
    messages: [{
      id: 'increment-141-running-user',
      executionId,
      turn: 1,
      role: 'user',
      text: 'running task',
    }],
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/api/v1/core') {
        return Response
          .json(coreRead);
      }
      if (
        request.method === 'GET' &&
        path === `/api/v1/sessions/${sessionId}/events`
      ) {
        return sseResponse((controller) => {
          streamController = controller;
          sendSnapshot(controller, initial);
        });
      }
      if (
        request.method === 'POST' &&
        path ===
          `/api/v1/sessions/${sessionId}/executions/${executionId}/cancel`
      ) {
        const body = await request.json() as { commandId: string };
        cancellations.push({ path, commandId: body.commandId, executionId });
        if (streamController === undefined) {
          throw new Error('SSE controller was not initialized');
        }
        sendSnapshot(
          streamController,
          snapshot({
            revision: 5,
            active: true,
            phase: 'cancelling',
            currentExecution: execution('running task'),
            operations: ['execution.cancel', 'execution.read', 'command.read'],
            messages: initial.conversation.messages,
          }),
        );
        return Response.json({
          kind: 'accepted',
          commandId: body.commandId,
          target: { kind: 'execution', sessionId, executionId },
          cursor: { coreEpoch, sessionId, revision: 5 },
          value: { executionId, result: 'requested' },
        }, { status: 202 });
      }
      return new Response('not found', { status: 404 });
    },
  );

  const terminal = new FakeTerminal();
  let detached = false;
  terminal.onWrite = (text) => {
    if (!detached && text.includes('cancel requested')) {
      detached = true;
      terminal.pushInput('\x04');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2_000);
  try {
    strictEqual(
      await runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, {
        terminal,
        writeStderr: (text) => {
          throw new Error(text);
        },
        afterAcquire: async () => {
          terminal.pushInput('draft to clear\x03\x03');
          await new Promise((resolve) => setTimeout(resolve, 80));
          strictEqual(cancellations.length, 0);
          strictEqual(terminal.raw, true);
          strictEqual(terminal.output.at(-1)?.includes('> draft to clear'), false);
          terminal.pushInput('\x1b');
        },
      }),
      0,
    );
    strictEqual(cancellations.length, 1);
    strictEqual(
      cancellations[0].path,
      `/api/v1/sessions/${sessionId}/executions/${executionId}/cancel`,
    );
    strictEqual(cancellations[0].executionId, executionId);
    strictEqual(cancellations[0].commandId.length > 0, true);
    strictEqual(detached, true);
    strictEqual(terminal.raw, false);
    deepStrictEqual([...terminal.signals.keys()], []);
    const rendered = terminal.output.join('');
    strictEqual(rendered.includes('Ctrl-C clear'), true);
    strictEqual(rendered.includes('Ctrl-D detach'), true);
    strictEqual(rendered.includes('Esc cancel'), true);
    strictEqual(rendered.includes('working │ Esc cancel]'), false);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('Increment 156 busy history Escape returns latest without cancelling and preserves draft and stream updates', async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancellations = 0;
  let current = snapshot({
    active: true,
    phase: 'running',
    currentExecution: execution('S15 running task'),
    operations: ['execution.cancel', 'execution.read', 'command.read'],
    messages: [{
      id: 's15-history',
      executionId,
      turn: 1,
      role: 'user',
      text: Array.from({ length: 60 }, (_, index) => `S15 history line ${index}`).join('\n'),
    }],
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/api/v1/core') {
        return Response.json(coreRead);
      }
      if (path === `/api/v1/sessions/${sessionId}/events`) {
        return sseResponse((controller) => {
          streamController = controller;
          sendSnapshot(controller, current);
        });
      }
      if (
        request.method === 'POST' &&
        path === `/api/v1/sessions/${sessionId}/executions/${executionId}/cancel`
      ) {
        const body = await request.json() as { commandId: string };
        cancellations += 1;
        current = snapshot({
          revision: 6,
          active: true,
          phase: 'cancelling',
          currentExecution: execution('S15 running task'),
          operations: ['execution.cancel', 'execution.read', 'command.read'],
          messages: current.conversation.messages,
        });
        sendSnapshot(streamController!, current);
        return Response.json({
          kind: 'accepted',
          commandId: body.commandId,
          target: { kind: 'execution', sessionId, executionId },
          cursor: current.cursor,
          value: { executionId, result: 'requested' },
        }, { status: 202 });
      }
      return new Response('not found', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  const screen = (): string => terminal.frames.at(-1)?.rows.join('\n') ?? '';
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for S15 TUI:\n${screen()}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  let driver: Promise<void> | undefined;
  let driverError: unknown;
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 5_000);
  try {
    strictEqual(
      await runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, {
        terminal,
        writeStderr: (text) => {
          throw new Error(text);
        },
        afterAcquire: () => {
          driver = (async () => {
            terminal.pushInput('S15 draft kept');
            await waitFor(() => screen().includes('> S15 draft kept'));
            terminal.pushInput('\x1b[5~');
            await waitFor(() => screen().includes('[history ') && screen().includes('Esc latest'));
            strictEqual(screen().includes('Esc cancel'), false);
            strictEqual(cancellations, 0);

            current = snapshot({
              revision: 5,
              active: true,
              phase: 'running',
              currentExecution: execution('S15 running task'),
              operations: ['execution.cancel', 'execution.read', 'command.read'],
              messages: [...current.conversation.messages, {
                id: 's15-new-below',
                executionId,
                turn: 1,
                role: 'assistant',
                text: 'S15 stream update',
              }],
            });
            sendSnapshot(streamController!, current);
            await waitFor(() => screen().includes('history record 1 of 2'));
            strictEqual(screen().includes('Esc latest'), true);
            terminal.pushInput('\x1bOP');
            await waitFor(() => screen().includes('read-only help'));
            terminal.pushInput('\x1b');
            await waitFor(() => screen().includes('[history ') && screen().includes('Esc latest'));
            strictEqual(cancellations, 0);

            terminal.pushInput('\x1b');
            await waitFor(() => !screen().includes('[history ') && screen().includes('Esc cancel'));
            strictEqual(cancellations, 0);
            strictEqual(screen().includes('S15 stream update'), true);
            strictEqual(screen().includes('> S15 draft kept'), true);

            terminal.pushInput('\x1b[5~');
            await waitFor(() => screen().includes('Esc latest'));
            terminal.pushInput('\x1b[6~');
            await waitFor(() => !screen().includes('[history ') && screen().includes('Esc cancel'));
            strictEqual(cancellations, 0);
            terminal.pushInput('\x1b');
            await waitFor(() => cancellations === 1);
            terminal.pushInput('\x04');
          })().catch((error) => {
            driverError = error;
            terminal.pushInput('\x04');
          });
        },
      }),
      0,
    );
    await driver;
    if (driverError !== undefined) throw driverError;
    strictEqual(cancellations, 1);
    strictEqual(terminal.raw, false);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('remote TUI clears drafts with Ctrl-C when reconnecting during cancellation', async () => {
  let cancellationCount = 0;
  const cancelling = snapshot({
    active: true,
    phase: 'cancelling',
    currentExecution: execution('cancelling task'),
    operations: ['execution.cancel', 'execution.read', 'command.read'],
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/core') return Response.json(coreRead);
      if (path === `/api/v1/sessions/${sessionId}/events`) {
        return sseResponse((controller) => sendSnapshot(controller, cancelling));
      }
      if (path.endsWith('/cancel')) cancellationCount += 1;
      return new Response('not found', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  let detached = false;
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2_000);
  try {
    strictEqual(
      await runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, {
        terminal,
        writeStderr: (text) => {
          throw new Error(text);
        },
        afterAcquire: async () => {
          terminal.pushInput('cancel-phase draft\x03\x03');
          await new Promise((resolve) => setTimeout(resolve, 80));
          strictEqual(terminal.raw, true);
          strictEqual(terminal.output.at(-1)?.includes('> cancel-phase draft'), false);
          detached = true;
          terminal.pushInput('\x04');
        },
      }),
      0,
    );
    strictEqual(detached, true);
    strictEqual(cancellationCount, 0);
    const rendered = terminal.output.join('');
    strictEqual(rendered.includes('cancelling'), true);
    strictEqual(rendered.includes('Ctrl-C clear'), true);
    strictEqual(rendered.includes('working │ Esc cancel]'), false);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('Increment 141 remote TUI keeps settled execution outcome and settlement visible', async () => {
  const settled = snapshot({
    currentExecution: execution(
      'cancelled task',
      undefined,
      'settled',
      'cancelled',
      'non_canonical',
      'complete',
    ),
    operations: ['task.submit'],
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/core') return Response.json(coreRead);
      if (path === `/api/v1/sessions/${sessionId}/events`) {
        return sseResponse((controller) => sendSnapshot(controller, settled));
      }
      return new Response('not found', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  let detached = false;
  terminal.onWrite = (text) => {
    if (!detached && text.includes('settlement complete')) {
      detached = true;
      terminal.pushInput('\x04');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2_000);
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
    strictEqual(detached, true);
    const rendered = terminal.output.join('');
    strictEqual(rendered.includes('cancelled'), true);
    strictEqual(rendered.includes('non-canonical'), true);
    strictEqual(rendered.includes('settlement complete'), true);
    strictEqual(rendered.includes('Enter submit'), true);
    strictEqual(rendered.includes('Ctrl-D detach'), true);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('Increment 141 remote TUI prioritizes an unconfirmed submit notice and keeps its draft', async () => {
  const settled = snapshot({
    currentExecution: execution(
      'cancelled task',
      undefined,
      'settled',
      'cancelled',
      'non_canonical',
      'unknown',
    ),
    operations: ['task.submit', 'command.read'],
  });
  let taskPostCount = 0;
  let commandReadCount = 0;
  let commandId = '';
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/api/v1/core') {
        return Response.json(coreRead);
      }
      if (
        request.method === 'GET' &&
        path === `/api/v1/sessions/${sessionId}/events`
      ) {
        return sseResponse((controller) => sendSnapshot(controller, settled));
      }
      if (
        request.method === 'POST' &&
        path === `/api/v1/sessions/${sessionId}/tasks`
      ) {
        taskPostCount += 1;
        commandId = (await request.json() as { commandId: string }).commandId;
        return Response.json(
          { error: { message: 'submit response lost before Core admission' } },
          { status: 502 },
        );
      }
      if (request.method === 'GET' && path === `/api/v1/commands/${commandId}`) {
        commandReadCount += 1;
        return Response.json(
          { error: { message: 'command not found' } },
          { status: 404 },
        );
      }
      return new Response('not found', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  let typedTask = false;
  let detached = false;
  terminal.onWrite = (text) => {
    if (!typedTask && text.includes('Enter submit')) {
      typedTask = true;
      terminal.pushInput('TUI notice probe\r');
    }
    if (!detached && text.includes('submission unconfirmed')) {
      detached = true;
      terminal.pushInput('\x04');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2_000);
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
    strictEqual(typedTask, true);
    strictEqual(taskPostCount, 1);
    strictEqual(commandReadCount, 1);
    strictEqual(detached, true);
    const rendered = terminal.output.join('');
    strictEqual(rendered.includes('submission unconfirmed'), true);
    strictEqual(rendered.includes('draft kept'), true);
    strictEqual(rendered.includes('TUI notice probe'), true);
    strictEqual(rendered.includes('Ctrl-D detach'), true);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('Increment 141 remote TUI shows preparing controls without advertising cancel', async () => {
  const preparing = snapshot({
    phase: 'preparing',
    operations: ['command.read'],
  });
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/v1/core') return Response.json(coreRead);
      if (path === `/api/v1/sessions/${sessionId}/events`) {
        return sseResponse((controller) => sendSnapshot(controller, preparing));
      }
      return new Response('not found', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  let detached = false;
  terminal.onWrite = (text) => {
    if (!detached && text.includes('task admission in progress')) {
      detached = true;
      terminal.pushInput('\x04');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2_000);
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
    strictEqual(detached, true);
    const rendered = terminal.output.join('');
    strictEqual(rendered.includes('preparing'), true);
    strictEqual(rendered.includes('Ctrl-D detach'), true);
    strictEqual(rendered.includes('Esc/Ctrl-C cancel'), false);
    strictEqual(rendered.includes('[⠋ working │ Esc cancel]'), false);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});
