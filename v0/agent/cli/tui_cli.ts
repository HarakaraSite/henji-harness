import {
  DefinitionStartupError,
  definitionStartupErrorValue,
  type HostDefinitionSelection,
  parseDefinitionRevisionSelector,
  resolveRequestedDefinition,
} from '../definitions/definition_selection.ts';
import { AgentSession } from '../session/session.ts';
import { type AgentEventSink } from '../core/events.ts';
import { TuiController, TuiControllerError } from '../../tui/controller.ts';
import { TuiRenderer } from '../../tui/render.ts';
import { DenoTerminal, TerminalLifecycle, type TerminalPort } from '../../tui/terminal.ts';
import { isSessionId } from '../session/session_store.ts';
import { type Message } from '../core/contracts.ts';
import { type RuntimeDisplayState } from '../runtime/startup_orientation.ts';
import { PendingInputCore } from '../../tui/pending_input.ts';
import { TuiEditorHistory } from '../../tui/input.ts';
import { buildWorkspacePathIndex, type WorkspacePathIndex } from '../../tui/file_reference.ts';
import type { SessionNavigationHost } from '../session/session_navigation.ts';
import {
  createTuiPresentationAdapter,
  presentationProjectionFromStartup,
  TuiPresentationAdapter,
} from '../../presentation/adapter.ts';
import { createWorkerSession } from '../worker/worker_host.ts';
import {
  BUILTIN_PROVIDER_IDS,
  type ModelSelection,
  type ProviderId,
} from '../provider/model_selection.ts';
import {
  defaultModelSelectionFor,
  isModelSelection,
  providerIdsForSelection,
} from '../provider/model_catalog.ts';
import { readDefaultSelection, writeDefaultSelection } from '../provider/default_selection.ts';
import {
  builtinProviderDeclarations,
  loadProviderDeclarations,
  resolveProviderRegistry,
} from '../provider/provider_declaration.ts';
import { setActiveProviderDeclarations } from '../provider/provider_runtime.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';
import {
  HenjiInstructionError,
  henjiInstructionErrorValue,
} from '../instructions/base_instruction.ts';

const encoder = new TextEncoder();

export interface TuiSessionFactoryResult {
  readonly session:
    & Pick<AgentSession, 'submit'>
    & Partial<
      Pick<
        AgentSession,
        | 'cancelActiveTurn'
        | 'contextSnapshot'
        | 'steerActiveTurn'
        | 'isAvailable'
      >
    >;
  readonly requestCount?: () => number;
  readonly close?: () => void | Promise<void>;
  /** Canonical workspace root for the startup-bounded local path index. */
  readonly workspaceRoot?: string;
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
  readonly createSession?: (
    eventSink: AgentEventSink,
    selection: HostDefinitionSelection | undefined,
  ) => Promise<TuiSessionFactoryResult>;
  /** Direct-test-only state-root seam; production selects XDG_STATE_HOME/HOME. */
  readonly stateRoot?: string;
  /** Direct-test-only data-root seam; production selects XDG_DATA_HOME/HOME. */
  readonly dataRoot?: string;
  /** Direct-test-only config-root seam; production selects XDG_CONFIG_HOME/HOME. */
  readonly configRoot?: string;
  /** Direct-test-only workspace seam; production selects the current working directory. */
  readonly workspaceRoot?: string;
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

export interface ParsedTuiInvocation {
  readonly rawAgentName: string | undefined;
  readonly rawDefinitionRevision?: string;
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  readonly rootProvider?: ProviderId;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  readonly sessionId?: string;
}

/** Parse both flag orders before terminal, workspace, state, provider, or credential setup. */
export const parseTuiInvocation = (
  args: readonly string[],
  allowedProviders: readonly string[] = BUILTIN_PROVIDER_IDS,
): ParsedTuiInvocation => {
  if (args.length > 10) throw new Error('invalid invocation');
  let rawAgentName: string | undefined;
  let rawDefinitionRevision: string | undefined;
  let rootMaxSteps: number | undefined;
  let providerTimeoutMs: number | undefined;
  let rootProvider: ProviderId = 'openrouter-chat';
  let rootProviderSeen = false;
  let persistence: ParsedTuiInvocation['persistence'] = 'new';
  let sessionId: string | undefined;
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === '--agent') {
      const value = args[index + 1];
      if (
        rawAgentName !== undefined ||
        value === undefined ||
        value.length === 0
      ) {
        throw new Error('invalid invocation');
      }
      rawAgentName = value;
      index += 2;
    } else if (flag === '--definition-revision') {
      const value = args[index + 1];
      if (
        rawDefinitionRevision !== undefined ||
        value === undefined ||
        value.length === 0
      ) {
        throw new Error('invalid invocation');
      }
      try {
        parseDefinitionRevisionSelector(value);
      } catch {
        throw new Error('invalid invocation');
      }
      rawDefinitionRevision = value;
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
    } else if (flag === '--max-steps') {
      const value = args[index + 1];
      if (
        rootMaxSteps !== undefined || value === undefined ||
        !/^[0-9]+$/.test(value)
      ) throw new Error('invalid invocation');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('invalid invocation');
      }
      rootMaxSteps = parsed;
      index += 2;
    } else if (flag === '--provider-timeout-ms') {
      const value = args[index + 1];
      if (
        providerTimeoutMs !== undefined || value === undefined ||
        !/^[0-9]+$/.test(value)
      ) throw new Error('invalid invocation');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('invalid invocation');
      }
      providerTimeoutMs = parsed;
      index += 2;
    } else if (flag === '--root-provider') {
      const value = args[index + 1];
      if (rootProviderSeen || value === undefined || !allowedProviders.includes(value)) {
        throw new Error('invalid invocation');
      }
      rootProvider = value;
      rootProviderSeen = true;
      index += 2;
    } else {
      throw new Error('invalid invocation');
    }
  }
  if (rawAgentName !== undefined && rawDefinitionRevision !== undefined) {
    throw new Error('invalid invocation');
  }
  return {
    rawAgentName,
    ...(rawDefinitionRevision === undefined ? {} : { rawDefinitionRevision }),
    ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    ...(providerTimeoutMs === undefined ? {} : { providerTimeoutMs }),
    ...(rootProviderSeen ? { rootProvider } : {}),
    persistence,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
};

const failureLine = (code: keyof typeof fatalMessages): string =>
  JSON.stringify({ ok: false, error: { code, message: fatalMessages[code] } }) +
  '\n';

const definitionFailureLine = (error: DefinitionStartupError): string =>
  JSON.stringify({ ok: false, error: definitionStartupErrorValue(error) }) + '\n';

const instructionFailureLine = (error: HenjiInstructionError): string =>
  JSON.stringify({ ok: false, error: henjiInstructionErrorValue(error) }) + '\n';

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
  const hostConfigRoot = dependencies.configRoot ??
    (dependencies.createSession === undefined ? resolveRuntimePaths().configRoot : undefined);
  try {
    setActiveProviderDeclarations(
      hostConfigRoot === undefined ? [] : resolveProviderRegistry(
        builtinProviderDeclarations(),
        await loadProviderDeclarations({ configRoot: hostConfigRoot }),
      ),
    );
  } catch {
    await stderr(failureLine('invalid_invocation'));
    return 1;
  }
  let selection: HostDefinitionSelection | undefined;
  let invocation: ParsedTuiInvocation;
  try {
    invocation = parseTuiInvocation(args, providerIdsForSelection());
    if (
      invocation.persistence !== 'session' ||
      invocation.rawAgentName !== undefined ||
      invocation.rawDefinitionRevision !== undefined
    ) {
      selection = await resolveRequestedDefinition(
        invocation.rawAgentName,
        invocation.rawDefinitionRevision,
        dependencies.dataRoot,
        hostConfigRoot,
      );
    }
  } catch (error) {
    if (error instanceof DefinitionStartupError) {
      await stderr(definitionFailureLine(error));
      return 1;
    }
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
    const storedDefault = hostConfigRoot === undefined
      ? undefined
      : await readDefaultSelection(hostConfigRoot);
    const rootSelection = invocation.rootProvider !== undefined
      ? defaultModelSelectionFor(invocation.rootProvider)
      : storedDefault !== undefined && isModelSelection(storedDefault)
      ? storedDefault
      : defaultModelSelectionFor('openrouter-chat');
    const sessionFactory = dependencies.createSession ??
      ((eventSink: AgentEventSink, selected: HostDefinitionSelection | undefined) =>
        createWorkerSession({
          workspaceRoot: dependencies.workspaceRoot,
          stateRoot: dependencies.stateRoot,
          persistence: invocation.persistence,
          sessionId: invocation.sessionId,
          selection: selected,
          dataRoot: dependencies.dataRoot,
          configRoot: dependencies.configRoot,
          physicalIoMode: 'production',
          rootMaxSteps: invocation.rootMaxSteps,
          providerTimeoutMs: invocation.providerTimeoutMs,
          initialModelSelection: rootSelection,
          eventSink,
        }));
    // Composition occurs before raw acquisition, so startup failures never touch terminal mode.
    const controllerRef: { current?: TuiController } = {};
    const presentationAdapterRef: { current?: TuiPresentationAdapter } = {};
    const pending = new PendingInputCore();
    const bridge: AgentEventSink = (event) => {
      if (
        event.kind === 'steering_message' && controllerRef.current !== undefined
      ) {
        controllerRef.current.markSteeringConsumed();
      }
      presentationAdapterRef.current?.deliverCoreEvent(event);
    };
    const created = await sessionFactory(bridge, selection);
    createdResult = created;
    const workspaceRoot = created.workspaceRoot ??
      created.displayState.workspace;
    const presentationAdapter = createTuiPresentationAdapter(
      created.session,
      (event) => renderer.eventSink(event),
      created.navigation,
      {
        ...(hostConfigRoot === undefined ? {} : {
          persistDefaultSelection: (selection: ModelSelection) => {
            writeDefaultSelection(hostConfigRoot, selection).catch(() => {});
          },
        }),
        startupState: created.displayState,
      },
    );
    presentationAdapterRef.current = presentationAdapter;
    const useDailyEditor = dependencies.dailyEditor ??
      dependencies.createSession === undefined;
    const pathIndex = useDailyEditor
      ? dependencies.pathIndex ?? await buildWorkspacePathIndex(workspaceRoot)
      : undefined;
    const controller = new TuiController(
      lifecycle,
      renderer,
      presentationAdapter,
      useDailyEditor
        ? {
          pending,
          history: new TuiEditorHistory(),
          pathIndex,
          intents: presentationAdapter,
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
    const initialPosition = presentationAdapter.currentPosition();
    if (initialPosition !== undefined) {
      renderer.renderCompactStartup(created.displayState, initialPosition);
    }
    if (created.restored !== undefined) {
      renderer.renderRestored(
        created.restored.messages,
        created.restored.omitted,
      );
    }
    if (initialPosition !== undefined) {
      renderer.setCurrentPosition(initialPosition);
      renderer.setProjection(
        presentationProjectionFromStartup(
          created.displayState,
          initialPosition,
          {
            canNavigate: created.navigation?.persistent === true,
            canHistory: created.navigation !== undefined ||
              presentationAdapter.historyPage !== undefined,
            canCompact: presentationAdapter.contextCompactionPreview() !== undefined,
          },
        ),
      );
    } else {
      renderer.setProjection(
        presentationProjectionFromStartup(created.displayState, undefined, {
          canNavigate: created.navigation?.persistent === true,
          canHistory: created.navigation !== undefined ||
            presentationAdapter.historyPage !== undefined,
          canCompact: presentationAdapter.contextCompactionPreview() !== undefined,
        }),
      );
    }
    await dependencies.afterAcquire?.();
    const exitCode = await controller.run();
    if (crashDetected || crashGuard.hasFatal()) {
      await stderr(failureLine('terminal_failure'));
      resultCode = 1;
    } else {
      resultCode = exitCode;
    }
  } catch (error) {
    if (error instanceof DefinitionStartupError) {
      await stderr(definitionFailureLine(error));
      resultCode = 1;
      return resultCode;
    }
    if (error instanceof HenjiInstructionError) {
      await stderr(instructionFailureLine(error));
      resultCode = 1;
      return resultCode;
    }
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
