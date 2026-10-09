import { TerminalScreen } from './terminal_screen_fixture.ts';
import { type ScreenFrame } from '../../v0/tui/terminal.ts';
import { deepStrictEqual, strictEqual } from 'node:assert';
import type { CoreOperationName, ExecutionView, SessionSnapshot } from '../../v0/api/contract.ts';
import {
  parseRemoteTuiInvocation,
  runRemoteTuiInvocation,
} from '../../v0/agent/cli/remote_tui_cli.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const encoder = new TextEncoder();
const activeSessionId = '14300000-0000-4000-8000-000000000001';
const savedSessionId = '14300000-0000-4000-8000-000000000002';
const executionId = '14300000-0000-4000-8000-000000000003';
const coreEpoch = 'increment-143-remote-session';

const build = {
  schemaVersion: 1,
  productVersion: '0.1.0',
  buildId: 'a'.repeat(64),
  sourceRevision: 'remote-session-test',
  sourceDirty: false,
  denoVersion: '2.9.7',
  target: 'x86_64-unknown-linux-gnu',
  embeddedRuntimeSha256: 'b'.repeat(64),
  agentConfigurationSchemaVersion: 1,
  supportedToolApiContracts: ['henji-tool/v1'],
  supportedHookApiContracts: ['henji-hooks/v1'],
};

const effectiveConfig = {
  configuration: {
    status: 'ready',
    name: 'generic',
    choice: { name: 'generic' },
    revision: '1',
    configurationId: 'fixture-configuration',
  },
  maxSteps: 4,
  maxStepsSource: 'activation' as const,
  providerTimeoutMs: 30_000,
  activation: { agent: 'generic', maxSteps: 4, providerTimeoutMs: 30_000 },
};

const activeExecution: ExecutionView = {
  executionId,
  sessionId: activeSessionId,
  task: 'long running task',
  turn: 1,
  createdAt: '2026-09-28T00:00:00.000Z',
  lifecycle: 'active',
  outcome: 'unknown',
  adoption: 'non_canonical',
  processSettlement: 'running',
  requestCount: 1,
  durability: {
    acknowledgement: 'durable',
    generationAvailability: 'available',
    diagnosticCapture: 'not_required',
    artifactCapture: 'not_required',
    contextCapture: 'none',
  },
};

const snapshot = (
  sessionId: string,
  options: {
    readonly title: string;
    readonly activeSessionId?: string;
    readonly busy?: boolean;
    readonly message?: string;
  },
): SessionSnapshot => ({
  schemaVersion: 3,
  cursor: { coreEpoch, sessionId, revision: 4 },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-09-27T00:00:00.000Z',
      title: options.title,
      agent: 'generic',
      committedTurn: options.message === undefined ? 0 : 1,
      messageCount: options.message === undefined ? 0 : 1,
    },
    selection: {
      provider: 'openrouter-responses',
      modelId: 'test/model',
      effort: 'high',
    },
    startup: apiStartupFixture({ agentId: 'generic' }),
  },
  runtime: {
    active: options.busy ?? false,
    activeSessionId: options.activeSessionId ?? activeSessionId,
    phase: options.busy ? 'running' : 'idle',
    execution: options.busy ? activeExecution : null,
    operations: options.activeSessionId === sessionId || sessionId === activeSessionId
      ? [
        'task.submit',
        'execution.cancel',
        'session.rename',
        'recall.prepare',
        'recall.clear',
        'context.read',
      ]
      : [],
    ...(options.activeSessionId === sessionId || sessionId === activeSessionId
      ? { effectiveConfig }
      : {}),
  },
  conversation: {
    schemaVersion: 3,
    sessionId,
    cut: 0,
    storeRevision: 0,
    page: { direction: 'latest' as const, hasOlder: false, hasNewer: false },
    entities: options.message === undefined ? {} : {
      [`message-${sessionId}`]: {
        kind: 'message',
        id: `message-${sessionId}`,
        executionId,
        turn: 1,
        role: 'assistant',
        text: options.message,
        complete: true,
        version: 1,
        position: { executionOrder: 0, requestOrder: 0, phase: 1, eventOrdinal: 1, itemOrdinal: 0 },
      },
    },
    order: options.message === undefined ? [] : [`message-${sessionId}`],
  },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'unknown' },
  context: {},
});

const activeSnapshot = snapshot(activeSessionId, {
  title: 'Active Session A',
  busy: true,
});
const savedSnapshot = snapshot(savedSessionId, {
  title: 'Saved Session B',
  message: 'Saved B conversation marker',
});
const activeIdleSnapshot = snapshot(activeSessionId, {
  title: 'Active Session A',
});
const resumedSnapshot = snapshot(savedSessionId, {
  title: 'Saved Session B',
  activeSessionId: savedSessionId,
  message: 'Saved B conversation marker',
});

const coreRead = {
  apiVersion: 1,
  conversationSchema: 3,
  coreEpoch,
  build,
  workspace: '/tmp/increment-143-remote-workspace',
  activeSessionId,
  phase: 'running',
  implementedOperations: [
    'core.read',
    'session.list',
    'session.open',
    'session.rename',
    'session.read',
    'session.subscribe',
    'task.submit',
    'execution.cancel',
    'recall.prepare',
    'recall.clear',
    'context.read',
    'command.read',
  ] satisfies readonly CoreOperationName[],
};

class FakeTerminal implements TerminalPort {
  readonly output: string[] = [];
  frame: ScreenFrame | undefined;
  readonly signals = new Map<string, () => void>();
  raw = false;
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
  drainAndCloseInput(_maxMs: number, _idleMs: number): Promise<void> {
    const resolve = this.pendingRead;
    this.pendingRead = undefined;
    resolve?.(null);
    return Promise.resolve();
  }
  pushInput(text: string): void {
    const bytes = encoder.encode(text);
    if (this.pendingRead !== undefined) {
      const resolve = this.pendingRead;
      this.pendingRead = undefined;
      resolve(bytes);
    } else this.input.push(bytes);
  }

  private readonly screen = new TerminalScreen();
  write(bytes: Uint8Array): void {
    const size = this.consoleSize();
    this.screen.resize(size.columns, size.rows);
    this.screen.write(bytes);
    this.frame = this.screen.frame();
    this.output.push(new TextDecoder().decode(bytes));
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
  text(): string {
    return this.output.join('');
  }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for remote TUI behavior');
};

const occurrences = (text: string, value: string): number => text.split(value).length - 1;

const sseResponse = (value: SessionSnapshot): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ kind: 'session.snapshot', snapshot: value })}\n\n`,
        ));
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const sessionList = (ids: readonly string[]) => ({
  sessions: ids.map((id) => ({
    id,
    agent: 'generic',
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    title: id === activeSessionId ? 'Active Session A' : 'Saved Session B',
    committedTurn: id === savedSessionId ? 1 : 0,
    messageCount: id === savedSessionId ? 1 : 0,
    persistence: 'persistent',
    runtime: { active: id === activeSessionId, phase: 'idle' },
  })),
});

const startServer = (
  handler: (request: Request) => Response | Promise<Response>,
) =>
  Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    handler,
  );

const accepted = (
  commandId: string,
  sessionId: string,
  value: unknown,
): Response =>
  Response.json({
    kind: 'accepted',
    commandId,
    target: { kind: 'session', sessionId },
    value,
  });

Deno.test('Increment 143 slash operations and context overlay do not submit or cancel busy work', async () => {
  let renameBody: Record<string, unknown> | undefined;
  let recallBody: Record<string, unknown> | undefined;
  let contextReads = 0;
  let taskSubmissions = 0;
  let cancellations = 0;
  const server = startServer(async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/api/v1/core') {
      return Response.json(coreRead);
    }
    if (request.method === 'GET' && pathname.endsWith('/events')) {
      return sseResponse(activeSnapshot);
    }
    if (request.method === 'POST' && pathname.endsWith('/title')) {
      const body = await request.json() as Record<string, unknown>;
      renameBody = body;
      return accepted(String(body.commandId), activeSessionId, {
        result: 'renamed',
      });
    }
    if (request.method === 'POST' && pathname.endsWith('/recall')) {
      const body = await request.json() as Record<string, unknown>;
      recallBody = body;
      return accepted(String(body.commandId), activeSessionId, {
        action: 'prepare',
        sourceExecutionId: executionId,
        evidence: 'available',
      });
    }
    if (request.method === 'GET' && pathname.endsWith('/context')) {
      contextReads += 1;
      return Response.json({
        context: {
          checkpoint: {
            summary: 'Context checkpoint marker',
            coveredThroughTurn: 2,
            retainedFromTurn: 3,
          },
          pendingRecall: {
            sourceExecutionId: executionId,
            evidence: 'available',
          },
          latestRequest: {
            executionId,
            requestOrdinal: 8,
            lane: 'parent',
            purpose: 'reply',
            modelStep: 4,
            itemCount: 5,
          },
        },
      });
    }
    if (request.method === 'POST' && pathname.endsWith('/tasks')) {
      taskSubmissions += 1;
    }
    if (request.method === 'POST' && pathname.endsWith('/cancel')) {
      cancellations += 1;
    }
    return new Response('unexpected TUI request', { status: 404 });
  });
  const terminal = new FakeTerminal();
  const run = runRemoteTui(
    `http://127.0.0.1:${server.addr.port}`,
    activeSessionId,
    {
      terminal,
    },
  );
  try {
    await waitFor(() => terminal.text().includes('Active Session A'));
    terminal.pushInput('/rename Slice 5 title\r');
    await waitFor(() =>
      renameBody !== undefined &&
      !(terminal.frame?.rows.join('\n') ?? '').includes('renaming Session')
    );
    deepStrictEqual(renameBody?.title, 'Slice 5 title');

    terminal.pushInput('/recall latest\r');
    await waitFor(() => recallBody !== undefined);
    deepStrictEqual(recallBody?.action, 'prepare');
    strictEqual(recallBody?.executionId, undefined);

    terminal.pushInput('/context\r\r');
    await waitFor(() =>
      contextReads === 1 &&
      terminal.text().includes('Context checkpoint marker') &&
      terminal.text().includes('provider timeout 30000ms')
    );
    terminal.pushInput('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 80));
    terminal.pushInput('\x04');

    strictEqual(await run, 0);
    strictEqual(contextReads, 1);
    strictEqual(taskSubmissions, 0);
    strictEqual(cancellations, 0);
    strictEqual(terminal.raw, false);
  } finally {
    terminal.pushInput('\x04');
    await run;
    await server.shutdown();
  }
});

Deno.test('Increment 143 F4 picker Enter views a saved Session without changing the active slot', async () => {
  let lists = 0;
  let savedReads = 0;
  let savedSubscriptions = 0;
  let opens = 0;
  let taskSubmissions = 0;
  let cancellations = 0;
  let activeSlot = activeSessionId;
  const server = startServer((request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/api/v1/core') {
      return Response.json({ ...coreRead, activeSessionId: activeSlot });
    }
    if (request.method === 'GET' && pathname === '/api/v1/sessions') {
      lists += 1;
      return Response.json(sessionList([activeSessionId, savedSessionId]));
    }
    if (
      request.method === 'GET' &&
      pathname === `/api/v1/sessions/${savedSessionId}`
    ) {
      savedReads += 1;
      return Response.json(savedSnapshot);
    }
    if (request.method === 'GET' && pathname.endsWith('/events')) {
      if (pathname.includes(savedSessionId)) {
        savedSubscriptions += 1;
        return sseResponse(savedSnapshot);
      }
      return sseResponse(activeSnapshot);
    }
    if (request.method === 'POST' && pathname.endsWith('/open')) {
      opens += 1;
      activeSlot = savedSessionId;
    }
    if (request.method === 'POST' && pathname.endsWith('/tasks')) {
      taskSubmissions += 1;
    }
    if (request.method === 'POST' && pathname.endsWith('/cancel')) {
      cancellations += 1;
    }
    return new Response('unexpected TUI request', { status: 404 });
  });
  const terminal = new FakeTerminal();
  const run = runRemoteTui(
    `http://127.0.0.1:${server.addr.port}`,
    activeSessionId,
    {
      terminal,
    },
  );
  try {
    await waitFor(() => terminal.text().includes('Active Session A'));
    terminal.pushInput('\x1b[14~');
    await waitFor(() => lists === 1 && terminal.text().includes('Saved Session B'));
    terminal.pushInput('\x1b[B\r');
    await waitFor(() =>
      savedReads === 1 && savedSubscriptions === 1 &&
      terminal.text().includes('Saved B conversation marker')
    );
    terminal.pushInput('\x04');

    strictEqual(await run, 0);
    strictEqual(opens, 0);
    strictEqual(taskSubmissions, 0);
    strictEqual(cancellations, 0);
    const coreAfterView = await fetch(
      `http://127.0.0.1:${server.addr.port}/api/v1/core`,
    )
      .then((response) => response.json());
    strictEqual(coreAfterView.activeSessionId, activeSessionId);
  } finally {
    terminal.pushInput('\x04');
    await run;
    await server.shutdown();
  }
});

Deno.test('Increment 143 /sessions picker R explicitly resumes the selected saved Session', async () => {
  let lists = 0;
  let openBody: Record<string, unknown> | undefined;
  let savedSubscriptions = 0;
  let taskSubmissions = 0;
  let cancellations = 0;
  let activeSlot = activeSessionId;
  const server = startServer(async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/api/v1/core') {
      return Response.json({
        ...coreRead,
        activeSessionId: activeSlot,
        phase: 'idle',
      });
    }
    if (request.method === 'GET' && pathname === '/api/v1/sessions') {
      lists += 1;
      return Response.json(sessionList([savedSessionId]));
    }
    if (
      request.method === 'GET' &&
      pathname === `/api/v1/sessions/${savedSessionId}`
    ) {
      return Response.json(savedSnapshot);
    }
    if (request.method === 'POST' && pathname === '/api/v1/sessions/open') {
      openBody = await request.json() as Record<string, unknown>;
      activeSlot = savedSessionId;
      return accepted(String(openBody.commandId), savedSessionId, {
        sessionId: savedSessionId,
      });
    }
    if (request.method === 'GET' && pathname.endsWith('/events')) {
      if (pathname.includes(savedSessionId)) {
        savedSubscriptions += 1;
        return sseResponse(
          activeSlot === savedSessionId ? resumedSnapshot : savedSnapshot,
        );
      }
      return sseResponse(activeIdleSnapshot);
    }
    if (request.method === 'GET' && pathname.endsWith('/context')) {
      return Response.json({ context: {} });
    }
    if (request.method === 'POST' && pathname.endsWith('/tasks')) {
      taskSubmissions += 1;
    }
    if (request.method === 'POST' && pathname.endsWith('/cancel')) {
      cancellations += 1;
    }
    return new Response('unexpected TUI request', { status: 404 });
  });
  const terminal = new FakeTerminal();
  const run = runRemoteTui(
    `http://127.0.0.1:${server.addr.port}`,
    activeSessionId,
    {
      terminal,
    },
  );
  try {
    await waitFor(() => terminal.text().includes('Active Session A'));
    terminal.pushInput('/sessions\r\r');
    await waitFor(() => lists === 1 && terminal.text().includes('Saved Session B'));
    terminal.pushInput('\r');
    await waitFor(() =>
      savedSubscriptions === 1 &&
      terminal.text().includes('Saved B conversation marker')
    );
    const previousPickerRows = occurrences(
      terminal.text(),
      'Saved Session B ·',
    );
    terminal.pushInput('/sessions\r\r');
    await waitFor(() =>
      lists === 2 &&
      occurrences(terminal.text(), 'Saved Session B ·') > previousPickerRows
    );
    terminal.pushInput('r');
    await waitFor(() => openBody !== undefined && savedSubscriptions === 2);
    deepStrictEqual(openBody?.selection, {
      kind: 'exact',
      sessionId: savedSessionId,
    });
    strictEqual(openBody?.fromSessionId, undefined);
    terminal.pushInput('/context\r\r');
    await waitFor(() => terminal.text().includes('provider timeout 30000ms'));
    terminal.pushInput('\x04');

    strictEqual(await run, 0);
    strictEqual(taskSubmissions, 0);
    strictEqual(cancellations, 0);
    const coreAfterResume = await fetch(
      `http://127.0.0.1:${server.addr.port}/api/v1/core`,
    ).then((response) => response.json());
    strictEqual(coreAfterResume.activeSessionId, savedSessionId);
  } finally {
    terminal.pushInput('\x04');
    await run;
    await server.shutdown();
  }
});

Deno.test('Increment 143 CLI attach compares activation against the effective external Agent file', async () => {
  const agentFile = '/tmp/managed-profile.json';
  const managedSnapshot: SessionSnapshot = {
    ...activeIdleSnapshot,
    session: {
      ...activeIdleSnapshot.session,
      position: {
        ...activeIdleSnapshot.session.position,
        // The record role does not identify its actual managed Definition.
        agent: 'default',
      },
    },
    runtime: {
      ...activeIdleSnapshot.runtime,
      effectiveConfig: {
        ...effectiveConfig,
        configuration: {
          status: 'ready',
          name: 'managed-profile',
          choice: { file: agentFile },
          revision: 'same-label',
          configurationId: 'fixture-configuration',
        },
        // A server-created slot may not include the original CLI selector.
        activation: {},
      },
    },
  };
  let sessionReads = 0;
  let events = 0;
  let providerCalls = 0;
  const server = startServer((request) => {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/api/v1/core') {
      return Response.json({ ...coreRead, phase: 'idle' });
    }
    if (
      request.method === 'GET' &&
      pathname === `/api/v1/sessions/${activeSessionId}`
    ) {
      sessionReads += 1;
      return Response.json(managedSnapshot);
    }
    if (request.method === 'GET' && pathname.endsWith('/events')) {
      events += 1;
      return sseResponse(managedSnapshot);
    }
    providerCalls += 1;
    return new Response('unexpected provider or TUI request', { status: 404 });
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  const mismatchTerminal = new FakeTerminal();
  let mismatchStderr = '';
  try {
    const mismatch = parseRemoteTuiInvocation([
      '--connect',
      url,
      '--agent',
      'default',
    ]);
    strictEqual(
      await runRemoteTuiInvocation(mismatch, {
        terminal: mismatchTerminal,
        writeStderr: (text) => {
          mismatchStderr += text;
        },
      }),
      1,
    );
    strictEqual(mismatchTerminal.output.length, 0);
    strictEqual(
      mismatchStderr.includes(
        '--agent requested default, active managed-profile',
      ),
      true,
    );

    const matchTerminal = new FakeTerminal();
    const matching = parseRemoteTuiInvocation([
      '--connect',
      url,
      '--agent-file',
      agentFile,
    ]);
    strictEqual(
      await runRemoteTuiInvocation(matching, {
        terminal: matchTerminal,
        afterAcquire: () => matchTerminal.pushInput('\x04'),
      }),
      0,
    );
    strictEqual(sessionReads, 2);
    strictEqual(events, 1);
    strictEqual(providerCalls, 0);
  } finally {
    await server.shutdown();
  }
});

Deno.test('Increment 159 slash picker completes before execution and closes without cancelling', async () => {
  const renames: Record<string, unknown>[] = [];
  let cancellations = 0;
  let shutdowns = 0;
  const server = startServer(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/v1/core') return Response.json(coreRead);
    if (pathname.endsWith('/events')) return sseResponse(activeSnapshot);
    if (pathname.endsWith('/title')) {
      const body = await request.json() as Record<string, unknown>;
      renames.push(body);
      return accepted(String(body.commandId), activeSessionId, {
        result: 'renamed',
      });
    }
    if (pathname.endsWith('/cancel')) cancellations += 1;
    if (pathname.endsWith('/shutdown')) shutdowns += 1;
    return new Response('unexpected request', { status: 404 });
  });
  const terminal = new FakeTerminal();
  const run = runRemoteTui(
    `http://127.0.0.1:${server.addr.port}`,
    activeSessionId,
    { terminal },
  );
  const screen = () => terminal.frame?.rows.join('\n') ?? '';
  try {
    await waitFor(() => screen().includes('Active Session A'));
    terminal.pushInput('/');
    await waitFor(() => screen().includes('slash commands'));
    terminal.pushInput('ren');
    await waitFor(() => screen().includes('usage: /rename TEXT'));
    terminal.pushInput('\r');
    await waitFor(() => !screen().includes('slash commands') && screen().includes('/rename'));
    strictEqual(renames.length, 0);
    terminal.pushInput('Picker title\r');
    await waitFor(() => renames.length === 1);
    strictEqual(renames[0]?.title, 'Picker title');
    await waitFor(() => !screen().includes('renaming Session'));
    terminal.pushInput('/qui');
    await waitFor(() => screen().includes('usage: /quit'));
    terminal.pushInput('\r');
    await waitFor(() => !screen().includes('slash commands'));
    terminal.pushInput('\x03/quit');
    await waitFor(() => screen().includes('slash commands'));
    terminal.pushInput('\r');
    await waitFor(() => !screen().includes('slash commands'));
    strictEqual(shutdowns, 0, 'a fresh draft must not inherit the prior completion suppression');
    terminal.pushInput('\x7ft');
    await waitFor(() => screen().includes('slash commands'));
    terminal.pushInput('\r');
    await waitFor(() => !screen().includes('slash commands'));
    strictEqual(shutdowns, 0, 'editing a command name back to its old value must only complete');
    terminal.pushInput('\x03/rename Kept title');
    terminal.pushInput('\x1b[H' + '\x1b[C'.repeat(7) + '\x7f');
    await waitFor(() =>
      screen().includes('slash commands') && screen().includes('/renam Kept title')
    );
    terminal.pushInput('\r');
    await waitFor(() => !screen().includes('slash commands'));
    strictEqual(renames.length, 1);
    terminal.pushInput('\r');
    await waitFor(() => renames.length === 2);
    strictEqual(renames[1]?.title, 'Kept title');
    await waitFor(() => !screen().includes('renaming Session'));
    terminal.pushInput('/hel');
    await waitFor(() => screen().includes('usage: /help'));
    terminal.pushInput('\x1b');
    await waitFor(() => !screen().includes('slash commands'));
    strictEqual(cancellations, 0);
    terminal.pushInput('\x7f');
    await waitFor(() => screen().includes('slash commands'));
    terminal.pushInput('\r');
    await waitFor(() => !screen().includes('slash commands'));
    terminal.pushInput('\r');
    await waitFor(() => screen().includes('help · PageUp/Down'));
    strictEqual(cancellations, 0);
  } finally {
    terminal.pushInput('\x04');
    await run;
    await server.shutdown();
  }
});

Deno.test('Session picker d/D confirms y/n, cancels without deletion, refreshes and returns a deleted saved view to the active Session', async () => {
  let deleted = false;
  let deletes = 0;
  let activeSubscriptions = 0;
  let savedSubscriptions = 0;
  const server = startServer(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/v1/core') {
      return Response.json({
        ...coreRead,
        implementedOperations: [...coreRead.implementedOperations, 'session.delete'],
      });
    }
    if (pathname === '/api/v1/sessions') {
      return Response.json(
        sessionList(deleted ? [activeSessionId] : [savedSessionId, activeSessionId]),
      );
    }
    if (request.method === 'POST' && pathname.endsWith('/delete')) {
      deletes += 1;
      const body = await request.json();
      if (pathname.includes(activeSessionId)) {
        return Response.json({
          kind: 'rejected',
          commandId: body.commandId,
          target: { kind: 'session', sessionId: activeSessionId },
          reason: 'busy',
        });
      }
      deleted = true;
      return accepted(body.commandId, savedSessionId, { deleted: savedSessionId });
    }
    if (pathname.endsWith('/events')) {
      if (pathname.includes(savedSessionId)) {
        savedSubscriptions += 1;
        return sseResponse(savedSnapshot);
      }
      activeSubscriptions += 1;
      return sseResponse(activeIdleSnapshot);
    }
    if (pathname === `/api/v1/sessions/${savedSessionId}`) return Response.json(savedSnapshot);
    return new Response('unexpected request', { status: 404 });
  });
  const terminal = new FakeTerminal();
  const screen = () => terminal.frame?.rows.join('\n') ?? '';
  const run = runRemoteTui(`http://127.0.0.1:${server.addr.port}`, activeSessionId, { terminal });
  try {
    await waitFor(() => activeSubscriptions === 1);
    terminal.pushInput('\x1b[14~');
    await waitFor(() => screen().includes('Saved Session B ·'));
    terminal.pushInput('d');
    await waitFor(() => screen().includes('Delete Session?') && screen().includes(savedSessionId));
    terminal.pushInput('n');
    await waitFor(() => screen().includes('session picker'));
    strictEqual(deletes, 0);
    terminal.pushInput('D');
    await waitFor(() => screen().includes('Delete Session?'));
    terminal.pushInput('\x1b');
    await waitFor(() => screen().includes('session picker'));
    strictEqual(deletes, 0);
    terminal.pushInput('\r');
    await waitFor(() =>
      savedSubscriptions === 1 && screen().includes('Saved B conversation marker')
    );
    terminal.pushInput('\x1b[14~');
    await waitFor(() => screen().includes('session picker'));
    terminal.pushInput('D');
    await waitFor(() => screen().includes('Delete Session?'));
    terminal.pushInput('y');
    await waitFor(() =>
      deleted && activeSubscriptions === 2 && screen().includes('session picker')
    );
    strictEqual(deletes, 1);
    strictEqual(screen().includes('Saved Session B'), false);
    strictEqual(screen().includes('Active Session A'), true);
    terminal.pushInput('d');
    await waitFor(() => screen().includes('Delete Session?'));
    terminal.pushInput('y');
    await waitFor(() => screen().includes('Session is open in a Core'));
    strictEqual(deletes, 2);
    terminal.pushInput('n');
    await waitFor(() => screen().includes('Active Session A ·'));
    terminal.pushInput('\x04');
    strictEqual(await run, 0);
  } finally {
    terminal.pushInput('\x04');
    await run;
    await server.shutdown();
  }
});
