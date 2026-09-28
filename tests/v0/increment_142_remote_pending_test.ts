import { deepStrictEqual, strictEqual } from 'node:assert';
import type { CoreOperationName, ExecutionView, SessionSnapshot } from '../../v0/api/contract.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const encoder = new TextEncoder();
const sessionId = '14200000-0000-4000-8000-000000000001';
const executionId = '14200000-0000-4000-8000-000000000002';
const coreEpoch = 'increment-142-remote-tui';

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
  readonly pending?: SessionSnapshot['pending'];
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
      title: 'Increment 142 task Session',
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
  pending: options.pending ?? { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'unknown' },
  context: {},
});

const coreRead = {
  apiVersion: 1,
  coreEpoch,
  build,
  workspace: '/tmp/increment-142-workspace',
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

Deno.test('Increment 142 remote follow-up uses original receipt lookup, keeps new draft and reads Core reservation', async () => {
  const queueId = '14200000-0000-4000-8000-000000000003';
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let commandId = '';
  let queueCount = 0;
  let commandReads = 0;
  let taskCount = 0;
  let cancelCount = 0;
  let received: unknown;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const initial = snapshot({
    active: true,
    phase: 'running',
    currentExecution: execution('parent'),
    operations: ['execution.steer', 'followUp.queue', 'execution.cancel', 'command.read'],
  });
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/core') return Response.json(coreRead);
    if (path.endsWith('/events')) {
      return sseResponse((value) => {
        controller = value;
        sendSnapshot(value, initial);
      });
    }
    if (path.endsWith('/tasks')) taskCount++;
    if (path.endsWith('/cancel')) cancelCount++;
    if (request.method === 'POST' && path.endsWith('/follow-up')) {
      queueCount++;
      const input = await request.json();
      received = input;
      commandId = input.commandId;
      await gate;
      sendSnapshot(
        controller,
        snapshot({
          active: true,
          phase: 'running',
          revision: 5,
          currentExecution: execution('parent'),
          operations: ['execution.steer', 'execution.cancel', 'command.read'],
          pending: {
            kind: 'core-owned',
            followUps: [],
            followUp: {
              queueId,
              commandId,
              sessionId,
              afterExecutionId: executionId,
              text: input.text,
              status: 'queued',
            },
          },
        }),
      );
      return Response.json({ error: { message: 'receipt lost after reservation' } }, {
        status: 502,
      });
    }
    if (path === `/api/v1/commands/${commandId}`) {
      commandReads++;
      return Response.json({
        kind: 'accepted',
        commandId,
        target: { kind: 'session', sessionId },
        cursor: { coreEpoch, sessionId, revision: 5 },
        value: { queueId },
      });
    }
    return new Response('not found', { status: 404 });
  });
  const terminal = new FakeTerminal();
  let newer = false;
  let released = false;
  let detached = false;
  terminal.onWrite = (text) => {
    if (!newer && text.includes('awaiting receipt')) {
      newer = true;
      terminal.pushInput('new draft');
    }
    if (newer && !released && text.includes('> new draft')) {
      released = true;
      release();
    }
    if (!detached && commandReads > 0 && text.includes('accepted')) {
      detached = true;
      terminal.pushInput('\x04');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2000);
  try {
    strictEqual(
      await runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, {
        terminal,
        afterAcquire: () => terminal.pushInput('queued body\x1b\r'),
        writeStderr: (text) => {
          throw new Error(text);
        },
      }),
      0,
    );
    strictEqual(queueCount, 1);
    strictEqual(commandReads, 1);
    strictEqual(taskCount, 0);
    strictEqual(cancelCount, 0);
    deepStrictEqual(received, { commandId, text: 'queued body', afterExecutionId: executionId });
    strictEqual(detached, true);
    const rendered = terminal.output.join('');
    for (
      const value of ['new draft', 'follow-up queued', 'queued body', queueId, 'Ctrl-D detach']
    ) strictEqual(rendered.includes(value), true, value);
    strictEqual(terminal.raw, false);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});

Deno.test('Increment 142 busy Enter steers and reconnect shows discarded follow-up text and stopping reason', async () => {
  let steeringCount = 0;
  let taskCount = 0;
  let received: unknown;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const queueId = '14200000-0000-4000-8000-000000000004';
  const discarded = {
    queueId,
    commandId: 'discarded-command',
    sessionId,
    afterExecutionId: 'older-execution',
    text: 'Human decides whether to resend this retained body',
    status: 'discarded' as const,
    reason: 'cancelled',
  };
  const initial = snapshot({
    active: true,
    phase: 'running',
    currentExecution: execution('parent'),
    operations: ['execution.steer', 'followUp.queue', 'execution.cancel', 'command.read'],
    pending: { kind: 'core-owned', followUps: [discarded] },
  });
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/v1/core') return Response.json(coreRead);
    if (path.endsWith('/events')) {
      return sseResponse((value) => {
        controller = value;
        sendSnapshot(value, initial);
      });
    }
    if (path.endsWith('/tasks')) taskCount++;
    if (path === `/api/v1/sessions/${sessionId}/executions/${executionId}/steering`) {
      steeringCount++;
      const input = await request.json();
      received = input;
      sendSnapshot(
        controller,
        snapshot({
          active: true,
          phase: 'running',
          revision: 5,
          currentExecution: execution('parent'),
          operations: ['followUp.queue', 'execution.cancel', 'command.read'],
          pending: {
            kind: 'core-owned',
            followUps: [discarded],
            steering: { executionId, commandId: input.commandId, text: input.text },
          },
        }),
      );
      return Response.json({
        kind: 'accepted',
        commandId: input.commandId,
        target: { kind: 'execution', sessionId, executionId },
        cursor: { coreEpoch, sessionId, revision: 5 },
        value: { executionId },
      }, { status: 202 });
    }
    return new Response('not found', { status: 404 });
  });
  const terminal = new FakeTerminal();
  let detached = false;
  terminal.onWrite = (text) => {
    if (!detached && text.includes('steering accepted')) {
      detached = true;
      terminal.pushInput('\x04');
    }
  };
  const fallback = setTimeout(() => terminal.pushInput('\x04'), 2000);
  try {
    strictEqual(
      await runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, {
        terminal,
        afterAcquire: () => terminal.pushInput('steering body\r'),
        writeStderr: (text) => {
          throw new Error(text);
        },
      }),
      0,
    );
    strictEqual(steeringCount, 1);
    strictEqual(taskCount, 0);
    strictEqual((received as { text: string }).text, 'steering body');
    const rendered = terminal.output.join('');
    for (
      const value of [
        'follow-up discarded',
        'cancelled',
        queueId,
        discarded.text,
        'steering body',
        'Enter steer',
        'Alt-Enter queue',
      ]
    ) strictEqual(rendered.includes(value), true, value);
    strictEqual(detached, true);
  } finally {
    clearTimeout(fallback);
    await server.shutdown();
  }
});
