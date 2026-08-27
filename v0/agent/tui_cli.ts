import { createRuntimeSession, type RuntimeTestSeam } from './runtime.ts';
import { type BuiltinAgentSelection, resolveBuiltinAgent } from './agent_catalog.ts';
import { AgentSession } from './session.ts';
import { type AgentEventSink } from './events.ts';
import { TuiController, TuiControllerError } from '../tui/controller.ts';
import { TuiRenderer } from '../tui/render.ts';
import { DenoTerminal, TerminalLifecycle, type TerminalPort } from '../tui/terminal.ts';
import { resolveWorkspace } from './work_tools.ts';
import {
  createSessionPersistence,
  DenoSessionStore,
  isSessionId,
  launcherStateRoot,
  restoredMessages,
  type SessionRecord,
  SessionStoreError,
} from './session_store.ts';
import { type Message } from './contracts.ts';

const encoder = new TextEncoder();

export interface TuiSessionFactoryResult {
  readonly session:
    & Pick<AgentSession, 'submit'>
    & Partial<Pick<AgentSession, 'cancelActiveTurn' | 'contextSnapshot'>>;
  readonly requestCount?: () => number;
  readonly close?: () => void | Promise<void>;
  readonly sessionLine?: string;
  readonly restored?: { readonly messages: readonly Message[]; readonly omitted: number };
}

export interface TuiCliDependencies {
  readonly terminal?: TerminalPort;
  readonly runtimeSeam?: RuntimeTestSeam;
  readonly createSession?: (
    eventSink: AgentEventSink,
    selection: BuiltinAgentSelection,
  ) => Promise<TuiSessionFactoryResult>;
  /** Direct-test-only state-root seam; production selects XDG_STATE_HOME/HOME. */
  readonly stateRoot?: string;
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

/** Parse the exact optional TUI selector. */
export const parseTuiArgs = (args: readonly string[]): string | undefined => {
  return parseTuiInvocation(args).rawAgentName;
};

export interface ParsedTuiInvocation {
  readonly rawAgentName: string | undefined;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  readonly sessionId?: string;
}

/** Parse both flag orders before terminal, workspace, state, provider, or credential setup. */
export const parseTuiInvocation = (args: readonly string[]): ParsedTuiInvocation => {
  if (args.length > 4) throw new Error('invalid invocation');
  let rawAgentName: string | undefined;
  let persistence: ParsedTuiInvocation['persistence'] = 'new';
  let sessionId: string | undefined;
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === '--agent') {
      const value = args[index + 1];
      if (rawAgentName !== undefined || value === undefined || value.length === 0) {
        throw new Error('invalid invocation');
      }
      rawAgentName = value;
      index += 2;
    } else if (flag === '--continue') {
      if (persistence !== 'new') throw new Error('invalid invocation');
      persistence = 'continue';
      index += 1;
    } else if (flag === '--session') {
      const value = args[index + 1];
      if (value === undefined || value.length === 0 || persistence !== 'new') {
        throw new Error('invalid invocation');
      }
      if (!isSessionId(value)) throw new Error('invalid invocation');
      sessionId = value;
      persistence = 'session';
      index += 2;
    } else if (flag === '--no-session') {
      if (persistence !== 'new') throw new Error('invalid invocation');
      persistence = 'none';
      index += 1;
    } else {
      throw new Error('invalid invocation');
    }
  }
  return { rawAgentName, persistence, ...(sessionId === undefined ? {} : { sessionId }) };
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
  let selection: BuiltinAgentSelection;
  let invocation: ParsedTuiInvocation;
  try {
    invocation = parseTuiInvocation(args);
    selection = resolveBuiltinAgent(invocation.rawAgentName);
  } catch {
    await stderr(failureLine('invalid_invocation'));
    return 1;
  }
  const terminal = dependencies.terminal ?? new DenoTerminal();
  if (!terminal.stdinIsTerminal() || !terminal.stdoutIsTerminal()) {
    await stderr(failureLine('invalid_invocation'));
    return 1;
  }

  const renderer = new TuiRenderer(terminal);
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  let crashGuard: CrashGuard | undefined;
  let acquisitionStarted = false;
  let createdResult: TuiSessionFactoryResult | undefined;
  try {
    let sessionFactory = dependencies.createSession;
    if (sessionFactory === undefined) {
      sessionFactory = async (eventSink, selected) => {
        if (invocation.persistence === 'none') {
          const result = await createRuntimeSession(eventSink, dependencies.runtimeSeam, selected);
          return {
            session: result.session,
            requestCount: result.requestCount,
            sessionLine: 'session> ephemeral',
          };
        }
        const workspace = await resolveWorkspace(dependencies.runtimeSeam?.workspaceRoot);
        const stateRoot = dependencies.stateRoot ?? launcherStateRoot();
        const store = new DenoSessionStore(stateRoot, workspace.root);
        let record: SessionRecord | undefined;
        let handle;
        if (invocation.persistence === 'continue') {
          const listed = await store.list();
          const first = listed.sessions.find((candidate) => candidate.agent === selected.id);
          if (first === undefined) throw new SessionStoreError('session_not_found');
          handle = await store.openExisting(first.id);
          record = handle.record;
        } else if (invocation.persistence === 'session') {
          handle = await store.openExisting(invocation.sessionId!);
          record = handle.record;
        } else {
          handle = await store.allocate(selected.id);
        }
        if (
          record !== undefined &&
          (record.workspaceRoot !== workspace.root || record.agent !== selected.id)
        ) {
          await handle.close();
          throw new SessionStoreError('session_invalid');
        }
        const persistence = createSessionPersistence(handle, workspace.root, selected.id, record);
        try {
          const result = await createRuntimeSession(
            eventSink,
            dependencies.runtimeSeam,
            selected,
            { persistence, initialRecord: record },
          );
          return {
            session: result.session,
            requestCount: result.requestCount,
            close: () => result.session.close(),
            sessionLine: `session> ${handle.id} ${record === undefined ? '(new)' : '(resumed)'}`,
            ...(record === undefined ? {} : (() => {
              const replay = restoredMessages(record.transcript);
              return { restored: { messages: replay.messages, omitted: replay.omitted } };
            })()),
          };
        } catch (error) {
          await persistence.close();
          throw error;
        }
      };
    }
    // Composition occurs before raw acquisition, so startup failures never touch terminal mode.
    const created = await sessionFactory(renderer.eventSink, selection);
    createdResult = created;
    const controller = new TuiController(lifecycle, renderer, created.session);
    controller.installSignals();
    let crashDetected = false;
    crashGuard = installCrashGuard(lifecycle, () => {
      crashDetected = true;
      controller.handleCrash();
    });
    acquisitionStarted = true;
    await lifecycle.acquire();
    if (created.sessionLine !== undefined) renderer.writeStatic(`${created.sessionLine}\n`);
    if (created.restored !== undefined) {
      renderer.renderRestored(created.restored.messages, created.restored.omitted);
    }
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
    // Session locks are released only after controller settlement and terminal restoration starts.
    // The factory close is idempotent for the production AgentSession/store adapter.
    // `created` is scoped below in older direct seams, so cleanup is installed through a local.
    crashGuard?.close();
    await lifecycle.restore();
    try {
      await createdResult?.close?.();
    } catch {
      // Session close is best effort during terminal shutdown.
    }
  }
};

if (import.meta.main) Deno.exit(await main());
