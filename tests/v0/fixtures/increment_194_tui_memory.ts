import { strictEqual } from 'node:assert';
import { buildManifest } from '../../../v0/agent/runtime/build_manifest.ts';
import type { SessionStreamFrame } from '../../../v0/api/contract.ts';
import { runRemoteTui } from '../../../v0/tui/remote_session.ts';
import type { TerminalPort } from '../../../v0/tui/terminal.ts';
import { conversationPosition, tuiSnapshot } from '../tui_entity_fixture.ts';
import { TerminalScreen } from '../terminal_screen_fixture.ts';

const gc = (globalThis as unknown as { gc: () => void }).gc;
const encoder = new TextEncoder();
const initial = tuiSnapshot();
let subscriptionSnapshot = initial;
let latest = '';
const display = new TerminalScreen(80, 24);
let inputResolve: ((bytes: Uint8Array | null) => void) | undefined;
let acquired = false;
let stream!: ReadableStreamDefaultController<Uint8Array>;
const signals = new Map<string, () => void>();
const terminal: TerminalPort = {
  stdinIsTerminal: () => true,
  stdoutIsTerminal: () => true,
  consoleSize: () => ({ columns: 80, rows: 24 }),
  setRaw() {},
  read: () => new Promise((resolve) => inputResolve = resolve),
  drainAndCloseInput: () => {
    inputResolve?.(null);
    inputResolve = undefined;
    return Promise.resolve();
  },
  write: (bytes) => {
    display.write(bytes);
    latest = display.frame().rows.join('\n');
    // Keep this benchmark focused on Henji's heap, not the fake host's scrollback.
    display.history.length = 0;
  },
  addSignal: (name, handler) => {
    signals.set(name, handler);
  },
  removeSignal: (name) => {
    signals.delete(name);
  },
};

const send = (frame: SessionStreamFrame): void => {
  stream.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
};
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('TUI did not consume the memory probe frames');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const heap = async (): Promise<number> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
  return Deno.memoryUsage().heapUsed;
};
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
  const path = new URL(request.url).pathname;
  if (path === '/api/v1/core') {
    return Response.json({
      apiVersion: 1,
      coreEpoch: initial.cursor.coreEpoch,
      build: buildManifest(),
      workspace: '/tmp/increment-194-memory',
      activeSessionId: initial.session.id,
      phase: 'idle',
      implementedOperations: ['core.read', 'session.read', 'session.subscribe'],
    });
  }
  if (path.endsWith('/events')) {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          send({ kind: 'session.snapshot', snapshot: subscriptionSnapshot });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (path === `/api/v1/sessions/${initial.session.id}`) return Response.json(initial);
  return new Response('Not found', { status: 404 });
});
const errors: string[] = [];
const running = runRemoteTui(`http://127.0.0.1:${server.addr.port}`, initial.session.id, {
  terminal,
  afterAcquire: () => {
    acquired = true;
  },
  writeStderr: (text) => {
    errors.push(text);
  },
});

const update = (ordinal: number): void => {
  const bytes = new Uint8Array(16_384);
  for (let i = 0; i < bytes.length; i++) bytes[i] = 65 + (ordinal + i) % 26;
  const text = String.fromCharCode(...bytes) + `\nFRAME_${ordinal}`;
  send({
    kind: 'session.update',
    cursor: { ...initial.cursor, revision: ordinal + 1 },
    previousRevision: ordinal,
    changes: [],
    conversationDelta: {
      schemaVersion: 2,
      kind: 'delta',
      sessionId: initial.session.id,
      cut: ordinal + 1,
      storeRevision: ordinal + 1,
      changes: [
        {
          kind: 'upsert',
          entity: {
            kind: 'message',
            id: 'answer',
            executionId: 'execution-194',
            turn: 1,
            version: ordinal,
            position: conversationPosition(0, 1, 1),
            role: 'assistant',
            text,
            complete: false,
          },
        },
        ...(ordinal === 1
          ? [{
            kind: 'order' as const,
            action: 'insert' as const,
            id: 'answer',
            position: conversationPosition(0, 1, 1),
          }]
          : []),
      ],
    },
  });
};

try {
  await waitFor(() => acquired);
  const samples: { frames: number; heapUsed: number }[] = [];
  for (let batch = 1; batch <= 18; batch++) {
    for (let ordinal = (batch - 1) * 100 + 1; ordinal <= batch * 100; ordinal++) update(ordinal);
    await waitFor(() => latest.includes(`FRAME_${batch * 100}`));
    if (batch === 3 || batch === 18) samples.push({ frames: batch * 100, heapUsed: await heap() });
  }
  // Both terminal input and TUI exit remain pending throughout the measurements.
  const growthMiB = (samples[1].heapUsed - samples[0].heapUsed) / 1_048_576;
  subscriptionSnapshot = {
    ...initial,
    cursor: { ...initial.cursor, revision: 1803 },
    conversation: {
      ...initial.conversation,
      entities: {
        answer: {
          kind: 'message',
          id: 'answer',
          executionId: 'execution-194',
          turn: 1,
          version: 1803,
          position: conversationPosition(0, 1, 1),
          role: 'assistant',
          text: 'RESYNC_194',
          complete: true,
        },
      },
      order: ['answer'],
    },
  };
  send({
    kind: 'session.update',
    cursor: subscriptionSnapshot.cursor,
    previousRevision: 1802,
    changes: [],
  });
  await waitFor(() => latest.includes('RESYNC_194'));
  console.log(JSON.stringify({ samples, growthMiB, resynced: true, errors }));
  signals.get('SIGTERM')!();
  strictEqual(await running, 0);
  strictEqual(errors.length, 0);
} finally {
  signals.get('SIGTERM')?.();
  await running;
  if (errors.length > 0) console.error(JSON.stringify(errors));
  await server.shutdown();
}
