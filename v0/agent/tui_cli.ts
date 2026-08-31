import {
  createRuntimeSessionFromPrepared,
  prepareRuntimeComposition,
  type RuntimeTestSeam,
} from './runtime.ts';
import { type BuiltinAgentSelection, resolveBuiltinAgent } from './agent_catalog.ts';
import { AgentSession } from './session.ts';
import { type AgentEventSink } from './events.ts';
import { TuiController, TuiControllerError } from '../tui/controller.ts';
import { TuiRenderer } from '../tui/render.ts';
import { DenoTerminal, TerminalLifecycle, type TerminalPort } from '../tui/terminal.ts';
import {
  createSessionPersistence,
  DenoSessionStore,
  isSessionId,
  launcherStateRoot,
  restoredMessages,
  type SessionHandle,
  type SessionMetadata,
  type SessionRecord,
  SessionStoreError,
} from './session_store.ts';
import { type Message } from './contracts.ts';
import { type RuntimeDisplayState } from './startup_orientation.ts';
import { PendingInputCore } from '../tui/pending_input.ts';
import { TuiEditorHistory } from '../tui/input.ts';
import { buildWorkspacePathIndex, type WorkspacePathIndex } from '../tui/file_reference.ts';
import {
  type NavigationBinding,
  NavigationCancelledError,
  NavigationFatalError,
  type NavigationListing,
  type NavigationPosition,
  type SessionNavigationHost,
} from './session_navigation.ts';
import { type SessionHistoryPage } from './session_history.ts';

const encoder = new TextEncoder();

const throwIfNavigationAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new NavigationCancelledError();
};

/**
 * Commit the prepared target only after materialization and old-session close succeed.
 *
 * This small transaction seam is production-owned and is intentionally direct-testable: every
 * failure path must close the target factory/persistence, while a successful commit transfers
 * ownership exactly once.
 */
export interface NavigationSwitchTransaction {
  readonly signal?: AbortSignal;
  readonly materializeTarget: () => AgentSession;
  readonly closeTarget: () => Promise<void>;
  readonly closeCurrent: () => Promise<void>;
  readonly commitTarget: (session: AgentSession) => void;
}

export const runNavigationSwitchTransaction = async (
  transaction: NavigationSwitchTransaction,
): Promise<AgentSession> => {
  throwIfNavigationAborted(transaction.signal);
  let ownershipTransferred = false;
  try {
    const targetSession = transaction.materializeTarget();
    throwIfNavigationAborted(transaction.signal);
    try {
      await transaction.closeCurrent();
    } catch {
      throw new NavigationFatalError('current session close failed');
    }
    // Closing the old binding is irreversible. Once this boundary is crossed, an abort only
    // cancels the still-pending redraw; it must never send the caller back to the closed binding.
    transaction.commitTarget(targetSession);
    ownershipTransferred = true;
    return targetSession;
  } catch (error) {
    if (!ownershipTransferred) {
      try {
        await transaction.closeTarget();
      } catch {
        throw new NavigationFatalError('target session cleanup failed');
      }
    }
    throw error;
  }
};

export interface TuiSessionFactoryResult {
  readonly session:
    & Pick<AgentSession, 'submit'>
    & Partial<
      Pick<
        AgentSession,
        'cancelActiveTurn' | 'contextSnapshot' | 'steerActiveTurn' | 'isAvailable'
      >
    >;
  readonly requestCount?: () => number;
  readonly close?: () => void | Promise<void>;
  /** Canonical workspace root for the startup-bounded local path index. */
  readonly workspaceRoot?: string;
  readonly sessionLine?: string;
  readonly restored?: {
    readonly messages: readonly Message[];
    readonly omitted: number;
  };
  /** Every factory must provide the one startup projection; the TUI never recomputes it. */
  readonly displayState: RuntimeDisplayState;
  /** Persistent session host used by the idle-only Ctrl-G/Ctrl-T flows. */
  readonly navigation?: SessionNavigationHost;
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
  /** Direct-test opt-in for the Step 82 fixed-lane interaction. Production enables it by default. */
  readonly dailyEditor?: boolean;
  /** Direct/process-test path-index seam; production always builds from the canonical workspace. */
  readonly pathIndex?: WorkspacePathIndex;
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
export const parseTuiInvocation = (
  args: readonly string[],
): ParsedTuiInvocation => {
  if (args.length > 4) throw new Error('invalid invocation');
  let rawAgentName: string | undefined;
  let persistence: ParsedTuiInvocation['persistence'] = 'new';
  let sessionId: string | undefined;
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === '--agent') {
      const value = args[index + 1];
      if (
        rawAgentName !== undefined || value === undefined || value.length === 0
      ) {
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
  return {
    rawAgentName,
    persistence,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
};

const failureLine = (code: keyof typeof fatalMessages): string =>
  JSON.stringify({ ok: false, error: { code, message: fatalMessages[code] } }) +
  '\n';

type CrashGuard = {
  readonly close: () => void;
  readonly hasFatal: () => boolean;
};

const installCrashGuard = (
  onFatal: () => void,
): CrashGuard => {
  let handling = false;
  const restore = (): void => {
    if (handling) return;
    handling = true;
    onFatal();
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
  let resultCode = 1;
  try {
    let sessionFactory = dependencies.createSession;
    if (sessionFactory === undefined) {
      sessionFactory = async (eventSink, selected) => {
        if (invocation.persistence === 'none') {
          const prepared = await prepareRuntimeComposition(
            dependencies.runtimeSeam,
            selected,
            'none',
          );
          const result = createRuntimeSessionFromPrepared(eventSink, prepared);
          return {
            session: result.session,
            requestCount: result.requestCount,
            displayState: result.displayState,
            workspaceRoot: prepared.workspace.root,
          };
        }
        // Parent Definition/manifest preparation must complete before any store operation.
        const prepared = await prepareRuntimeComposition(
          dependencies.runtimeSeam,
          selected,
          invocation.persistence,
        );
        const workspace = prepared.workspace;
        const stateRoot = dependencies.stateRoot ?? launcherStateRoot();
        const store = new DenoSessionStore(stateRoot, workspace.root, {
          sourceProfileId: prepared.definition.model.profile.id,
        });
        let record: SessionRecord | undefined;
        let handle;
        if (invocation.persistence === 'continue') {
          const listed = await store.list();
          const first = listed.sessions.find((candidate) => candidate.agent === selected.id);
          if (first === undefined) {
            throw new SessionStoreError('session_not_found');
          }
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
          (record.workspaceRoot !== workspace.root ||
            record.agent !== selected.id)
        ) {
          await handle.close();
          throw new SessionStoreError('session_invalid');
        }
        const persistence = createSessionPersistence(
          handle,
          workspace.root,
          selected.id,
          record,
        );
        try {
          const result = createRuntimeSessionFromPrepared(
            eventSink,
            prepared,
            { persistence, initialRecord: record },
          );
          let currentHandle: SessionHandle = handle;
          let currentRecord: SessionRecord | undefined = record;
          let currentSession = result.session;
          const position = (): NavigationPosition => {
            const value = currentSession.currentPosition();
            return {
              sessionId: value.sessionId ?? currentHandle.id,
              agent: value.agent,
              committedTurn: value.committedTurn,
              messageCount: value.messageCount,
              ...(value.checkpoint === undefined ? {} : { checkpoint: value.checkpoint }),
            };
          };
          const navigation: SessionNavigationHost = {
            persistent: true,
            async list(signal?: AbortSignal): Promise<NavigationListing> {
              throwIfNavigationAborted(signal);
              const listed = await store.list();
              throwIfNavigationAborted(signal);
              const rows = listed.sessions.map((metadata: SessionMetadata) => ({
                ...metadata,
                current: metadata.id === currentHandle.id,
                resumed: metadata.id === currentHandle.id,
                mismatch: metadata.agent !== selected.id,
              }));
              if (currentRecord === undefined && !rows.some((row) => row.id === currentHandle.id)) {
                rows.push({
                  id: currentHandle.id,
                  agent: selected.id,
                  createdAt: new Date(0).toISOString(),
                  updatedAt: new Date(0).toISOString(),
                  turnCount: 0,
                  messageCount: 0,
                  current: true,
                  resumed: false,
                  mismatch: false,
                });
              }
              return { sessions: rows, skippedInvalid: listed.skippedInvalid };
            },
            async switchTo(id: string, signal?: AbortSignal): Promise<NavigationBinding> {
              throwIfNavigationAborted(signal);
              if (!isSessionId(id)) throw new SessionStoreError('session_invalid');
              if (id === currentHandle.id) {
                return {
                  session: currentSession,
                  position: position(),
                  ...(currentRecord === undefined ? {} : (() => {
                    const replay = restoredMessages(currentRecord!.transcript);
                    return { restored: { messages: replay.messages, omitted: replay.omitted } };
                  })()),
                };
              }
              const targetHandle = await store.openExisting(id);
              try {
                throwIfNavigationAborted(signal);
              } catch (error) {
                try {
                  await targetHandle.close();
                } catch {
                  throw new NavigationFatalError('target session cleanup failed');
                }
                throw error;
              }
              const targetRecord = targetHandle.record;
              if (
                targetRecord === undefined || targetRecord.workspaceRoot !== workspace.root ||
                targetRecord.agent !== selected.id
              ) {
                try {
                  await targetHandle.close();
                } catch {
                  throw new NavigationFatalError('target session cleanup failed');
                }
                throw new SessionStoreError('session_invalid');
              }
              const targetPersistence = createSessionPersistence(
                targetHandle,
                workspace.root,
                selected.id,
                targetRecord,
              );
              const targetSession = await runNavigationSwitchTransaction({
                signal,
                materializeTarget: () => {
                  const targetRuntime = createRuntimeSessionFromPrepared(
                    eventSink,
                    prepared,
                    { persistence: targetPersistence, initialRecord: targetRecord },
                  );
                  return targetRuntime.session;
                },
                closeTarget: () => targetPersistence.close(),
                closeCurrent: () => currentSession.close(),
                commitTarget: (session) => {
                  currentHandle = targetHandle;
                  currentRecord = targetRecord;
                  currentSession = session;
                },
              });
              const replay = restoredMessages(targetRecord.transcript);
              return {
                session: targetSession,
                position: position(),
                restored: { messages: replay.messages, omitted: replay.omitted },
              };
            },
            historyPage(page, turn, rows): Promise<SessionHistoryPage | undefined> {
              return Promise.resolve(currentSession.historyPage(page, turn, rows));
            },
            currentPosition: position,
          };
          return {
            session: result.session,
            requestCount: result.requestCount,
            close: () => currentSession.close(),
            displayState: result.displayState,
            workspaceRoot: prepared.workspace.root,
            sessionLine: `session> ${handle.id} ${record === undefined ? '(new)' : '(resumed)'}`,
            navigation,
            ...(record === undefined ? {} : (() => {
              const replay = restoredMessages(record.transcript);
              return {
                restored: {
                  messages: replay.messages,
                  omitted: replay.omitted,
                },
              };
            })()),
          };
        } catch (error) {
          await persistence.close();
          throw error;
        }
      };
    }
    // Composition occurs before raw acquisition, so startup failures never touch terminal mode.
    const controllerRef: { current?: TuiController } = {};
    const pending = new PendingInputCore();
    const bridge: AgentEventSink = (event) => {
      if (event.kind === 'steering_message' && controllerRef.current !== undefined) {
        controllerRef.current.markSteeringConsumed();
      }
      renderer.eventSink(event);
    };
    const created = await sessionFactory(bridge, selection);
    createdResult = created;
    const useDailyEditor = dependencies.dailyEditor ?? dependencies.createSession === undefined;
    const workspaceRoot = created.workspaceRoot ?? created.displayState.workspace;
    const pathIndex = useDailyEditor
      ? dependencies.pathIndex ?? await buildWorkspacePathIndex(workspaceRoot)
      : undefined;
    const controller = new TuiController(
      lifecycle,
      renderer,
      created.session,
      useDailyEditor
        ? {
          pending,
          history: new TuiEditorHistory(),
          pathIndex,
          navigation: created.navigation,
        }
        : {},
    );
    controllerRef.current = controller;
    controller.installSignals();
    let crashDetected = false;
    crashGuard = installCrashGuard(() => {
      crashDetected = true;
      controller.handleCrash();
    });
    acquisitionStarted = true;
    await lifecycle.acquire();
    renderer.renderStartupOrientation(created.displayState);
    if (created.sessionLine !== undefined) {
      renderer.writeStatic(`${created.sessionLine}\n`);
    }
    if (created.restored !== undefined) {
      renderer.renderRestored(
        created.restored.messages,
        created.restored.omitted,
      );
    }
    const initialPosition = created.navigation?.currentPosition();
    if (initialPosition !== undefined) renderer.setCurrentPosition(initialPosition);
    await dependencies.afterAcquire?.();
    const exitCode = await controller.run();
    if (crashDetected || crashGuard.hasFatal()) {
      await stderr(failureLine('terminal_failure'));
      resultCode = 1;
    } else {
      resultCode = exitCode;
    }
  } catch (error) {
    const code = error instanceof TuiControllerError
      ? error.code
      : acquisitionStarted
      ? 'terminal_failure'
      : 'startup_failure';
    await stderr(failureLine(code as keyof typeof fatalMessages));
    resultCode = 1;
  } finally {
    // Session locks are released only after controller settlement and terminal restoration starts.
    // The factory close is idempotent for the production AgentSession/store adapter.
    // `created` is scoped below in older direct seams, so cleanup is installed through a local.
    crashGuard?.close();
    await lifecycle.restore();
    let cleanupFailed = lifecycle.restoreStatus() === 'failed';
    try {
      await createdResult?.close?.();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) {
      await stderr(failureLine('terminal_failure'));
      resultCode = 1;
    }
  }
  return resultCode;
};

if (import.meta.main) Deno.exit(await main());
