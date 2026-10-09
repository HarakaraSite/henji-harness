import { TerminalScreen } from './terminal_screen_fixture.ts';
import { deepStrictEqual, strictEqual } from 'node:assert';
import type { SessionSnapshot } from '../../v0/api/contract.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const encoder = new TextEncoder();
const sessionId = '21100000-0000-4000-8000-000000000001';
const coreEpoch = 'increment-211-input';
// deno-lint-ignore no-control-regex
const plain = (text: string): string => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');

const build = {
  schemaVersion: 1,
  productVersion: '0.1.0',
  buildId: 'a'.repeat(64),
  sourceRevision: 'increment-211-input-test',
  sourceDirty: false,
  denoVersion: '2.9.7',
  target: 'x86_64-unknown-linux-gnu',
  embeddedRuntimeSha256: 'b'.repeat(64),
  agentConfigurationSchemaVersion: 1,
  supportedToolApiContracts: ['henji-tool/v1'],
  supportedHookApiContracts: ['henji-hooks/v1'],
};

const snapshot = (revision: number): SessionSnapshot => ({
  schemaVersion: 3,
  cursor: { coreEpoch, sessionId, revision },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-10-07T00:00:00.000Z',
      title: 'Increment 211 editor input',
      agent: 'default',
      committedTurn: 0,
      messageCount: 0,
    },
    selection: { provider: 'provider-a', modelId: 'model-a', effort: 'low' },
    startup: apiStartupFixture(),
  },
  runtime: {
    active: false,
    activeSessionId: sessionId,
    phase: 'idle',
    execution: null,
    operations: ['task.submit'],
  },
  conversation: {
    schemaVersion: 3,
    sessionId,
    cut: 0,
    storeRevision: 0,
    page: { direction: 'latest' as const, hasOlder: false, hasNewer: false },
    entities: {},
    order: [],
  },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'unknown' },
  context: {},
});

class FakeTerminal implements TerminalPort {
  readonly output: string[] = [];
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
  setRaw(_mode: boolean): void {}
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
  private readonly display = new TerminalScreen();
  write(bytes: Uint8Array): void {
    const size = this.consoleSize();
    this.display.resize(size.columns, size.rows);
    this.display.write(bytes);
    this.output.push(new TextDecoder().decode(bytes));
  }
  addSignal(): void {}
  removeSignal(): void {}
  subscribeOutputFailure(): () => void {
    return () => {};
  }
  text(): string {
    return plain(this.output.join(''));
  }
  screen(): string {
    return this.display.frame().rows.join('\n');
  }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Increment 211 remote input behavior');
};

Deno.test('Increment 211 remote arrows move editor lines and do not recall submitted prompts', async () => {
  const submitted: string[] = [];
  let revision = 1;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const currentSnapshot = () => snapshot(revision);
  const sendSnapshot = (): void => {
    streamController?.enqueue(encoder.encode(
      `data: ${JSON.stringify({ kind: 'session.snapshot', snapshot: currentSnapshot() })}\n\n`,
    ));
  };
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/api/v1/core') {
        return Response.json({
          apiVersion: 1,
          conversationSchema: 3,
          coreEpoch,
          build,
          workspace: '/tmp/increment-211-workspace',
          activeSessionId: sessionId,
          phase: 'idle',
          implementedOperations: ['core.read', 'session.read', 'session.subscribe', 'task.submit'],
        });
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/sessions/${sessionId}/events`
      ) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              sendSnapshot();
            },
            cancel() {
              streamController = undefined;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (request.method === 'POST' && url.pathname.endsWith('/tasks')) {
        const body = await request.json() as { commandId: string; text: string };
        submitted.push(body.text);
        revision += 1;
        sendSnapshot();
        return Response.json({
          kind: 'accepted',
          commandId: body.commandId,
          target: { kind: 'session', sessionId },
          cursor: { coreEpoch, sessionId, revision },
          value: { executionId: `execution-${submitted.length}` },
        });
      }
      return new Response('unexpected TUI request', { status: 404 });
    },
  );
  const terminal = new FakeTerminal();
  const run = runRemoteTui(`http://127.0.0.1:${server.addr.port}`, sessionId, { terminal });
  try {
    await waitFor(() => terminal.text().includes('Increment 211 editor input'));

    terminal.pushInput('first\x1b[27;3;13~second\x1b[A!\x1b[B?\r');
    await waitFor(() => submitted.length === 1);
    deepStrictEqual(submitted, ['first!\nsecond?']);

    await waitFor(() => terminal.screen().includes('Enter submit'));
    terminal.pushInput('\x1b[A\r');
    await new Promise((resolve) => setTimeout(resolve, 120));
    strictEqual(submitted.length, 1);

    terminal.pushInput('next prompt\r');
    await waitFor(() => submitted.length === 2);
    deepStrictEqual(submitted, ['first!\nsecond?', 'next prompt']);
  } finally {
    terminal.pushInput('\x04');
    await run;
    await server.shutdown();
  }
});
