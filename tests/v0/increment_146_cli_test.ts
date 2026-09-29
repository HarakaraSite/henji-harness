import { deepStrictEqual, strictEqual, throws } from 'node:assert';
import { parseRemoteTuiInvocation } from '../../v0/agent/cli/remote_tui_cli.ts';
import { parseTuiInvocation } from '../../v0/agent/cli/session_invocation.ts';
import { main as tuiMain } from '../../v0/agent/cli/tui_cli.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';

class StartupTerminal implements TerminalPort {
  rawCalls = 0;
  stdinIsTerminal(): boolean {
    return true;
  }
  stdoutIsTerminal(): boolean {
    return true;
  }
  consoleSize(): { columns: number; rows: number } {
    return { columns: 100, rows: 28 };
  }
  setRaw(): void {
    this.rawCalls += 1;
  }
  read(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }
  drainAndCloseInput(): Promise<void> {
    return Promise.resolve();
  }
  write(): void {}
  writeFrame(): void {}
  addSignal(): void {}
  removeSignal(): void {}
}

Deno.test('Increment 146 normal TUI grammar carries all activation flags without an argument-count ceiling', () => {
  const args = [
    '--new',
    '--agent',
    'generic',
    '--max-steps',
    '8',
    '--provider-timeout-ms',
    '40000',
    '--root-provider',
    'openrouter-responses',
  ];
  deepStrictEqual(parseRemoteTuiInvocation(args), {
    target: { kind: 'new' },
    activation: {
      agent: 'generic',
      maxSteps: 8,
      providerTimeoutMs: 40000,
      rootProvider: 'openrouter-responses',
    },
  });
  strictEqual(
    parseRemoteTuiInvocation(['--connect', 'http://127.0.0.1:5270', ...args]).url,
    'http://127.0.0.1:5270',
  );
  const sessionId = '14600000-0000-4000-8000-000000000001';
  strictEqual(parseTuiInvocation(['--session', sessionId, ...args.slice(1)]).sessionId, sessionId);
  deepStrictEqual(parseRemoteTuiInvocation([]), { target: { kind: 'implicit' } });
  throws(() => parseRemoteTuiInvocation(['--definition-revision', 'malformed']));
});

Deno.test('Increment 146 invalid invocation and an unreachable explicit URL fail before terminal acquisition', async () => {
  const terminal = new StartupTerminal();
  let text = '';
  strictEqual(
    await tuiMain(['--definition-revision', 'malformed'], {
      terminal,
      writeStderr: (value) => {
        text += value;
      },
    }),
    1,
  );
  strictEqual(JSON.parse(text).error.code, 'invalid_invocation');
  strictEqual(terminal.rawCalls, 0);
  text = '';
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  strictEqual(
    await tuiMain(['--connect', `http://127.0.0.1:${port}`], {
      terminal,
      writeStderr: (value) => {
        text += value;
      },
    }),
    1,
  );
  strictEqual(text, 'core connection failed\n');
  strictEqual(terminal.rawCalls, 0);
});

Deno.test('Increment 146 root and command help work without local environment or startup permissions', async () => {
  const entry = new URL('../../v0/agent/cli/henji_cli.ts', import.meta.url).pathname;
  const config = new URL('../../deno.v0.json', import.meta.url).pathname;
  for (const args of [['--help'], ['tui', '--help'], ['core', 'stop', '--help']]) {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ['run', '--no-prompt', '--cached-only', '--config', config, entry, ...args],
      clearEnv: true,
      cwd: '/tmp',
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    strictEqual(result.code, 0, new TextDecoder().decode(result.stderr));
    strictEqual(new TextDecoder().decode(result.stdout).startsWith('Usage: henji'), true);
  }
});
