import { createRuntimeSession, type RuntimeTestSeam } from './runtime.ts';
import { AgentSession } from './session.ts';
import { type AgentEventSink } from './events.ts';
import { TuiController, TuiControllerError } from '../tui/controller.ts';
import { TuiRenderer } from '../tui/render.ts';
import { DenoTerminal, TerminalLifecycle, type TerminalPort } from '../tui/terminal.ts';

const encoder = new TextEncoder();

export interface TuiSessionFactoryResult {
  readonly session: Pick<AgentSession, 'submit'>;
  readonly requestCount?: () => number;
}

export interface TuiCliDependencies {
  readonly terminal?: TerminalPort;
  readonly runtimeSeam?: RuntimeTestSeam;
  readonly createSession?: (eventSink: AgentEventSink) => Promise<TuiSessionFactoryResult>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
  /** Test-only crash injection, invoked after raw acquisition and before controller.run. */
  readonly afterAcquire?: () => void | Promise<void>;
}

const fatalMessages: Record<string, string> = {
  invalid_invocation: 'invalid invocation',
  startup_failure: 'startup failure',
  terminal_failure: 'terminal failure',
  input_failure: 'input failure',
  output_failure: 'output failure',
  agent_failure: 'agent failure',
};

const failureLine = (code: keyof typeof fatalMessages): string =>
  JSON.stringify({ ok: false, error: { code, message: fatalMessages[code] } }) + '\n';

type CrashGuard = {
  readonly close: () => void;
  readonly hasFatal: () => boolean;
};

const installCrashGuard = (
  lifecycle: TerminalLifecycle,
  onFatal: () => void,
): CrashGuard => {
  let handling = false;
  const restore = (): void => {
    if (handling) return;
    handling = true;
    onFatal();
    void lifecycle.restore();
  };
  const onError = (event: Event): void => {
    event.preventDefault();
    restore();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    event.preventDefault();
    restore();
  };
  globalThis.addEventListener('error', onError);
  globalThis.addEventListener('unhandledrejection', onRejection);
  return {
    close: () => {
      globalThis.removeEventListener('error', onError);
      globalThis.removeEventListener('unhandledrejection', onRejection);
    },
    hasFatal: () => handling,
  };
};

/** Explicit zero-argv, real-TTY-only TUI command. */
export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: TuiCliDependencies = {},
): Promise<number> => {
  const stderr = dependencies.writeStderr ?? (async (text: string) => {
    await Deno.stderr.write(encoder.encode(text));
  });
  const terminal = dependencies.terminal ?? new DenoTerminal();
  if (args.length !== 0 || !terminal.stdinIsTerminal() || !terminal.stdoutIsTerminal()) {
    await stderr(failureLine('invalid_invocation'));
    return 1;
  }

  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  let crashGuard: CrashGuard | undefined;
  let acquisitionStarted = false;
  try {
    const sessionFactory = dependencies.createSession ?? (async (eventSink) => {
      const result = await createRuntimeSession(eventSink, dependencies.runtimeSeam);
      return { session: result.session, requestCount: result.requestCount };
    });
    // Composition occurs before raw acquisition, so startup failures never touch terminal mode.
    const created = await sessionFactory(renderer.eventSink);
    const controller = new TuiController(lifecycle, renderer, created.session);
    controller.installSignals();
    let crashDetected = false;
    crashGuard = installCrashGuard(lifecycle, () => {
      crashDetected = true;
      controller.handleCrash();
    });
    acquisitionStarted = true;
    await lifecycle.acquire();
    await dependencies.afterAcquire?.();
    const exitCode = await controller.run();
    if (crashDetected || crashGuard.hasFatal()) {
      await stderr(failureLine('terminal_failure'));
      return 1;
    }
    return exitCode;
  } catch (error) {
    const code = error instanceof TuiControllerError
      ? error.code
      : acquisitionStarted
      ? 'terminal_failure'
      : 'startup_failure';
    await stderr(failureLine(code as keyof typeof fatalMessages));
    return 1;
  } finally {
    crashGuard?.close();
    await lifecycle.restore();
  }
};

if (import.meta.main) Deno.exit(await main());
