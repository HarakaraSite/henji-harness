import { ok, strictEqual } from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import type { ScreenFrame, TerminalPort } from '../../v0/tui/terminal.ts';

class PreparationTerminal implements TerminalPort {
  readonly frames: ScreenFrame[] = [];
  private readonly queued: Uint8Array[] = [];
  private reader?: (input: Uint8Array | null) => void;
  stdinIsTerminal() {
    return true;
  }
  stdoutIsTerminal() {
    return true;
  }
  consoleSize() {
    return { columns: 110, rows: 32 };
  }
  setRaw() {}
  write() {}
  writeFrame(frame: ScreenFrame, written?: () => void) {
    this.frames.push(frame);
    written?.();
  }
  addSignal() {}
  removeSignal() {}
  read(): Promise<Uint8Array | null> {
    const input = this.queued.shift();
    return input ? Promise.resolve(input) : new Promise((resolve) => this.reader = resolve);
  }
  push(text: string) {
    const input = new TextEncoder().encode(text);
    if (this.reader) {
      const resolve = this.reader;
      this.reader = undefined;
      resolve(input);
    } else this.queued.push(input);
  }
  drainAndCloseInput(): Promise<void> {
    this.reader?.(null);
    this.reader = undefined;
    return Promise.resolve();
  }
  text() {
    return stripVTControlCharacters(this.frames.at(-1)?.rows.join('\n') ?? '');
  }
}

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('TUI preparation operation did not complete');
};

Deno.test('Increment 170 TUI F1 cancels its visible preparing reservation before the task receipt', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-tui-preparing-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let held = false;
  let turns = 0;
  const core = await createCoreService({
    workspaceRoot,
    stateRoot: `${root}/state`,
    configRoot: `${root}/config`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      return {
        send(command, transfer) {
          if (command.kind === 'turn') turns++;
          if (command.kind === 'start') {
            held = true;
            void gate.then(() => capsule.send(command, transfer));
          } else capsule.send(command, transfer);
        },
        subscribe: (listener) => capsule.subscribe(listener),
        terminate: () => capsule.terminate(),
      };
    },
  });
  const server = await startCoreServer(core);
  const client = new HenjiApiClient(server.url);
  const sessionId = core.coreRead().activeSessionId!;
  const terminal = new PreparationTerminal();
  const run = runRemoteTui(server.url, sessionId, { terminal });
  try {
    await waitFor(() => terminal.text().includes('Enter submit'));
    terminal.push('Cancel before its task receipt\r');
    await waitFor(() => held && terminal.text().includes('F1 cancel'));
    const preparing = await client.sessionRead(sessionId);
    strictEqual(preparing.runtime.phase, 'preparing');
    const executionId = preparing.runtime.reservation?.executionId;
    ok(executionId);
    terminal.push('\x1bOP');
    await waitFor(() => terminal.text().includes('cancelling'));
    release();
    await waitFor(async () => (await client.sessionRead(sessionId)).runtime.phase === 'idle');
    const saved = await client.executionRead(executionId);
    strictEqual(saved.execution.outcome, 'cancelled');
    strictEqual(saved.execution.adoption, 'non_canonical');
    strictEqual(turns, 0);
    await waitFor(() =>
      terminal.text().includes('CANCELLED') && terminal.text().includes('Enter submit')
    );
    strictEqual((await client.sessionRead(sessionId)).session.position.committedTurn, 0);
    terminal.push('\x04');
    strictEqual(await run, 0);
  } finally {
    release();
    terminal.push('\x04');
    await run;
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
