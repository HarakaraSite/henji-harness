import { assert, assertEquals } from './test_helpers.ts';
import { main } from '../../v0/agent/tui_cli.ts';
import { createSessionPersistence, DenoSessionStore } from '../../v0/agent/session_store.ts';
import { type Message } from '../../v0/agent/contracts.ts';

const encoder = new TextEncoder();
const response = (text: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

class FakeTerminal {
  readonly writes: string[] = [];
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
  setRaw(): void {}
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
    this.writes.push(new TextDecoder().decode(bytes));
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
      { role: 'assistant', content: { kind: 'text', text: `replay-assistant-${index}` } },
    );
  }
  return messages;
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

Deno.test('persistent TUI autosaves and continue restores the parent transcript', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-tui-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const firstTerminal = new FakeTerminal();
  assertEquals(await runTui([], firstTerminal, workspace, state, 'first'), 0);
  const store = new DenoSessionStore(state, workspace);
  const listed = await store.list();
  assertEquals(listed.sessions.length, 1);
  assert(firstTerminal.writes.some((line) => line.includes('(new)')));
  const secondTerminal = new FakeTerminal();
  assertEquals(await runTui(['--continue'], secondTerminal, workspace, state, 'second'), 0);
  const resumed = await store.list();
  assertEquals(resumed.sessions[0].turnCount, 2);
  assert(secondTerminal.writes.some((line) => line.includes('(resumed)')));
  assert(secondTerminal.writes.some((line) => line.includes('user> first')));
  const ephemeralState = `${root}/must-not-exist`;
  const ephemeralTerminal = new FakeTerminal();
  assertEquals(
    await runTui(['--no-session'], ephemeralTerminal, workspace, ephemeralState, 'ephemeral'),
    0,
  );
  let absent = false;
  try {
    await Deno.stat(ephemeralState);
  } catch (error) {
    absent = error instanceof Deno.errors.NotFound;
  }
  assert(absent);

  const replayRoot = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-replay-' });
  const replayWorkspace = `${replayRoot}/workspace`;
  const replayState = `${replayRoot}/state`;
  await Deno.mkdir(replayWorkspace);
  const exactId = await seedSession(replayState, replayWorkspace, normalTranscript(50));
  const exactTerminal = new FakeTerminal();
  assertEquals(
    await runTuiExit(['--session', exactId], exactTerminal, replayWorkspace, replayState),
    0,
  );
  const exactOutput = exactTerminal.writes.join('');
  assertEquals((exactOutput.match(/user> replay-user-/g) ?? []).length, 50);
  assert(!exactOutput.includes('history> '));

  const boundaryMessages = normalTranscript(49);
  boundaryMessages.push(
    { role: 'user', content: { kind: 'text', text: 'replay-user-final' } },
    {
      role: 'assistant',
      content: [{ kind: 'tool_call', callId: 'replay-call', name: 'read', arguments: {} }],
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
  const boundaryId = await seedSession(replayState, replayWorkspace, boundaryMessages);
  const boundaryTerminal = new FakeTerminal();
  assertEquals(
    await runTuiExit(['--session', boundaryId], boundaryTerminal, replayWorkspace, replayState),
    0,
  );
  const boundaryOutput = boundaryTerminal.writes.join('');
  assertEquals((boundaryOutput.match(/user> replay-user-/g) ?? []).length, 49);
  assert(!boundaryOutput.includes('replay-user-0'));
  assert(boundaryOutput.includes('history> 1 messages omitted'));
  assert(boundaryOutput.includes('tool< read success> replay-result'));

  const immediateRoot = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-empty-' });
  const immediateWorkspace = `${immediateRoot}/workspace`;
  const immediateState = `${immediateRoot}/state`;
  await Deno.mkdir(immediateWorkspace);
  const immediateTerminal = new FakeTerminal();
  assertEquals(await runTuiExit([], immediateTerminal, immediateWorkspace, immediateState), 0);
  const immediateStore = new DenoSessionStore(immediateState, immediateWorkspace);
  assertEquals((await immediateStore.list()).sessions, []);
  await Deno.remove(immediateRoot, { recursive: true });
  await Deno.remove(replayRoot, { recursive: true });
  await Deno.remove(root, { recursive: true });
});
