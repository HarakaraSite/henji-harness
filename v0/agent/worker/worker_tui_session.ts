import { createDataClient } from '../data/client.ts';
import type { DataService } from '../data/data_contract.ts';
import type { DataSessionDescriptor } from '../data/session_data_owner.ts';
import type { AgentEventSink } from '../core/events.ts';
import type { ContextView, EffectiveRuntimeConfig, SessionActivation } from '../../api/contract.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import { credentialFileFor, credentialFilePresenceAt } from '../provider/credential_file.ts';
import { chatGPTCredentialPresence } from '../provider/chatgpt_auth.ts';
import {
  builtinProviderDeclarations,
  loadProviderDeclarations,
  type ProviderDeclarationV1,
  resolveProviderRegistry,
} from '../provider/provider_declaration.ts';
import { defaultModelSelectionFor } from '../provider/model_catalog.ts';
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../provider/openrouter_contract.ts';
import { setActiveProviderDeclarations } from '../provider/provider_runtime.ts';
import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../worker_agent_api.ts';
import {
  projectRuntimeDisplayState,
  type RuntimeDisplayState,
} from '../runtime/startup_orientation.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { launcherStateRoot, type SessionRecord } from '../session/session_store.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import { readDefaultSelection } from '../provider/default_selection.ts';
import type { WorkerHostCapsule } from './worker_host_contract.ts';
import type { WorkerStartupPreparedMessage } from './worker_protocol.ts';
import type { ApplicationObservationSink, ApplicationQueryPort } from '../host/application_port.ts';
import { WorkerHostSession, WorkerHostStartupError } from './worker_host_session.ts';
import {
  builtinHenjiBaseInstruction,
  resolveHenjiBaseInstruction,
  type SelectedHenjiBaseInstruction,
} from '../instructions/base_instruction.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const LAZY_START_CANCEL_GRACE_MS = 5_000;

export interface WorkerSessionOptions {
  readonly workspaceRoot?: string;
  readonly data?: DataService;
  readonly stateRoot?: string;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  /** Leave the initial session facade unstarted until an operation needs live Host behavior. */
  readonly lazyInitialHost?: boolean;
  readonly sessionId?: string;
  readonly agent?: SessionRecord['agent'];
  readonly agentChoice?: AgentConfigurationChoice;
  readonly dataRoot?: string;
  readonly configRoot?: string;
  /** Credential root; defaults to the state root's `credentials` directory. */
  readonly credentialRoot?: string;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  readonly activation?: SessionActivation;
  /** Focused-test seam; production uses the Host default. */
  readonly cancelSettlementGraceMs?: number;
  /** Focused-test seam; production uses the Host default. */
  readonly workerResponseTimeoutMs?: number;
  /** Focused-test seam; production records an auxiliary start gap after one second. */
  readonly auxiliaryStageGapMs?: number;
  readonly initialModelSelection?: ModelSelection;
  /** Host-resolved declaration snapshot shared with the Worker for this invocation. */
  readonly providerDeclarations?: readonly ProviderDeclarationV1[];
  readonly eventSink?: AgentEventSink;
  readonly applicationObservationSink?: ApplicationObservationSink;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
}

export interface WorkerSessionResult {
  readonly session: HostActiveSession;
  readonly currentSession: () => HostActiveSession;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
  readonly workspaceRoot: string;
  readonly data: DataService;
  readonly displayState: RuntimeDisplayState;
  readonly query: ApplicationQueryPort;
}

export interface HostActiveSession {
  readonly agentChoice: AgentConfigurationChoice;
  readonly sessionId: string;
  submit(text: string): ReturnType<WorkerHostSession['submit']>;
  admit(
    text: string,
    executionId?: string,
  ): ReturnType<WorkerHostSession['admit']>;
  startupSnapshot():
    | ReturnType<WorkerHostSession['startupSnapshot']>
    | undefined;
  currentPosition(): ReturnType<WorkerHostSession['currentPosition']>;
  executionSnapshot(): ReturnType<WorkerHostSession['executionSnapshot']>;
  modelSelectionSnapshot(): ModelSelection;
  credentialAvailabilitySnapshot(): CredentialAvailability | undefined;
  /** Presence-only display refresh; an unstarted session must not start a Worker for it. */
  refreshCredentialAvailability(): Promise<CredentialAvailability | undefined>;
  effectiveConfigSnapshot(): EffectiveRuntimeConfig;
  pendingRecallSnapshot(): ContextView['pendingRecall'];
  contextSnapshot(): ContextView;
  consumeAutoCompactionNotice(): Promise<
    {
      readonly coveredThroughTurn: number;
      readonly retainedFromTurn: number;
    } | null
  >;
  prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }>;
  clearPendingRecall(): Promise<boolean>;
  renameTitle(
    value: string,
  ):
    | 'renamed'
    | 'unchanged'
    | 'busy'
    | 'unavailable'
    | Promise<'renamed' | 'unchanged' | 'busy' | 'unavailable'>;
  requestCount(): number;
  runtimeSnapshot(): {
    readonly active: boolean;
    readonly phase:
      | 'idle'
      | 'running'
      | 'cancelling'
      | 'settling'
      | 'unavailable';
  };
  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn(
    text: string,
  ): Promise<'accepted' | 'idle' | 'already_accepted'>;
  isAvailable(): boolean;
  selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'>;
  close(): Promise<
    void | Awaited<ReturnType<WorkerHostSession['close']>>
  >;
}

/**
 * A stored Session opened as the active session without starting a Worker generation.
 *
 * Opening and closing it (or reading its stored transcript and history) never starts the Worker.
 * The first operation that needs live agent behavior (submit, model selection, rename, recall,
 * compaction) starts the generation under the Definition resolved at open time.
 */
class LazyWorkerSession implements HostActiveSession {
  private host: WorkerHostSession | undefined;
  private starting: Promise<WorkerHostSession> | undefined;
  private startupAbort: AbortController | undefined;
  private preparedStartup: WorkerStartupPreparedMessage | undefined;
  private closed = false;
  private pendingAdmission: {
    executionId: string;
    cancelled: boolean;
    startupPrepared?: WorkerStartupPreparedMessage;
    startupAbort?: AbortController;
    watchdog?: ReturnType<typeof setTimeout>;
  } | undefined;
  private localCredentialAvailability: CredentialAvailability | undefined;
  private configurationFailure:
    | readonly import('../configuration/agent_configuration.ts').ConfigurationRejection[]
    | undefined;

  constructor(
    private readonly data: DataService,
    private descriptor: DataSessionDescriptor,
    private readonly selected: AgentConfigurationChoice,
    private readonly startHost: (
      startupAbortSignal: AbortSignal,
      onStartupPrepared: (message: WorkerStartupPreparedMessage) => void,
    ) => Promise<WorkerHostSession>,
    private readonly config:
      & Pick<
        WorkerSessionOptions,
        | 'rootMaxSteps'
        | 'providerTimeoutMs'
        | 'activation'
        | 'configRoot'
        | 'credentialRoot'
        | 'cancelSettlementGraceMs'
      >
      & { readonly credentialRoot: string },
  ) {}

  get agentChoice(): AgentConfigurationChoice {
    return structuredClone(this.selected);
  }

  get sessionId(): string {
    return this.descriptor.id;
  }

  private async ensureStarted(): Promise<WorkerHostSession> {
    if (this.closed) throw new Error('session is closed');
    if (this.host !== undefined) return this.host;
    if (this.starting === undefined) {
      const startupAbort = new AbortController();
      this.startupAbort = startupAbort;
      this.preparedStartup = undefined;
      const starting = this.startHost(startupAbort.signal, (message) => {
        this.preparedStartup = message;
        if (this.pendingAdmission !== undefined) {
          this.pendingAdmission.startupPrepared = message;
        }
      }).then(
        (host) => {
          this.host = host;
          if (this.starting === starting) this.starting = undefined;
          if (this.startupAbort === startupAbort) this.startupAbort = undefined;
          return host;
        },
        (error) => {
          if (
            error instanceof WorkerHostStartupError &&
            error.code === 'configuration_rejected'
          ) {
            this.configurationFailure = error.configurationRejections;
          }
          if (startupAbort.signal.aborted && this.starting === starting) {
            this.starting = undefined;
          }
          if (this.startupAbort === startupAbort) this.startupAbort = undefined;
          throw error;
        },
      );
      this.starting = starting;
    }
    return await this.starting;
  }

  async submit(text: string): ReturnType<WorkerHostSession['submit']> {
    return await (await this.ensureStarted()).submit(text);
  }

  async admit(
    text: string,
    executionId = crypto.randomUUID().toLowerCase(),
  ): ReturnType<WorkerHostSession['admit']> {
    const reservation: NonNullable<typeof this.pendingAdmission> = {
      executionId,
      cancelled: false,
    };
    this.pendingAdmission = reservation;
    try {
      const starting = this.ensureStarted();
      reservation.startupAbort = this.startupAbort;
      reservation.startupPrepared = this.preparedStartup;
      let host: WorkerHostSession;
      try {
        host = await starting;
      } catch (error) {
        if (!reservation.cancelled) throw error;
        const prepared = reservation.startupPrepared ?? this.preparedStartup;
        if (prepared === undefined) throw error;
        await this.data.executionAdmitStartup(this.sessionId, {
          executionId,
          taskId: crypto.randomUUID().toLowerCase(),
          task: text,
          correlation: prepared.correlation,
          configuration: prepared.configuration,
          maxSteps: prepared.manifest.maxSteps,
          ...(prepared.startupSnapshot.context === undefined ? {} : {
            contextSnapshot: prepared.startupSnapshot.context,
          }),
        });
        const terminal = await this.data.sealGeneration(this.sessionId, {
          executionId,
          decision: 'cancelled',
          reason: 'cancelled during Worker startup',
        });
        this.descriptor = terminal.descriptor;
        return {
          executionId,
          completion: Promise.resolve(terminal.outcome),
        };
      }
      return await host.admit(text, executionId, reservation.cancelled);
    } finally {
      if (reservation.watchdog !== undefined) {
        clearTimeout(reservation.watchdog);
      }
      if (this.pendingAdmission === reservation) {
        this.pendingAdmission = undefined;
      }
    }
  }

  startupSnapshot():
    | ReturnType<WorkerHostSession['startupSnapshot']>
    | undefined {
    return this.host?.startupSnapshot();
  }

  effectiveConfigSnapshot(): EffectiveRuntimeConfig {
    if (this.host !== undefined) return this.host.effectiveConfigSnapshot();
    const configuredMaxSteps = this.config.rootMaxSteps;
    return {
      configuration: {
        status: this.configurationFailure === undefined ? 'pending' : 'rejected',
        choice: { ...this.selected },
        name: this.selected.name ?? 'default',
        ...(this.configurationFailure === undefined ? {} : {
          rejections: structuredClone(
            this.configurationFailure,
          ) as unknown as import('../../api/contract.ts').ApiJson,
        }),
      },
      maxSteps: configuredMaxSteps ?? DEFAULT_AGENT_MAX_STEPS,
      maxStepsSource: configuredMaxSteps === undefined ? 'default' : 'activation',
      providerTimeoutMs: this.config.providerTimeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS,
      activation: {
        ...(this.config.activation ?? {}),
        ...(configuredMaxSteps === undefined ? {} : { maxSteps: configuredMaxSteps }),
        ...(this.config.providerTimeoutMs === undefined
          ? {}
          : { providerTimeoutMs: this.config.providerTimeoutMs }),
      },
    };
  }

  pendingRecallSnapshot(): ContextView['pendingRecall'] {
    return this.host?.pendingRecallSnapshot();
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    const pending = this.pendingAdmission;
    if (pending !== undefined) {
      if (pending.cancelled) return 'already_requested';
      pending.cancelled = true;
      if (this.host !== undefined) {
        this.host.cancelActiveTurn();
      } else {
        pending.watchdog = setTimeout(() => {
          if (
            this.pendingAdmission === pending && pending.cancelled &&
            this.host === undefined
          ) pending.startupAbort?.abort();
        }, this.config.cancelSettlementGraceMs ?? LAZY_START_CANCEL_GRACE_MS);
      }
      return 'requested';
    }
    return this.host?.cancelActiveTurn() ?? 'idle';
  }

  async steerActiveTurn(
    text: string,
  ): Promise<'accepted' | 'idle' | 'already_accepted'> {
    return await this.host?.steerActiveTurn(text) ?? 'idle';
  }

  isAvailable(): boolean {
    return !this.closed;
  }

  runtimeSnapshot() {
    return this.host?.runtimeSnapshot() ??
      { active: false, phase: 'idle' as const };
  }

  currentPosition(): ReturnType<WorkerHostSession['currentPosition']> {
    return this.host?.currentPosition() ??
      structuredClone(this.descriptor.currentPosition);
  }

  executionSnapshot(): ReturnType<WorkerHostSession['executionSnapshot']> {
    return this.host?.executionSnapshot() ?? this.descriptor.latestExecution;
  }

  modelSelectionSnapshot(): ModelSelection {
    return this.host?.modelSelectionSnapshot() ??
      structuredClone(this.descriptor.modelSelection);
  }

  credentialAvailabilitySnapshot(): CredentialAvailability | undefined {
    return this.host?.credentialAvailabilitySnapshot() ??
      this.localCredentialAvailability;
  }

  /**
   * Presence-only display refresh. An unstarted session resolves it Host-locally so the display can
   * update without starting a Worker generation just to refresh the snapshot.
   */
  async refreshCredentialAvailability(): Promise<
    CredentialAvailability | undefined
  > {
    if (this.closed) return undefined;
    if (this.host !== undefined) {
      return await this.host.refreshCredentialAvailability();
    }
    const selection = this.descriptor.modelSelection;
    const profile = selection.authProfile;
    const registrationId = 'registrationId' in selection ? selection.registrationId : undefined;
    const status = profile === 'openai-chatgpt'
      ? registrationId === null ? 'missing' : await chatGPTCredentialPresence({
        credentialRoot: this.config.credentialRoot,
        ...(registrationId === undefined ? {} : { registrationId }),
      })
      : (await credentialFilePresenceAt(
        credentialFileFor(profile, this.config.credentialRoot),
      ));
    const availability = Object.freeze({ authProfile: profile, status });
    if (this.closed) return undefined;
    this.localCredentialAvailability = availability;
    return availability;
  }

  async consumeAutoCompactionNotice(): Promise<
    {
      readonly coveredThroughTurn: number;
      readonly retainedFromTurn: number;
    } | null
  > {
    return await this.host?.consumeAutoCompactionNotice() ?? null;
  }

  async clearPendingRecall(): Promise<boolean> {
    return await this.host?.clearPendingRecall() ?? false;
  }

  contextSnapshot(): ContextView {
    return this.host?.contextSnapshot() ?? this.descriptor.context;
  }

  async selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'> {
    return await (await this.ensureStarted()).selectModel(selection);
  }

  async prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }> {
    return await (await this.ensureStarted()).prepareRecall(id);
  }

  async renameTitle(
    value: string,
  ): Promise<'renamed' | 'unchanged' | 'busy' | 'unavailable'> {
    return (await this.ensureStarted()).renameTitle(value);
  }

  requestCount(): number {
    return this.host?.requestCount() ?? 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.host !== undefined) {
      await this.host.close();
      return;
    }
    if (this.starting !== undefined) {
      const started = await this.starting.catch(() => undefined);
      if (started !== undefined) await started.close();
      return;
    }
    await this.data.closeSession(this.descriptor.id);
  }
}

/** Build one Host-owned session through the common headless Worker route. */
export const createWorkerSession = async (
  options: WorkerSessionOptions,
): Promise<WorkerSessionResult> => {
  const workspace = await resolveWorkspace(options.workspaceRoot);
  const resolveManagedInstruction = options.physicalIoMode !== 'provider-free' ||
    options.dataRoot !== undefined || options.configRoot !== undefined;
  const runtimePaths = resolveManagedInstruction && options.dataRoot === undefined
    ? resolveRuntimePaths()
    : undefined;
  const configRoot = options.configRoot ??
    (options.dataRoot === undefined
      ? runtimePaths?.configRoot ?? `${workspace.root}/.henji`
      : `${options.dataRoot}/config`);
  const resolveBaseInstruction = (): Promise<SelectedHenjiBaseInstruction> =>
    !resolveManagedInstruction
      ? Promise.resolve(builtinHenjiBaseInstruction())
      : resolveHenjiBaseInstruction(configRoot!);
  const providerDeclarations = options.providerDeclarations ??
    (resolveManagedInstruction
      ? resolveProviderRegistry(
        builtinProviderDeclarations(),
        await loadProviderDeclarations({ configRoot: configRoot! }),
      )
      : Object.freeze([] as const));
  setActiveProviderDeclarations(providerDeclarations);
  const configuredDefaultSelection = options.initialModelSelection ??
    (configRoot === undefined ? undefined : await readDefaultSelection(configRoot));
  let baseInstruction: SelectedHenjiBaseInstruction = await resolveBaseInstruction();
  const ownsData = options.data === undefined;
  const stateRoot = options.stateRoot ?? launcherStateRoot();
  const credentialRoot = options.credentialRoot ?? `${stateRoot}/credentials`;
  const data = options.data ?? await createDataClient({
    stateRoot,
    workspaceRoot: workspace.root,
  });
  const saved = options.persistence === 'session' && options.sessionId !== undefined
    ? await data.sessionDescriptor(options.sessionId)
    : undefined;
  const agentChoice: AgentConfigurationChoice = options.agentChoice ??
    (options.agent === undefined ? saved?.agentChoice ?? {} : { name: options.agent });
  const agent = options.agent ?? saved?.agent ?? agentChoice.name ?? 'default';
  const descriptor = await data.openSession({
    persistence: options.persistence,
    agent,
    agentChoice,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    initialModelSelection: configuredDefaultSelection ??
      defaultModelSelectionFor('openrouter-chat'),
  }).catch(async (error) => {
    if (ownsData) await data.close();
    throw error;
  });
  try {
    const openHost = async (
      sessionDescriptor: DataSessionDescriptor,
      startupAbortSignal?: AbortSignal,
      onStartupPrepared?: (message: WorkerStartupPreparedMessage) => void,
    ): Promise<WorkerHostSession> => {
      setActiveProviderDeclarations(providerDeclarations);
      baseInstruction = await resolveBaseInstruction();
      return await WorkerHostSession.open({
        data,
        descriptor: sessionDescriptor,
        workspaceRoot: workspace.root,
        agentChoice,
        configRoot,
        credentialRoot,
        physicalIoMode: options.physicalIoMode,
        rootMaxSteps: options.rootMaxSteps,
        providerTimeoutMs: options.providerTimeoutMs,
        ...(options.activation === undefined ? {} : { activation: options.activation }),
        cancelSettlementGraceMs: options.cancelSettlementGraceMs,
        ...(startupAbortSignal === undefined ? {} : { startupAbortSignal }),
        ...(onStartupPrepared === undefined ? {} : { onStartupPrepared }),
        workerResponseTimeoutMs: options.workerResponseTimeoutMs,
        auxiliaryStageGapMs: options.auxiliaryStageGapMs,
        baseInstruction,
        providerDeclarations,
        eventSink: options.eventSink,
        applicationObservationSink: options.applicationObservationSink,
        capsuleFactory: options.capsuleFactory,
      });
    };
    const host = options.lazyInitialHost ? undefined : await openHost(descriptor);
    const initialSelection = host?.modelSelectionSnapshot() ??
      descriptor.modelSelection ??
      configuredDefaultSelection ?? defaultModelSelectionFor('openrouter-chat');
    const startupSnapshot = host?.startupSnapshot();
    const displayState = projectRuntimeDisplayState({
      productVersion: buildManifest().productVersion,
      workspaceRoot: workspace.root,
      agentId: agent,
      profileId: modelRouteProfileId(initialSelection),
      provider: initialSelection.provider,
      modelId: initialSelection.modelId,
      effort: initialSelection.effort,
      sessionMode: options.persistence,
      baseInstruction: {
        resourceId: baseInstruction.ref.resourceId,
        selectionSource: baseInstruction.selectionSource,
        revisionDigest: baseInstruction.ref.revision.digest,
      },
      ...(startupSnapshot === undefined ? {} : {
        instructionSource: startupSnapshot.instructionSource,
      }),
      skillNames: startupSnapshot?.skillNames ?? [],
    });
    const currentHost: HostActiveSession = host ?? new LazyWorkerSession(
      data,
      descriptor,
      agentChoice,
      (startupAbortSignal, onStartupPrepared) =>
        openHost(descriptor, startupAbortSignal, onStartupPrepared),
      { ...options, credentialRoot },
    );
    const position = () => currentHost.currentPosition();
    const query: ApplicationQueryPort = {
      currentSession: () => {
        const workerStartup = currentHost.startupSnapshot();
        const pendingRecall = currentHost.pendingRecallSnapshot();
        return {
          sessionId: currentHost.sessionId,
          persistence: options.persistence,
          position: position(),
          selection: currentHost.modelSelectionSnapshot(),
          startup: displayState,
          ...(workerStartup === undefined ? {} : { workerStartup }),
          effectiveConfig: currentHost.effectiveConfigSnapshot(),
          ...(pendingRecall === undefined ? {} : { pendingRecall }),
          ...(currentHost.credentialAvailabilitySnapshot() === undefined ? {} : {
            credentialAvailability: currentHost
              .credentialAvailabilitySnapshot()!,
          }),
          runtime: currentHost.runtimeSnapshot(),
          execution: currentHost.executionSnapshot(),
          context: currentHost.contextSnapshot(),
        };
      },
    };
    let closeTask: Promise<void> | undefined;
    return {
      session: currentHost,
      currentSession: () => currentHost,
      requestCount: () => currentHost.requestCount(),
      close: () =>
        closeTask ??= (async () => {
          try {
            await currentHost.close();
          } finally {
            try {
              await data.closeSession(currentHost.sessionId);
            } finally {
              if (ownsData) await data.close();
            }
          }
        })(),
      data,
      workspaceRoot: workspace.root,
      displayState,
      query,
    };
  } catch (error) {
    await data.closeSession(descriptor.id);
    if (ownsData) await data.close();
    throw error;
  }
};
