import { deepStrictEqual, strictEqual } from 'node:assert';
import type { SessionSnapshot } from '../../v0/api/contract.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
import { apiStartupFixture } from './fixtures/api_startup.ts';

const encoder = new TextEncoder();
const sessionId = '14600000-0000-4000-8000-000000000001';
const coreEpoch = 'increment-146-remote-history';

const build = {
  schemaVersion: 1,
  productVersion: '0.1.0',
  buildId: 'a'.repeat(64),
  sourceRevision: 'remote-history-test',
  sourceDirty: false,
  denoVersion: '2.9.7',
  target: 'x86_64-unknown-linux-gnu',
  embeddedRuntimeSha256: 'b'.repeat(64),
  supportedAgentDefinitionApiContracts: ['henji-agent-definition-v2'],
  supportedToolDefinitionApiContracts: ['henji-tool-definition-v1'],
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => resolve = accept);
  return { promise, resolve };
};

const conversationMessages = Array.from({ length: 32 }, (_, index) => {
  const turn = Math.floor(index / 2) + 1;
  return {
    id: `history-message-${index + 1}`,
    executionId: `history-execution-${turn}`,
    turn,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `history message ${index + 1}`,
  };
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
  write(bytes: Uint8Array): void {
    this.output.push(new TextDecoder().decode(bytes));
  }
  addSignal(): void {}
  removeSignal(): void {}
  subscribeOutputFailure(): () => void {
    return () => {};
  }
  text(): string {
    return this.output.join('');
  }
  screen(): string {
    return this.output.at(-1) ?? '';
  }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for remote editor history behavior');
};

const snapshot = (revision: number): SessionSnapshot => ({
  schemaVersion: 1,
  cursor: { coreEpoch, sessionId, revision },
  session: {
    id: sessionId,
    canonicalSessionId: sessionId,
    persistence: 'persistent',
    position: {
      sessionId,
      createdAt: '2026-09-28T00:00:00.000Z',
      title: 'Increment 146 remote input history',
      agent: 'default',
      committedTurn: 16,
      messageCount: conversationMessages.length,
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
    messages: conversationMessages,
    tools: [],
    thinking: [],
    requests: [],
    omitted: 0,
  },
  pending: { kind: 'core-owned', followUps: [] },
  credentialAvailability: { status: 'unknown' },
  context: {},
});

Deno.test('Increment 146 remote editor history follows accepted task receipts and restores drafts', async () => {
  const submitted: string[] = [];
  let revision = 1;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const heldReceiptSeen = deferred();
  const releaseHeldReceipt = deferred();
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
          coreEpoch,
          build,
          workspace: '/tmp/increment-146-workspace',
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
        if (body.text === 'held accepted task') {
          heldReceiptSeen.resolve();
          await releaseHeldReceipt.promise;
        }
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
  const run = runRemoteTui(`http://127.0.0.1:${server.addr.port}`, undefined, { terminal });
  try {
    await waitFor(() => terminal.text().includes('Increment 146 remote input history'));

    terminal.pushInput('\x1b[5~');
    await waitFor(() => terminal.screen().includes('Esc latest'));
    terminal.pushInput('held accepted task\r');
    await heldReceiptSeen.promise;
    strictEqual(terminal.screen().includes('Esc latest'), true);
    releaseHeldReceipt.resolve();
    await waitFor(() =>
      !terminal.screen().includes('Esc latest') && terminal.screen().includes('accepted')
    );

    terminal.pushInput('accepted prompt\r');
    await waitFor(() => submitted.length === 2);

    terminal.pushInput('accepted prompt\r');
    await waitFor(() => submitted.length === 3);
    deepStrictEqual(submitted, ['held accepted task', 'accepted prompt', 'accepted prompt']);

    terminal.pushInput('unsent draft');
    await waitFor(() => terminal.text().includes('unsent draft'));
    terminal.pushInput('\x1b[A\x1b[B\r');
    await waitFor(() => submitted.length === 4);
    deepStrictEqual(submitted, [
      'held accepted task',
      'accepted prompt',
      'accepted prompt',
      'unsent draft',
    ]);
    strictEqual(terminal.text().includes('unsent draft'), true);
  } finally {
    terminal.pushInput('\x04');
    await run;
    await server.shutdown();
  }
});
