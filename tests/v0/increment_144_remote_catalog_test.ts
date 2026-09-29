import { encodeScreenFrame, type ScreenFrame } from '../../v0/tui/terminal.ts';
import { deepStrictEqual, strictEqual } from 'node:assert';
import type { ApiSelection, CoreOperationName, SessionSnapshot } from '../../v0/api/contract.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const encoder = new TextEncoder();
const sessionId = '14400000-0000-4000-8000-000000000001';
const coreEpoch = 'increment-144-remote-catalog';
const secret = 'key-dont-render-144';

const build = {
  schemaVersion: 1,
  productVersion: '0.1.0',
  buildId: 'a'.repeat(64),
  sourceRevision: 'remote-catalog-test',
  sourceDirty: false,
  denoVersion: '2.9.7',
  target: 'x86_64-unknown-linux-gnu',
  embeddedRuntimeSha256: 'b'.repeat(64),
  supportedAgentDefinitionApiContracts: ['henji-agent-definition-v2'],
  supportedToolDefinitionApiContracts: ['henji-tool-definition-v1'],
};

let selected: ApiSelection = {
  provider: 'provider-a',
  modelId: 'mimo-flash',
  effort: 'low',
};

const snapshot = (): SessionSnapshot => ({
  schemaVersion: 1,
  cursor: { coreEpoch, sessionId, revision: 1 },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-09-28T00:00:00.000Z',
      title: 'Increment 144 remote catalog',
      agent: 'default',
      committedTurn: 0,
      messageCount: 0,
    },
    selection: selected,
    startup: apiStartupFixture(),
  },
  runtime: {
    active: false,
    activeSessionId: sessionId,
    phase: 'idle',
    execution: null,
    operations: ['task.submit', 'selection.change', 'credential.register'],
  },
  conversation: {
    messages: [],
    tools: [],
    thinking: [],
    requests: [],
    omitted: 0,
  },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'missing' },
  context: {},
});

const snapshotFor = (
  targetSessionId: string,
  activeSessionId: string,
  credentialStatus: 'present' | 'missing' | 'unknown',
  revision = 1,
): SessionSnapshot => ({
  schemaVersion: 1,
  cursor: { coreEpoch, sessionId: targetSessionId, revision },
  session: {
    id: targetSessionId,
    canonicalSessionId: targetSessionId,
    persistence: 'persistent',
    position: {
      sessionId: targetSessionId,
      createdAt: '2026-09-28T00:00:00.000Z',
      title: targetSessionId === sessionId ? 'Active Session A' : 'Saved Session B',
      agent: 'default',
      committedTurn: 0,
      messageCount: 0,
    },
    selection: { provider: 'provider-b', modelId: 'mimo-flash', effort: 'low' },
    startup: apiStartupFixture(),
  },
  runtime: {
    active: false,
    activeSessionId,
    phase: 'idle',
    execution: null,
    operations: targetSessionId === activeSessionId
      ? ['task.submit', 'selection.change', 'credential.register']
      : ['credential.register'],
  },
  conversation: {
    messages: [],
    tools: [],
    thinking: [],
    requests: [],
    omitted: 0,
  },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: credentialStatus },
  context: {},
});

const operations = [
  'core.read',
  'session.read',
  'session.subscribe',
  'task.submit',
  'command.read',
  'catalog.read',
  'selection.change',
  'path.read',
  'credential.readPresence',
  'credential.register',
] satisfies readonly CoreOperationName[];

const coreRead = {
  apiVersion: 1,
  coreEpoch,
  build,
  workspace: '/srv/core-workspace',
  activeSessionId: sessionId,
  phase: 'idle',
  implementedOperations: operations,
};

class FakeTerminal implements TerminalPort {
  readonly output: string[] = [];
  readonly frames: ScreenFrame[] = [];
  readonly signals = new Map<string, () => void>();
  raw = false;
  private readonly input: Uint8Array[] = [];
  private pendingRead: ((value: Uint8Array | null) => void) | undefined;

  constructor(private readonly columns = 80) {}

  stdinIsTerminal(): boolean {
    return true;
  }
  stdoutIsTerminal(): boolean {
    return true;
  }
  consoleSize(): { columns: number; rows: number } {
    return { columns: this.columns, rows: 24 };
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
  throw new Error('timed out waiting for remote catalog TUI behavior');
};

const sendSnapshot = (
  controller: ReadableStreamDefaultController<Uint8Array>,
): void => {
  sendSnapshotValue(controller, snapshot());
};

const sendSnapshotValue = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  value: SessionSnapshot,
): void => {
  controller.enqueue(encoder.encode(
    `data: ${JSON.stringify({ kind: 'session.snapshot', snapshot: value })}\n\n`,
  ));
};

const accepted = (commandId: string, value: unknown): Response =>
  Response.json({
    kind: 'accepted',
    commandId,
    target: { kind: 'session', sessionId },
    value,
  });

Deno.test('Increment 144 remote catalog, selection, masked login, and Core workspace completion', async () => {
  selected = { provider: 'provider-a', modelId: 'mimo-flash', effort: 'low' };
  const models = [
    ...Array.from({ length: 12 }, (_, index) => ({
      modelId: `model-${String(index).padStart(2, '0')}`,
      favorite: true,
      defaultEffort: 'low',
      efforts: ['low', 'medium', 'high'],
    })),
    {
      modelId: 'qwen-plus',
      favorite: true,
      defaultEffort: 'medium',
      efforts: ['low', 'medium'],
    },
    {
      modelId: 'mimo-flash',
      favorite: true,
      defaultEffort: 'low',
      efforts: ['low', 'medium', 'high'],
    },
  ];
  const selections: ApiSelection[] = [];
  let taskSubmissions = 0;
  let pathReads = 0;
  let credentialPresenceReads = 0;
  let registeredValue: unknown;
  let credentialRegistrations = 0;
  let credentialStatus: 'present' | 'missing' | 'unknown' = 'missing';
  let modelReads = 0;
  let releaseModels: (() => void) | undefined;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/api/v1/core') {
        return Response.json(coreRead);
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/sessions/${sessionId}/events`
      ) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sendSnapshot(controller);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/catalogs') {
        const kind = url.searchParams.get('kind');
        if (kind === 'providers') {
          return Response.json({
            kind,
            providers: [
              {
                provider: 'provider-a',
                defaultSelection: {
                  provider: 'provider-a',
                  modelId: 'a-model',
                  effort: 'low',
                },
              },
              {
                provider: 'provider-b',
                defaultSelection: {
                  provider: 'provider-b',
                  modelId: 'mimo-flash',
                  effort: 'low',
                },
              },
            ],
          });
        }
        if (kind === 'models') {
          modelReads += 1;
          if (modelReads === 1) {
            await new Promise<void>((resolve) => releaseModels = resolve);
          }
          return Response.json({
            kind,
            provider: url.searchParams.get('provider'),
            metadataStatus: 'loaded',
            models,
          });
        }
        if (kind === 'efforts') {
          return Response.json({
            kind,
            provider: url.searchParams.get('provider'),
            modelId: url.searchParams.get('modelId'),
            source: 'models.dev',
            efforts: ['low', 'medium', 'high'],
          });
        }
        if (kind === 'credentials') {
          return Response.json({
            kind,
            profiles: [
              { authProfile: 'openai-profile', providers: ['provider-b'] },
              { authProfile: 'router-profile', providers: ['provider-a'] },
            ],
          });
        }
      }
      if (request.method === 'POST' && url.pathname.endsWith('/selection')) {
        const body = await request.json() as {
          commandId: string;
          selection: ApiSelection;
        };
        selections.push(body.selection);
        selected = body.selection;
        return accepted(body.commandId, {
          result: 'selected',
          selection: selected,
        });
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v1/credentials/presence'
      ) {
        credentialPresenceReads += 1;
        return Response.json({
          profiles: [
            {
              authProfile: 'openai-profile',
              providers: ['provider-b'],
              status: credentialStatus,
            },
            {
              authProfile: 'router-profile',
              providers: ['provider-a'],
              status: 'present',
            },
          ],
        });
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/v1/credentials/register'
      ) {
        const body = await request.json() as {
          authProfile: string;
          value: string;
        };
        credentialRegistrations += 1;
        registeredValue = body.value;
        credentialStatus = 'present';
        return Response.json({
          kind: 'registered',
          authProfile: body.authProfile,
          status: 'present',
        });
      }
      if (
        request.method === 'GET' && url.pathname === '/api/v1/workspace/paths'
      ) {
        pathReads += 1;
        return Response.json({
          workspace: '/srv/core-workspace',
          complete: true,
          paths: ['notes/a file.md', 'src/alpha.ts', 'src/alphabet.ts'],
        });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/tasks')) {
        taskSubmissions += 1;
        return Response.json({
          kind: 'accepted',
          commandId: 'unexpected',
          target: { kind: 'session', sessionId },
          value: { executionId: 'unexpected' },
        });
      }
      return new Response('unexpected TUI request', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  const run = runRemoteTui(`http://127.0.0.1:${server.addr.port}`, undefined, {
    terminal,
  });
  try {
    await waitFor(() => terminal.text().includes('Increment 144 remote catalog'));

    terminal.pushInput('/provider\r');
    await waitFor(() => terminal.text().includes('provider picker'));
    terminal.pushInput('\x1b[B\r');
    await waitFor(() => selections.length === 1);
    deepStrictEqual(selections[0], {
      provider: 'provider-b',
      modelId: 'mimo-flash',
      effort: 'low',
    });

    const beforeLoading = terminal.frames.length;
    terminal.pushInput('/model\r');
    await waitFor(() =>
      releaseModels !== undefined &&
      terminal.frames.at(-1)!.rows.join('\n').includes('loading model catalog')
    );
    strictEqual(
      terminal.frames.slice(beforeLoading).some((frame) =>
        frame.rows.some((row) => row.includes('Esc cancels') || row.includes('model picker'))
      ),
      false,
    );
    terminal.pushInput('\x1b');
    await waitFor(() => !terminal.frames.at(-1)!.rows.join('\n').includes('loading model catalog'));
    releaseModels!();
    terminal.pushInput('/model\r');
    await waitFor(() =>
      terminal.text().includes('> * mimo-flash') &&
      terminal.text().includes('of 14')
    );
    terminal.pushInput('qwen');
    await waitFor(() => terminal.text().includes('qwen-plus'));
    terminal.pushInput('\x7f\x7f\x7f\x7f');
    await waitFor(() =>
      terminal.text().includes('> * mimo-flash') &&
      terminal.text().includes('of 14')
    );
    terminal.pushInput('\x1b/effort\r');
    await waitFor(() => terminal.text().includes('effort picker'));
    terminal.pushInput('\x1b[B\r');
    await waitFor(() => selections.length === 2);
    deepStrictEqual(selections[1], {
      provider: 'provider-b',
      modelId: 'mimo-flash',
      effort: 'medium',
    });

    terminal.pushInput('/login\r');
    await waitFor(() => terminal.text().includes('credential registration'));
    terminal.pushInput('\r');
    await waitFor(() => terminal.text().includes('credential input · openai-profile'));
    terminal.pushInput(secret);
    await waitFor(() => terminal.text().includes('*'.repeat(secret.length)));
    strictEqual(terminal.text().includes(secret), false);
    terminal.pushInput('\r');
    await waitFor(() => terminal.text().includes('credential saved: openai-profile'));
    strictEqual(registeredValue, secret);
    strictEqual(credentialPresenceReads, 2);
    strictEqual(terminal.text().includes(secret), false);

    terminal.pushInput('notes/a\t');
    await waitFor(() => terminal.text().includes('"./notes/a file.md"'));
    terminal.pushInput('\x15src/al\t');
    await waitFor(() => terminal.text().includes('path match ambiguous (2)'));
    strictEqual(pathReads, 1);
    strictEqual(taskSubmissions, 0);

    const beforeSecondLogin = terminal.text().length;
    terminal.pushInput('\x15/login\r');
    await waitFor(() =>
      terminal.text().slice(beforeSecondLogin).includes(
        'credential registration',
      )
    );
    terminal.pushInput('\r');
    const beforeSecondCredentialInput = terminal.text().length;
    await waitFor(() =>
      terminal.text().slice(beforeSecondCredentialInput).includes(
        'credential input · openai-profile',
      )
    );
    const detachedValue = 'detach-must-not-register-144';
    terminal.pushInput(detachedValue);
    await waitFor(() => terminal.text().includes('*'.repeat(detachedValue.length)));
    strictEqual(terminal.text().includes(detachedValue), false);

    terminal.pushInput('\x04');
    strictEqual(await run, 0);
    strictEqual(credentialRegistrations, 1);
    strictEqual(terminal.text().includes(detachedValue), false);
  } finally {
    releaseModels?.();
    await server.shutdown();
  }
});

Deno.test('Increment 144 follows live credential presence and permits saved-view login', async () => {
  const savedSessionId = '14400000-0000-4000-8000-000000000002';
  let presenceStatus: 'present' | 'missing' | 'unknown' = 'missing';
  let activeStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let savedStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let credentialCatalogReads = 0;
  let credentialRegistrations = 0;
  let taskSubmissions = 0;
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/api/v1/core') {
        return Response.json({ ...coreRead, activeSessionId: sessionId });
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/sessions/${savedSessionId}`
      ) {
        return Response.json(snapshotFor(savedSessionId, sessionId, 'unknown'));
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/sessions/${sessionId}/events`
      ) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              activeStream = controller;
              sendSnapshotValue(
                controller,
                snapshotFor(sessionId, sessionId, presenceStatus),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/sessions/${savedSessionId}/events`
      ) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              savedStream = controller;
              sendSnapshotValue(
                controller,
                snapshotFor(savedSessionId, sessionId, presenceStatus),
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/catalogs') {
        if (url.searchParams.get('kind') !== 'credentials') {
          return new Response('unexpected catalog kind', { status: 404 });
        }
        credentialCatalogReads += 1;
        return Response.json({
          kind: 'credentials',
          profiles: [{
            authProfile: 'provider-b-profile',
            providers: ['provider-b'],
          }],
        });
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/v1/credentials/presence'
      ) {
        return Response.json({
          profiles: [{
            authProfile: 'provider-b-profile',
            providers: ['provider-b'],
            status: presenceStatus,
          }],
        });
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/v1/credentials/register'
      ) {
        const body = await request.json() as {
          authProfile: string;
          value: string;
        };
        strictEqual(body.authProfile, 'provider-b-profile');
        strictEqual(body.value, 'saved-view-test-key');
        credentialRegistrations += 1;
        presenceStatus = 'present';
        return Response.json({
          kind: 'registered',
          authProfile: body.authProfile,
          status: 'present',
        });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/tasks')) {
        taskSubmissions += 1;
        return new Response('unexpected task submit', { status: 500 });
      }
      return new Response('unexpected request', { status: 404 });
    },
  );
  const terminal = new FakeTerminal(180);
  const run = runRemoteTui(`http://127.0.0.1:${server.addr.port}`, undefined, {
    terminal,
  });
  try {
    await waitFor(() => terminal.text().includes('Active Session A'));

    terminal.pushInput('/login\r');
    await waitFor(() => terminal.text().includes('provider-b-profile'));
    terminal.pushInput('\x1b');
    await waitFor(() => terminal.text().includes('Ctrl-C clear'));
    presenceStatus = 'present';
    if (activeStream === undefined) {
      throw new Error('active Session stream missing');
    }
    sendSnapshotValue(
      activeStream,
      snapshotFor(sessionId, sessionId, presenceStatus, 2),
    );
    await waitFor(() => terminal.text().includes('credential present: provider-b'));

    const beforeView = terminal.text().length;
    terminal.pushInput(`/view ${savedSessionId}\r`);
    await waitFor(() => terminal.text().slice(beforeView).includes('Saved Session B'));
    const beforeLogin = terminal.text().length;
    terminal.pushInput('/login\r');
    await waitFor(() => terminal.text().slice(beforeLogin).includes('provider-b-profile'));
    strictEqual(credentialCatalogReads, 2);
    terminal.pushInput('\r');
    const beforeInput = terminal.text().length;
    await waitFor(() =>
      terminal.text().slice(beforeInput).includes(
        'credential input · provider-b-profile',
      )
    );
    terminal.pushInput('saved-view-test-key\r');
    await waitFor(() => credentialRegistrations === 1);
    strictEqual(savedStream !== undefined, true);
    strictEqual(taskSubmissions, 0);
    terminal.pushInput('\x04');
    strictEqual(await run, 0);
  } finally {
    await server.shutdown();
  }
});
