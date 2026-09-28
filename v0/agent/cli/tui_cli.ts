import { DenoTerminal } from '../../tui/terminal.ts';
import { parseRemoteTuiInvocation, runRemoteTuiInvocation } from './remote_tui_cli.ts';
import type { RemoteTuiDependencies } from '../../tui/remote_session.ts';

const encoder = new TextEncoder();

/** Both normal and explicit TUI entry use the same HTTP client and Core launcher. */
export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: RemoteTuiDependencies = {},
): Promise<number> => {
  const stderr = dependencies.writeStderr ?? (async (text: string) => {
    await Deno.stderr.write(encoder.encode(text));
  });
  let invocation: ReturnType<typeof parseRemoteTuiInvocation>;
  try {
    invocation = parseRemoteTuiInvocation(args);
  } catch (error) {
    await stderr(
      JSON.stringify({
        ok: false,
        error: {
          code: 'invalid_invocation',
          message: error instanceof Error ? error.message : 'invalid invocation',
        },
      }) + '\n',
    );
    return 1;
  }
  const terminal = dependencies.terminal ?? new DenoTerminal();
  if (!terminal.stdinIsTerminal() || !terminal.stdoutIsTerminal()) {
    await stderr('TUI requires a terminal\n');
    return 1;
  }
  try {
    return await runRemoteTuiInvocation(invocation, { ...dependencies, terminal });
  } catch (error) {
    await stderr(
      JSON.stringify({
        ok: false,
        error: {
          code: 'startup_failure',
          message: error instanceof Error ? error.message : 'Core startup failed',
        },
      }) + '\n',
    );
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
