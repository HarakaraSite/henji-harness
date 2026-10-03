import { stripVTControlCharacters } from 'node:util';
import { ok, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { runRemoteTui } from '../../v0/tui/remote_session.ts';
import { encodeScreenFrame, type ScreenFrame, type TerminalPort } from '../../v0/tui/terminal.ts';

class ShutdownTerminal implements TerminalPort {
  readonly output: string[] = [];
  readonly frames: ScreenFrame[] = [];
  raw = false;
  private readonly input: Uint8Array[] = [];
  private pendingRead?: (value: Uint8Array | null) => void;
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
    return next === undefined
      ? new Promise((resolve) => this.pendingRead = resolve)
      : Promise.resolve(next);
  }
  push(text: string): void {
    const bytes = new TextEncoder().encode(text);
    if (this.pendingRead === undefined) this.input.push(bytes);
    else {
      const resolve = this.pendingRead;
      this.pendingRead = undefined;
      resolve(bytes);
    }
  }
  drainAndCloseInput(): Promise<void> {
    this.pendingRead?.(null);
    this.pendingRead = undefined;
    return Promise.resolve();
  }
  write(bytes: Uint8Array): void {
    this.output.push(new TextDecoder().decode(bytes));
  }
  writeFrame(frame: ScreenFrame, onWritten?: () => void): void {
    this.frames.push(frame);
    this.write(encodeScreenFrame(frame));
    onWritten?.();
  }
  addSignal(): void {}
  removeSignal(): void {}
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for TUI shutdown');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

for (const control of ['slash', 'shortcut'] as const) {
  Deno.test(`Increment 155 ${control} stops the attached Core after drain and disconnects another TUI`, async () => {
    const root = await Deno.makeTempDir({ prefix: 'henji-i155-shutdown-' });
    const core = await createCoreService({
      workspaceRoot: root,
      configRoot: `${root}/config`,
      dataRoot: `${root}/data`,
      stateRoot: `${root}/state`,
      physicalIoMode: 'production',
      agent: 'default',
    });
    let drainReached = false;
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => releaseDrain = resolve);
    const server = await startCoreServer(core, {
      onServiceClosed: async () => {
        drainReached = true;
        await drain;
      },
    });
    const client = new HenjiApiClient(server.url);
    const terminal = new ShutdownTerminal();
    const observer = new ShutdownTerminal();
    const errors: string[] = [];
    let main: Promise<number> | undefined;
    let other: Promise<number> | undefined;
    try {
      const opened = await client.sessionOpen({
        commandId: crypto.randomUUID(),
        selection: { kind: 'new' },
      });
      strictEqual(opened.kind, 'accepted');
      if (opened.kind !== 'accepted') throw new Error('Session open failed');
      const id = opened.value.sessionId;
      let observerReady = false;
      other = runRemoteTui(server.url, id, {
        terminal: observer,
        afterAcquire: () => {
          observerReady = true;
        },
        writeStderr: (text) => {
          errors.push(text);
        },
      });
      await waitFor(() => observerReady);
      let mainReady = false;
      let mainFinished = false;
      main = runRemoteTui(server.url, id, {
        terminal,
        afterAcquire: () => {
          mainReady = true;
        },
        writeStderr: (text) => {
          errors.push(text);
        },
      });
      void main.then(() => mainFinished = true);
      await waitFor(() => mainReady);
      terminal.push('/');
      await waitFor(() => terminal.frames.at(-1)?.rows.some((row) => row.includes('> /')) ?? false);
      strictEqual(
        terminal.frames.at(-1)?.rows.join('\n').includes('cmds:'),
        false,
      );
      terminal.push('s');
      await waitFor(() => terminal.frames.at(-1)?.rows.join('\n').includes('> /sessions') ?? false);
      terminal.push('\x1b');
      await new Promise((resolve) => setTimeout(resolve, 80));
      terminal.push('\x03');
      if (control === 'shortcut') {
        terminal.push('/help\r\r');
        await waitFor(() =>
          stripVTControlCharacters(terminal.frames.at(-1)?.rows.join('\n') ?? '').includes(
            'Stop Core │ /quit │ Ctrl-Q',
          ) ?? false
        );
        terminal.push('\x1b');
        terminal.push('\x11');
      } else terminal.push('/qui\t\r');
      await waitFor(() => drainReached);
      await waitFor(() => observer.output.join('').includes('DISCONNECTED'));
      strictEqual(
        mainFinished,
        false,
        'TUI exited before Core resource drain completed',
      );
      strictEqual((await fetch(`${server.url}/api/v1/core`)).status, 503);
      strictEqual(terminal.output.join('').includes('shutting down Core'), false);
      releaseDrain();
      strictEqual(await main, 0);
      await server.finished;
      strictEqual(terminal.raw, false);
      ok(terminal.output.join('').includes('\x1b[?1049l'));
      // A separate client keeps its terminal until its user detaches.
      strictEqual(observer.raw, true);
      observer.push('/detach\r\r');
      strictEqual(await other, 0);
      strictEqual(observer.raw, false);
      strictEqual(errors.join(''), '');
    } finally {
      releaseDrain();
      terminal.push('\x04');
      observer.push('\x04');
      await Promise.all([main, other]);
      await server.shutdown();
      await Deno.remove(root, { recursive: true });
    }
  });
}
