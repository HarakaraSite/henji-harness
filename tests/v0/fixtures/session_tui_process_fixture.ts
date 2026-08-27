import { main } from '../../../v0/agent/tui_cli.ts';

const [stateRoot, workspaceRoot] = Deno.args;
if (stateRoot === undefined || workspaceRoot === undefined) Deno.exit(2);

class ImmediateExitTerminal {
  stdinIsTerminal(): boolean {
    return true;
  }

  stdoutIsTerminal(): boolean {
    return true;
  }

  consoleSize(): { columns: number; rows: number } {
    return { columns: 80, rows: 24 };
  }

  setRaw(_mode: boolean, _options?: { cbreak: boolean }): void {}

  read(): Promise<Uint8Array | null> {
    return Promise.resolve(new Uint8Array([0x04]));
  }

  drainAndCloseInput(_maxMs: number, _idleMs: number): Promise<void> {
    return Promise.resolve();
  }

  write(_bytes: Uint8Array): void {}

  addSignal(_signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', _handler: () => void): void {}

  removeSignal(_signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', _handler: () => void): void {}
}

const response = new Response(
  JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'unused' } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const exitCode = await main([], {
  terminal: new ImmediateExitTerminal(),
  stateRoot,
  runtimeSeam: {
    workspaceRoot,
    credential: 'offline-dummy',
    fetcher: () => Promise.resolve(response.clone()),
  },
  writeStderr: () => {},
});
Deno.exit(exitCode);
