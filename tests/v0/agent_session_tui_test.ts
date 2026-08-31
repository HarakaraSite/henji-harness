import { assert, assertEquals } from './test_helpers.ts';
import { main } from '../../v0/agent/tui_cli.ts';
import {
  createSessionPersistence,
  DenoSessionStore,
  sessionPaths,
} from '../../v0/agent/session_store.ts';
import { type AgentEvent } from '../../v0/agent/events.ts';
import { type Message, type ModelRequest } from '../../v0/agent/contracts.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { Registry } from '../../v0/agent/tools.ts';
import { TuiController, TuiControllerError } from '../../v0/tui/controller.ts';
import { TuiRenderer } from '../../v0/tui/render.ts';
import { TerminalLifecycle } from '../../v0/tui/terminal.ts';

const encoder = new TextEncoder();
const response = (text: string): Response =>
  new Response(
    `data: ${
      JSON.stringify({
        id: 'offline-session-tui-response',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: text },
          finish_reason: 'stop',
        }],
      })
    }\n\n` +
      `data: ${
        JSON.stringify({
          id: 'offline-session-tui-response',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }\n\n` +
      'data: [DONE]\n\n',
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );

class FakeTerminal {
  readonly writes: string[] = [];
  readonly raw: boolean[] = [];
  orientationAttempts = 0;
  failOrientation = false;
  private readonly queued: Uint8Array[] = [];
  private waiter: ((value: Uint8Array | null) => void) | undefined;
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
    this.raw.push(mode);
  }
  read(): Promise<Uint8Array | null> {
    const value = this.queued.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.waiter = resolve);
  }
  push(value: string): void {
    const bytes = encoder.encode(value);
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(bytes);
    } else this.queued.push(bytes);
  }
  drainAndCloseInput(): Promise<void> {
    if (this.waiter !== undefined) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve(null);
    }
    return Promise.resolve();
  }
  write(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    if (this.failOrientation && text.startsWith('Henji Harness\n')) {
      this.orientationAttempts += 1;
      this.failOrientation = false;
      throw new Error('orientation write failed');
    }
    this.writes.push(text);
  }
  addSignal(): void {}
  removeSignal(): void {}
}

const runTui = async (
  args: readonly string[],
  terminal: FakeTerminal,
  workspace: string,
  state: string,
  text: string,
): Promise<number> => {
  setTimeout(() => terminal.push(`${text}\n`), 0);
  setTimeout(() => terminal.push('\x04'), 20);
  return await main(args, {
    terminal,
    stateRoot: state,
    runtimeSeam: {
      workspaceRoot: workspace,
      credential: 'offline-dummy',
      fetcher: () => Promise.resolve(response(`answer:${text}`)),
    },
    writeStderr: () => {},
  });
};

const runTuiExit = async (
  args: readonly string[],
  terminal: FakeTerminal,
  workspace: string,
  state: string,
): Promise<number> => {
  setTimeout(() => terminal.push('\x04'), 0);
  return await main(args, {
    terminal,
    stateRoot: state,
    runtimeSeam: {
      workspaceRoot: workspace,
      credential: 'offline-dummy',
      fetcher: () => Promise.resolve(response('unused')),
    },
    writeStderr: () => {},
  });
};

const normalTranscript = (turns: number): Message[] => {
  const messages: Message[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push(
      { role: 'user', content: { kind: 'text', text: `replay-user-${index}` } },
      {
        role: 'assistant',
        content: { kind: 'text', text: `replay-assistant-${index}` },
      },
    );
  }
  return messages;
};

const messageSummary = (message: Message): string => {
  if (message.role === 'user') return message.content.text;
  if (message.role === 'assistant' && !Array.isArray(message.content)) {
    return (message.content as { readonly text: string }).text;
  }
  return message.role;
};

const seedSession = async (
  state: string,
  workspace: string,
  messages: readonly Message[],
): Promise<string> => {
  const store = new DenoSessionStore(state, workspace);
  const handle = await store.allocate('default');
  const persistence = createSessionPersistence(handle, workspace, 'default');
  const now = '2026-08-27T00:00:01.000Z';
  persistence.commit(
    messages,
    messages.filter((message) => message.role === 'user').length + 1,
    now,
  );
  await persistence.close();
  return handle.id;
};

const inventoryStateTree = async (root: string): Promise<string[]> => {
  const entries: string[] = [];
  const visit = async (path: string, relative: string): Promise<void> => {
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    const mode = info.mode === null ? 'unknown' : `${info.mode}`;
    if (info.isDirectory) {
      entries.push(`directory:${relative}:${mode}`);
      const children: Deno.DirEntry[] = [];
      for await (const child of Deno.readDir(path)) children.push(child);
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        await visit(
          `${path}/${child.name}`,
          relative === '' ? child.name : `${relative}/${child.name}`,
        );
      }
      return;
    }
    const bytes = info.isFile ? await Deno.readFile(path) : new Uint8Array();
    entries.push(`file:${relative}:${mode}:${[...bytes].join(',')}`);
  };
  await visit(root, '');
  return entries;
};

Deno.test('persistent TUI autosaves and continue restores the parent transcript', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-tui-',
  });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const firstTerminal = new FakeTerminal();
  assertEquals(await runTui([], firstTerminal, workspace, state, 'first'), 0);
  const firstOutput = firstTerminal.writes.join('');
  assert(firstOutput.includes('session> new (autosave)\n'));
  const store = new DenoSessionStore(state, workspace);
  const listed = await store.list();
  assertEquals(listed.sessions.length, 1);
  assert(firstTerminal.writes.some((line) => line.includes('(new)')));
  const secondTerminal = new FakeTerminal();
  assertEquals(
    await runTui(['--continue'], secondTerminal, workspace, state, 'second'),
    0,
  );
  const secondOutput = secondTerminal.writes.join('');
  assert(secondOutput.includes('session> continue newest\n'));
  const resumed = await store.list();
  assertEquals(resumed.sessions[0].turnCount, 2);
  assert(secondTerminal.writes.some((line) => line.includes('(resumed)')));
  assert(secondTerminal.writes.some((line) => line.includes('user> first')));
  assert(
    secondOutput.indexOf('keys> idle Ctrl-C twice within 500 ms exit') <
      secondOutput.indexOf('user> first'),
  );
  const ephemeralState = `${root}/must-not-exist`;
  const ephemeralTerminal = new FakeTerminal();
  assertEquals(
    await runTui(
      ['--no-session'],
      ephemeralTerminal,
      workspace,
      ephemeralState,
      'ephemeral',
    ),
    0,
  );
  assert(ephemeralTerminal.writes.join('').includes('session> no session\n'));
  let absent = false;
  try {
    await Deno.stat(ephemeralState);
  } catch (error) {
    absent = error instanceof Deno.errors.NotFound;
  }
  assert(absent);

  const replayRoot = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-replay-',
  });
  const replayWorkspace = `${replayRoot}/workspace`;
  const replayState = `${replayRoot}/state`;
  await Deno.mkdir(replayWorkspace);
  const exactId = await seedSession(
    replayState,
    replayWorkspace,
    normalTranscript(50),
  );
  const exactTerminal = new FakeTerminal();
  assertEquals(
    await runTuiExit(
      ['--session', exactId],
      exactTerminal,
      replayWorkspace,
      replayState,
    ),
    0,
  );
  const exactOutput = exactTerminal.writes.join('');
  assert(exactOutput.includes('session> exact session\n'));
  assert(
    exactOutput.indexOf('keys> idle Ctrl-C twice within 500 ms exit') <
      exactOutput.indexOf('user> replay-user-'),
  );
  assertEquals((exactOutput.match(/user> replay-user-/g) ?? []).length, 50);
  assert(!exactOutput.includes('history> '));

  const boundaryMessages = normalTranscript(49);
  boundaryMessages.push(
    { role: 'user', content: { kind: 'text', text: 'replay-user-final' } },
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        callId: 'replay-call',
        name: 'read',
        arguments: {},
      }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'replay-call',
        name: 'read',
        text: 'replay-result',
        outcome: 'success',
        terminal: 'json_result',
      }],
    },
  );
  assertEquals(boundaryMessages.length, 101);
  const boundaryId = await seedSession(
    replayState,
    replayWorkspace,
    boundaryMessages,
  );
  const boundaryTerminal = new FakeTerminal();
  assertEquals(
    await runTuiExit(
      ['--session', boundaryId],
      boundaryTerminal,
      replayWorkspace,
      replayState,
    ),
    0,
  );
  const boundaryOutput = boundaryTerminal.writes.join('');
  assertEquals((boundaryOutput.match(/user> replay-user-/g) ?? []).length, 49);
  assert(!boundaryOutput.includes('replay-user-0'));
  assert(boundaryOutput.includes('history> 1 messages omitted'));
  assert(boundaryOutput.includes('tool< read success> replay-result'));

  const immediateRoot = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-empty-',
  });
  const immediateWorkspace = `${immediateRoot}/workspace`;
  const immediateState = `${immediateRoot}/state`;
  await Deno.mkdir(immediateWorkspace);
  const immediateTerminal = new FakeTerminal();
  assertEquals(
    await runTuiExit([], immediateTerminal, immediateWorkspace, immediateState),
    0,
  );
  const immediateStore = new DenoSessionStore(
    immediateState,
    immediateWorkspace,
  );
  assertEquals((await immediateStore.list()).sessions, []);
  await Deno.remove(immediateRoot, { recursive: true });
  await Deno.remove(replayRoot, { recursive: true });
  await Deno.remove(root, { recursive: true });
});

Deno.test('bounded follow-up drains only after durable N and creates fresh session ownership', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-follow-up-session-',
  });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  const handle = await store.allocate('default');
  const persistence = createSessionPersistence(handle, workspace, 'default');
  const requests: ModelRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const contexts: ParentTurnExecutionContext[] = [];
  const initialBudgets: ReturnType<ParentTurnExecutionContext['snapshot']>[] = [];
  const releases: ((result: { readonly kind: 'final'; readonly text: string }) => void)[] = [];
  let transientRecord: ReturnType<typeof createSessionPersistence>['record'];
  const model = {
    generate(
      request: ModelRequest,
      options?: { readonly signal?: AbortSignal },
    ) {
      requests.push(structuredClone(request));
      signals.push(options?.signal);
      return new Promise<{ readonly kind: 'final'; readonly text: string }>(
        (resolve) => {
          releases.push(resolve);
        },
      );
    },
  };
  const events: AgentEvent[] = [];
  const terminal = new FakeTerminal();
  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const session = new AgentSession(model, new Registry([]), {
    persistence,
    eventSink: (event) => {
      events.push(event);
      renderer.eventSink(event);
      if (event.kind === 'turn_end' && event.turn === 2) {
        transientRecord = persistence.record;
      }
    },
    createTurnExecutionContext: (turn, signal, cancellation) => {
      const context = new ParentTurnExecutionContext(
        turn,
        undefined,
        signal,
        cancellation,
      );
      contexts.push(context);
      initialBudgets.push(context.snapshot());
      return context;
    },
  });
  const controller = new TuiController(lifecycle, renderer, session);
  await lifecycle.acquire();
  const running = controller.run();
  terminal.push('manual\n');
  for (let attempt = 0; attempt < 20 && requests.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(requests.length, 1);
  terminal.push('queued\x1b\r');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(
    requests[0].transcript.map((message) => message.role === 'user' ? message.content.text : ''),
    [
      'manual',
    ],
  );
  assert(
    !requests[0].transcript.some((message) =>
      message.role === 'user' && message.content.text === 'queued'
    ),
  );
  assertEquals(persistence.record, undefined);

  releases[0]({ kind: 'final', text: 'first answer' });
  for (let attempt = 0; attempt < 20 && requests.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(requests.length, 2);
  assertEquals(persistence.record?.nextTurn, 2);
  assertEquals(persistence.record?.transcript.map(messageSummary), [
    'manual',
    'first answer',
  ]);
  assertEquals(requests[1].transcript.map(messageSummary), [
    'manual',
    'first answer',
    'queued',
  ]);
  assert(
    signals[0] !== undefined && signals[1] !== undefined &&
      signals[0] !== signals[1],
  );
  assert(contexts[0] !== contexts[1]);
  assertEquals(initialBudgets, [
    { parent: 0, child: 0, aggregate: 0 },
    { parent: 0, child: 0, aggregate: 0 },
  ]);
  assertEquals(contexts.map((context) => context.snapshot()), [
    { parent: 1, child: 0, aggregate: 1 },
    { parent: 1, child: 0, aggregate: 1 },
  ]);
  releases[1]({ kind: 'final', text: 'second answer' });
  for (
    let attempt = 0;
    attempt < 20 && controller.currentState !== 'idle';
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const settledRecord = await store.read(handle.id);
  assertEquals(transientRecord?.nextTurn, 3);
  assertEquals(transientRecord?.transcript.map(messageSummary), [
    'manual',
    'first answer',
    'queued',
    'second answer',
  ]);
  assertEquals(settledRecord.nextTurn, 3);
  assertEquals(settledRecord.transcript.map(messageSummary), [
    'manual',
    'first answer',
    'queued',
    'second answer',
  ]);
  const lifecycleEvents = events.filter((event) =>
    event.kind === 'turn_start' || event.kind === 'user_message' ||
    event.kind === 'turn_end'
  ).map((event) =>
    event.kind === 'user_message'
      ? `${event.kind}:${event.message.content.text}`
      : `${event.kind}:${event.turn}`
  );
  assertEquals(lifecycleEvents, [
    'turn_start:1',
    'user_message:manual',
    'turn_end:1',
    'turn_start:2',
    'user_message:queued',
    'turn_end:2',
  ]);
  terminal.push('\x04');
  assertEquals(await running, 0);
  await session.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('queued N+1 rollback restores N or preserves the allowed ghost without N+2', async () => {
  const runCase = async (rollbackFails: boolean): Promise<void> => {
    const root = await Deno.makeTempDir({
      dir: '/tmp',
      prefix: 'henji-follow-up-rollback-',
    });
    const workspace = `${root}/workspace`;
    const state = `${root}/state`;
    await Deno.mkdir(workspace);
    const store = new DenoSessionStore(state, workspace);
    const handle = await store.allocate('default');
    const basePersistence = createSessionPersistence(
      handle,
      workspace,
      'default',
    );
    let rollbackCalls = 0;
    const persistence = {
      get record() {
        return basePersistence.record;
      },
      commit(
        transcript: readonly Message[],
        nextTurn: number,
        updatedAt: string,
      ): void {
        basePersistence.commit(transcript, nextTurn, updatedAt);
      },
      rollback(): void {
        rollbackCalls += 1;
        if (rollbackFails) throw new Error('injected queue rollback failure');
        basePersistence.rollback();
      },
      close(): Promise<void> {
        return basePersistence.close();
      },
    };
    let releaseFirst!: (
      result: { readonly kind: 'final'; readonly text: string },
    ) => void;
    let releaseSecond!: (
      result: { readonly kind: 'final'; readonly text: string },
    ) => void;
    const requests: ModelRequest[] = [];
    const model = {
      generate(request: ModelRequest) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          return new Promise<{ readonly kind: 'final'; readonly text: string }>(
            (resolve) => {
              releaseFirst = resolve;
            },
          );
        }
        if (requests.length === 2) {
          return new Promise<{ readonly kind: 'final'; readonly text: string }>(
            (resolve) => {
              releaseSecond = resolve;
            },
          );
        }
        const user = request.transcript.at(-1);
        return {
          kind: 'final' as const,
          text: user?.role === 'user' ? `answer:${user.content.text}` : 'answer',
        };
      },
    };
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const events: AgentEvent[] = [];
    const session = new AgentSession(model, new Registry([]), {
      persistence,
      eventSink(event) {
        events.push(event);
        renderer.eventSink(event);
        if (event.kind === 'turn_end' && event.turn === 2) {
          throw new Error('injected queue event failure');
        }
      },
    });
    const controller = new TuiController(lifecycle, renderer, session);
    await lifecycle.acquire();
    const running = controller.run();
    let runningFailure: unknown;
    const settled = running.then(
      () => undefined,
      (error) => runningFailure = error,
    );
    terminal.push('manual\n');
    for (let attempt = 0; attempt < 20 && requests.length < 1; attempt += 1) {
      await Promise.resolve();
    }
    assertEquals(requests.length, 1);
    terminal.push('queued\x1b[27;3;13~');
    await Promise.resolve();
    assertEquals(persistence.record, undefined);
    releaseFirst({ kind: 'final', text: 'answer:manual' });
    for (let attempt = 0; attempt < 20 && requests.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    assertEquals(requests.length, 2);
    assertEquals(persistence.record?.nextTurn, 2);
    const committedN = await store.read(handle.id);
    assertEquals(committedN.transcript.map(messageSummary), [
      'manual',
      'answer:manual',
    ]);
    assertEquals(requests[1].transcript.map(messageSummary), [
      'manual',
      'answer:manual',
      'queued',
    ]);
    releaseSecond({ kind: 'final', text: 'answer:queued' });

    await settled;
    const failure = runningFailure;
    assert(failure instanceof Error);
    assertEquals(
      (failure as { readonly code?: string }).code,
      'output_failure',
    );
    assertEquals(rollbackCalls, 1);
    assertEquals(requests.length, 2);
    assert(renderer.isClosing);
    assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
    const writes = terminal.writes.length;
    let lateRejected = false;
    try {
      renderer.eventSink({
        kind: 'assistant_progress',
        turn: 2,
        text: 'late queue output',
      });
    } catch {
      lateRejected = true;
    }
    assert(lateRejected);
    assertEquals(terminal.writes.length, writes);

    const after = await store.read(handle.id);
    if (rollbackFails) {
      assertEquals(after.nextTurn, 3);
      assertEquals(after.transcript.map(messageSummary), [
        'manual',
        'answer:manual',
        'queued',
        'answer:queued',
      ]);
    } else {
      assertEquals(after, committedN);
      assertEquals(
        session.transcriptSnapshot().map(messageSummary),
        committedN.transcript.map(messageSummary),
      );
    }
    await session.close();
    await Deno.remove(root, { recursive: true });
  };

  await runCase(false);
  await runCase(true);
});

Deno.test('queued persistence commit failure drops the slot with one restore and no late writes', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-follow-up-commit-failure-',
  });
  try {
    const workspace = `${root}/workspace`;
    const state = `${root}/state`;
    await Deno.mkdir(workspace);
    const store = new DenoSessionStore(state, workspace);
    const handle = await store.allocate('default');
    const basePersistence = createSessionPersistence(
      handle,
      workspace,
      'default',
    );
    let commitCalls = 0;
    const persistence = {
      get record() {
        return basePersistence.record;
      },
      commit(
        transcript: readonly Message[],
        nextTurn: number,
        updatedAt: string,
      ): void {
        commitCalls += 1;
        if (commitCalls === 2) throw new Error('injected queue commit failure');
        basePersistence.commit(transcript, nextTurn, updatedAt);
      },
      rollback(): void {
        basePersistence.rollback();
      },
      close(): Promise<void> {
        return basePersistence.close();
      },
    };
    const requests: ModelRequest[] = [];
    let releaseFirst!: (
      result: { readonly kind: 'final'; readonly text: string },
    ) => void;
    const model = {
      generate(request: ModelRequest) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          return new Promise<{ readonly kind: 'final'; readonly text: string }>(
            (resolve) => {
              releaseFirst = resolve;
            },
          );
        }
        const user = request.transcript.at(-1);
        return {
          kind: 'final' as const,
          text: user?.role === 'user' ? `answer:${user.content.text}` : 'answer',
        };
      },
    };
    const terminal = new FakeTerminal();
    const renderer = new TuiRenderer(terminal);
    const lifecycle = new TerminalLifecycle(terminal, renderer);
    const session = new AgentSession(model, new Registry([]), { persistence });
    const controller = new TuiController(lifecycle, renderer, session);
    await lifecycle.acquire();
    const running = controller.run();
    terminal.push('manual\n');
    for (let attempt = 0; attempt < 20 && requests.length < 1; attempt += 1) {
      await Promise.resolve();
    }
    assertEquals(requests.length, 1);
    terminal.push('queued\x1b\r');
    await Promise.resolve();
    assertEquals(persistence.record, undefined);
    releaseFirst({ kind: 'final', text: 'answer:manual' });
    for (let attempt = 0; attempt < 20 && requests.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    assertEquals(requests.length, 2);

    let failure: unknown;
    try {
      await running;
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof TuiControllerError);
    assertEquals((failure as TuiControllerError).code, 'agent_failure');
    assertEquals(commitCalls, 2);
    assertEquals(requests.length, 2);
    assertEquals(session.transcriptSnapshot().map(messageSummary), [
      'manual',
      'answer:manual',
    ]);
    const durable = await store.read(handle.id);
    assertEquals(durable.nextTurn, 2);
    assertEquals(durable.transcript.map(messageSummary), [
      'manual',
      'answer:manual',
    ]);
    assert(renderer.isClosing);
    assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
    assert(!terminal.writes.join('').includes('user> queued'));
    const writes = terminal.writes.length;
    let lateRejected = false;
    try {
      renderer.eventSink({
        kind: 'assistant_progress',
        turn: 2,
        text: 'late commit output',
      });
    } catch {
      lateRejected = true;
    }
    assert(lateRejected);
    assertEquals(terminal.writes.length, writes);
    await session.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('persistent default TUI prepares manifest before any store operation', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-manifest-tui-',
  });
  try {
    const workspace = `${root}/workspace`;
    const state = `${root}/state`;
    await Deno.mkdir(workspace);
    await Deno.mkdir(state);
    await Deno.writeTextFile(`${state}/sentinel`, 'untouched');
    const cases: readonly string[][] = [
      [],
      ['--continue'],
      ['--session', '00000000-0000-4000-8000-000000000001'],
      ['--no-session'],
    ];
    for (const args of cases) {
      const terminal = new FakeTerminal();
      let modelMaterializations = 0;
      let registryMaterializations = 0;
      let credentialReads = 0;
      let fetches = 0;
      let displayProjections = 0;
      const exit = await main(args, {
        terminal,
        stateRoot: state,
        runtimeSeam: {
          workspaceRoot: workspace,
          credential: 'offline-dummy',
          fetcher: () => {
            fetches += 1;
            return Promise.reject(new Error('must not fetch'));
          },
          credentialSource: () => {
            credentialReads += 1;
            return 'offline-dummy';
          },
          resolvedManifestFactory: () => ({}),
          onModelMaterialized: () => modelMaterializations += 1,
          onRegistryMaterialized: () => registryMaterializations += 1,
          onDisplayStateProjected: () => displayProjections += 1,
        },
        writeStderr: () => {},
      });
      assertEquals(exit, 1, JSON.stringify(args));
      assertEquals(modelMaterializations, 0, JSON.stringify(args));
      assertEquals(registryMaterializations, 0, JSON.stringify(args));
      assertEquals(credentialReads, 0, JSON.stringify(args));
      assertEquals(fetches, 0, JSON.stringify(args));
      assertEquals(displayProjections, 0, JSON.stringify(args));
      assertEquals(terminal.raw, [], JSON.stringify(args));
      assertEquals(terminal.writes, [], JSON.stringify(args));
      assertEquals(await Deno.readTextFile(`${state}/sentinel`), 'untouched');
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('persistent manifest failures leave new, continue, and exact state trees unchanged', async () => {
  const cases: readonly {
    readonly name: string;
    readonly args: readonly string[];
  }[] = [
    { name: 'new', args: [] },
    { name: 'continue', args: ['--continue'] },
    { name: 'exact', args: [] },
  ];
  for (const testCase of cases) {
    const root = await Deno.makeTempDir({
      dir: '/tmp',
      prefix: 'henji-manifest-state-',
    });
    try {
      const workspace = `${root}/workspace`;
      const state = `${root}/state`;
      await Deno.mkdir(workspace);
      let args = testCase.args;
      if (testCase.name !== 'new') {
        const id = await seedSession(
          state,
          workspace,
          normalTranscript(1),
        );
        args = testCase.name === 'exact' ? ['--session', id] : args;
      }
      const before = await inventoryStateTree(state);
      const terminal = new FakeTerminal();
      let modelMaterializations = 0;
      let registryMaterializations = 0;
      let credentialReads = 0;
      let fetches = 0;
      let displayProjections = 0;
      const exit = await main(args, {
        terminal,
        stateRoot: state,
        runtimeSeam: {
          workspaceRoot: workspace,
          credential: 'offline-dummy',
          fetcher: () => {
            fetches += 1;
            return Promise.reject(new Error('must not fetch'));
          },
          credentialSource: () => {
            credentialReads += 1;
            return 'offline-dummy';
          },
          resolvedManifestFactory: () => ({}),
          onModelMaterialized: () => modelMaterializations += 1,
          onRegistryMaterialized: () => registryMaterializations += 1,
          onDisplayStateProjected: () => displayProjections += 1,
        },
        writeStderr: () => {},
      });
      assertEquals(exit, 1, testCase.name);
      assertEquals(modelMaterializations, 0, testCase.name);
      assertEquals(registryMaterializations, 0, testCase.name);
      assertEquals(credentialReads, 0, testCase.name);
      assertEquals(fetches, 0, testCase.name);
      assertEquals(displayProjections, 0, testCase.name);
      assertEquals(terminal.raw, [], testCase.name);
      assertEquals(terminal.writes, [], testCase.name);
      assertEquals(await inventoryStateTree(state), before, testCase.name);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('orientation write failure restores terminal and removes an empty new session', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-orientation-failure-',
  });
  try {
    const workspace = `${root}/workspace`;
    const state = `${root}/state`;
    await Deno.mkdir(workspace);
    const terminal = new FakeTerminal();
    terminal.failOrientation = true;
    let stderr = '';
    const exit = await main([], {
      terminal,
      stateRoot: state,
      runtimeSeam: {
        workspaceRoot: workspace,
        fetcher: () => Promise.reject(new Error('must not fetch')),
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });
    assertEquals(exit, 1);
    assert(stderr.includes('"code":"terminal_failure"'));
    assertEquals(terminal.raw.filter((mode) => mode === false).length, 1);
    assertEquals(
      terminal.writes.filter((text) => text === '\x1b[?2004l').length,
      1,
    );
    assertEquals(terminal.orientationAttempts, 1);
    assert(!terminal.writes.some((text) => text.includes('user> ')));
    const store = new DenoSessionStore(state, workspace);
    assertEquals((await store.list()).sessions, []);
    const remaining = await inventoryStateTree(state);
    assert(remaining.every((entry) => !entry.includes('session.json')));
    assert(remaining.every((entry) => !entry.includes('.tmp')));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('valid manifest with invalid resumed metadata closes safely and permits later lock reopen', async () => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (
      record: Record<string, unknown>,
      workspace: string,
    ) => void;
  }[] = [
    {
      name: 'workspace metadata',
      mutate: (record) => record.workspaceRoot = '/invalid/resumed-workspace',
    },
    {
      name: 'agent metadata',
      mutate: (record) => record.agent = 'planner',
    },
  ];
  for (const testCase of cases) {
    const root = await Deno.makeTempDir({
      dir: '/tmp',
      prefix: 'henji-manifest-resume-',
    });
    try {
      const workspace = `${root}/workspace`;
      const state = `${root}/state`;
      await Deno.mkdir(workspace);
      const id = await seedSession(state, workspace, normalTranscript(1));
      const paths = await sessionPaths(state, workspace);
      const recordPath = `${paths.sessions}/${id}/session.json`;
      const original = await Deno.readTextFile(recordPath);
      const mutated = JSON.parse(original) as Record<string, unknown>;
      testCase.mutate(mutated, workspace);
      await Deno.writeTextFile(recordPath, `${JSON.stringify(mutated)}\n`);
      const before = await inventoryStateTree(state);
      const terminal = new FakeTerminal();
      let materializations = 0;
      const exit = await main(['--session', id], {
        terminal,
        stateRoot: state,
        runtimeSeam: {
          workspaceRoot: workspace,
          credential: 'offline-dummy',
          fetcher: () => Promise.reject(new Error('must not fetch')),
          onModelMaterialized: () => materializations += 1,
          onRegistryMaterialized: () => materializations += 1,
        },
        writeStderr: () => {},
      });
      assertEquals(exit, 1, testCase.name);
      assertEquals(materializations, 0, testCase.name);
      assertEquals(terminal.raw, [], testCase.name);
      assertEquals(await inventoryStateTree(state), before, testCase.name);

      await Deno.writeTextFile(recordPath, original);
      const store = new DenoSessionStore(state, workspace);
      const reopened = await store.openExisting(id);
      await reopened.close();
      const reopenedAgain = await store.openExisting(id);
      await reopenedAgain.close();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('TUI output and persisted record omit manifest domain and identity', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-manifest-output-',
  });
  try {
    const workspace = `${root}/workspace`;
    const state = `${root}/state`;
    await Deno.mkdir(workspace);
    const terminal = new FakeTerminal();
    assertEquals(await runTui([], terminal, workspace, state, 'surface'), 0);
    const output = terminal.writes.join('');
    const store = new DenoSessionStore(state, workspace);
    const listed = await store.list();
    assertEquals(listed.sessions.length, 1);
    const record = await store.read(listed.sessions[0].id);
    for (
      const value of [
        output,
        JSON.stringify(record),
      ]
    ) {
      assert(!value.includes('henji-agent-resolved-manifest:v1'));
      assert(
        !value.includes(
          'bdf0e5c7e70ac5d928aab4681bb3228c642d0af89a498ae9f3f9c2940f7a4a58',
        ),
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
