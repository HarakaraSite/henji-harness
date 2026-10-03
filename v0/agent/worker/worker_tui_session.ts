import { createDataClient } from '../data/client.ts';
import type { DataService } from '../data/data_contract.ts';
import type { DataSessionDescriptor } from '../data/session_data_owner.ts';
import type { AgentEventSink } from '../core/events.ts';
import type { ContextView, EffectiveRuntimeConfig, SessionActivation } from '../../api/contract.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import { credentialAvailabilityFor } from '../provider/credential_file.ts';
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
import {
  DefinitionStartupError,
  type HostDefinitionSelection,
  resolveRequestedDefinition,
} from '../definitions/definition_selection.ts';
import { DEFAULT_AGENT_MAX_STEPS } from '../definitions/agent_definition.ts';
import {
  projectRuntimeDisplayState,
  type RuntimeDisplayState,
} from '../runtime/startup_orientation.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import { builtinDefinitionRef } from '../definitions/managed_resource_ref.ts';
import {
  type DefinitionRevisionRef,
  launcherStateRoot,
  type SessionRecord,
  SessionStoreError,
} from '../session/session_store.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import {
  managedToolDefinitionLoadRequest,
  managedWorkerDefinitionLoadRequest,
} from './worker_capsule.ts';
import {
  BUNDLED_TOOL_DEFINITION_IDENTITIES,
  bundledToolDefinitionLoadRequest,
  workerBuiltinModulePath,
} from './worker_definition_revision.ts';
import { AgentBindingError, resolveAgentSlotBindings } from '../definitions/agent_slot_binding.ts';
import { readDefaultSelection } from '../provider/default_selection.ts';
import { ManagedDefinitionStore } from '../definitions/managed_definition_store.ts';
import {
  type ResolvedToolDefinitionBinding,
  resolveToolDefinitionBindings,
  ToolBindingError,
} from '../definitions/tool_binding.ts';
import type {
  WorkerAsyncAgentCatalogEntry,
  WorkerToolDefinitionLoadRequest,
} from './worker_protocol.ts';
import type { WorkerHostCapsule } from './worker_host_contract.ts';
import type { ApplicationObservationSink, ApplicationQueryPort } from '../host/application_port.ts';
import { WorkerHostSession, WorkerHostStartupError } from './worker_host_session.ts';
import {
  builtinHenjiBaseInstruction,
  resolveHenjiBaseInstruction,
  type SelectedHenjiBaseInstruction,
} from '../instructions/base_instruction.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

export interface WorkerSessionOptions {
  readonly workspaceRoot?: string;
  readonly data?: DataService;
  readonly stateRoot?: string;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  /** Leave the initial session facade unstarted until an operation needs live Host behavior. */
  readonly lazyInitialHost?: boolean;
  readonly sessionId?: string;
  readonly agent?: SessionRecord['agent'];
  readonly selection?: HostDefinitionSelection;
  readonly dataRoot?: string;
  readonly configRoot?: string;
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
  readonly definition: DefinitionRevisionRef;
  readonly sessionId: string;
  submit(text: string): ReturnType<WorkerHostSession['submit']>;
  admit(text: string, executionId?: string): ReturnType<WorkerHostSession['admit']>;
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
  steerActiveTurn(text: string): 'accepted' | 'idle' | 'already_accepted';
  isAvailable(): boolean;
  selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'>;
  close(): Promise<void>;
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
  private closed = false;
  private pendingAdmission: { executionId: string; cancelled: boolean } | undefined;
  private localCredentialAvailability: CredentialAvailability | undefined;

  constructor(
    private readonly data: DataService,
    private readonly descriptor: DataSessionDescriptor,
    private readonly selected: DefinitionRevisionRef,
    private readonly startHost: () => Promise<WorkerHostSession>,
    private readonly config: Pick<
      WorkerSessionOptions,
      'rootMaxSteps' | 'providerTimeoutMs' | 'activation' | 'configRoot'
    >,
    private readonly builtinDefinition: boolean,
  ) {}

  get definition(): DefinitionRevisionRef {
    return structuredClone(this.selected);
  }

  get sessionId(): string {
    return this.descriptor.id;
  }

  private async ensureStarted(): Promise<WorkerHostSession> {
    if (this.closed) throw new Error('session is closed');
    if (this.host !== undefined) return this.host;
    if (this.starting === undefined) {
      this.starting = this.startHost().then((host) => {
        this.host = host;
        return host;
      });
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
    const reservation = { executionId, cancelled: false };
    this.pendingAdmission = reservation;
    try {
      const host = await this.ensureStarted();
      return await host.admit(text, executionId, reservation.cancelled);
    } finally {
      if (this.pendingAdmission === reservation) this.pendingAdmission = undefined;
    }
  }

  startupSnapshot():
    | ReturnType<WorkerHostSession['startupSnapshot']>
    | undefined {
    return this.host?.startupSnapshot();
  }

  effectiveConfigSnapshot(): EffectiveRuntimeConfig {
    if (this.host !== undefined) return this.host.effectiveConfigSnapshot();
    const definition = this.selected;
    const configuredMaxSteps = this.config.rootMaxSteps;
    const maxSteps = configuredMaxSteps ??
      (this.builtinDefinition ? DEFAULT_AGENT_MAX_STEPS : null);
    const maxStepsSource: EffectiveRuntimeConfig['maxStepsSource'] =
      configuredMaxSteps !== undefined
        ? 'activation'
        : this.builtinDefinition
        ? 'definition'
        : 'unevaluated';
    return {
      definition: {
        schemaVersion: definition.schemaVersion,
        resourceKind: definition.resourceKind,
        resourceId: definition.resourceId,
        revision: {
          algorithm: definition.revision.algorithm,
          digest: definition.revision.digest,
        },
      },
      maxSteps,
      maxStepsSource,
      providerTimeoutMs: this.config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
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
      this.host?.cancelActiveTurn();
      return 'requested';
    }
    return this.host?.cancelActiveTurn() ?? 'idle';
  }

  steerActiveTurn(text: string): 'accepted' | 'idle' | 'already_accepted' {
    return this.host?.steerActiveTurn(text) ?? 'idle';
  }

  isAvailable(): boolean {
    return !this.closed;
  }

  runtimeSnapshot() {
    return this.host?.runtimeSnapshot() ??
      { active: false, phase: 'idle' as const };
  }

  currentPosition(): ReturnType<WorkerHostSession['currentPosition']> {
    return this.host?.currentPosition() ?? structuredClone(this.descriptor.currentPosition);
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
        ...(this.config.configRoot === undefined ? {} : { configRoot: this.config.configRoot }),
        ...(registrationId === undefined ? {} : { registrationId }),
      })
      : (await credentialAvailabilityFor(profile)).status;
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
  const dataRoot = options.dataRoot ?? runtimePaths?.dataRoot;
  const configRoot = options.configRoot ??
    (options.dataRoot === undefined ? runtimePaths?.configRoot : `${options.dataRoot}/config`);
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
  const data = options.data ?? await createDataClient({
    stateRoot: options.stateRoot ?? launcherStateRoot(),
    workspaceRoot: workspace.root,
  });
  let selection = options.selection;
  if (selection !== undefined && options.agent !== undefined && selection.id !== options.agent) {
    if (ownsData) await data.close();
    throw new DefinitionStartupError(
      'definition_role_mismatch',
      'session_binding',
      'Explicit Agent role does not match the selected Definition',
      selection.ref,
    );
  }
  try {
    const saved = options.persistence === 'session' && options.sessionId !== undefined
      ? await data.sessionDescriptor(options.sessionId)
      : undefined;
    if (selection === undefined) {
      selection = await resolveRequestedDefinition(
        options.agent,
        undefined,
        options.dataRoot,
        configRoot,
      );
    }
    if (saved !== undefined && saved.agent !== selection.id) {
      throw new DefinitionStartupError(
        'definition_role_mismatch',
        'session_binding',
        'Session Agent role does not match the selected Definition',
        saved.definition,
      );
    }
  } catch (error) {
    if (ownsData) await data.close();
    throw error;
  }
  const descriptor = await data.openSession({
    persistence: options.persistence,
    agent: selection.id,
    definition: selection.ref,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    initialModelSelection: configuredDefaultSelection ??
      defaultModelSelectionFor('openrouter-chat'),
  }).catch(async (error) => {
    if (ownsData) await data.close();
    throw error;
  });
  try {
    if (selection === undefined) throw new SessionStoreError('session_invalid');
    const activeSelection = selection;
    const modulePath = activeSelection.kind === 'builtin'
      ? workerBuiltinModulePath(activeSelection.id)
      : undefined;
    const loadDescriptor = activeSelection.kind === 'managed'
      ? managedWorkerDefinitionLoadRequest(activeSelection.revision)
      : undefined;
    const definition = activeSelection.ref;
    /*
     * The activation-level `agents.json` file is validated on every generation open so an
     * abolished `subagent:<name>` slot surfaces a typed failure instead of being ignored.
     */
    const resolveAsyncAgentModule = dataRoot === undefined ? undefined : async (
      ref: import('../definitions/managed_resource_ref.ts').DefinitionRevisionRef,
    ) => {
      const store = new ManagedDefinitionStore({ dataRoot });
      const revision = await store.resolve(ref);
      return managedWorkerDefinitionLoadRequest(revision);
    };
    /** Resolve activation-level managed async Agent bindings for this generation. */
    const resolveAsyncAgents = async (): Promise<
      readonly WorkerAsyncAgentCatalogEntry[]
    > => {
      const entries: WorkerAsyncAgentCatalogEntry[] = [{
        name: 'generic',
        ref: await builtinDefinitionRef('generic', buildManifest()),
      }];
      if (configRoot !== undefined && dataRoot !== undefined) {
        let bindings: ReadonlyMap<
          string,
          {
            slot: { kind: string; name?: string };
            ref: import('../definitions/managed_resource_ref.ts').DefinitionRevisionRef;
          }
        >;
        try {
          bindings = await resolveAgentSlotBindings(configRoot, dataRoot);
        } catch (error) {
          if (error instanceof AgentBindingError) {
            throw new DefinitionStartupError(
              error.code === 'binding_definition_not_found'
                ? 'definition_not_found'
                : error.code === 'binding_role_mismatch'
                ? 'definition_role_mismatch'
                : 'definition_invalid',
              'resolution',
              error.message,
              error.definition,
            );
          }
          throw error;
        }
        for (const binding of bindings.values()) {
          if (
            binding.slot.kind !== 'agent' || binding.slot.name === undefined
          ) continue;
          entries.push({
            name: binding.slot.name,
            ref: structuredClone(binding.ref),
          });
        }
      }
      return entries;
    };
    /*
     * Resolve every declared tool Definition. An activation-level `tools.json` binding wins;
     * otherwise a bundled Definition is used when one exists. A binding failure is a typed startup
     * failure and never falls back to the bundled module.
     */
    const resolveToolDefinitions = async (): Promise<
      readonly WorkerToolDefinitionLoadRequest[] | undefined
    > => {
      let bindings: ReadonlyMap<string, ResolvedToolDefinitionBinding>;
      try {
        bindings = configRoot === undefined || dataRoot === undefined
          ? new Map<string, ResolvedToolDefinitionBinding>()
          : await resolveToolDefinitionBindings(configRoot, dataRoot);
      } catch (error) {
        if (error instanceof ToolBindingError) {
          throw new DefinitionStartupError(
            error.code === 'binding_definition_not_found'
              ? 'definition_not_found'
              : 'definition_invalid',
            'resolution',
            error.message,
          );
        }
        throw error;
      }
      const requests: WorkerToolDefinitionLoadRequest[] = [];
      const resolvedIdentities = new Set<string>();
      for (const identity of BUNDLED_TOOL_DEFINITION_IDENTITIES) {
        const bound = bindings.get(identity);
        if (bound !== undefined) {
          requests.push({
            toolIdentity: identity,
            ref: structuredClone(bound.ref),
            module: managedToolDefinitionLoadRequest(bound.revision),
          });
        } else {
          requests.push(await bundledToolDefinitionLoadRequest(identity));
        }
        resolvedIdentities.add(identity);
      }
      for (const [identity, bound] of bindings) {
        if (resolvedIdentities.has(identity)) continue;
        requests.push({
          toolIdentity: identity,
          ref: structuredClone(bound.ref),
          module: managedToolDefinitionLoadRequest(bound.revision),
        });
      }
      return requests.length === 0 ? undefined : requests;
    };
    const openHost = async (
      sessionDescriptor: DataSessionDescriptor,
    ): Promise<WorkerHostSession> => {
      try {
        setActiveProviderDeclarations(providerDeclarations);
        baseInstruction = await resolveBaseInstruction();
        return await WorkerHostSession.open({
          data,
          descriptor: sessionDescriptor,
          workspaceRoot: workspace.root,
          ...(configRoot === undefined ? {} : { configRoot }),
          modulePath,
          loadDescriptor,
          asyncAgents: await resolveAsyncAgents(),
          ...(resolveAsyncAgentModule === undefined ? {} : { resolveAsyncAgentModule }),
          toolDefinitions: await resolveToolDefinitions(),
          physicalIoMode: options.physicalIoMode,
          rootMaxSteps: options.rootMaxSteps,
          providerTimeoutMs: options.providerTimeoutMs,
          ...(options.activation === undefined ? {} : { activation: options.activation }),
          cancelSettlementGraceMs: options.cancelSettlementGraceMs,
          workerResponseTimeoutMs: options.workerResponseTimeoutMs,
          auxiliaryStageGapMs: options.auxiliaryStageGapMs,
          baseInstruction,
          providerDeclarations,
          eventSink: options.eventSink,
          applicationObservationSink: options.applicationObservationSink,
          capsuleFactory: options.capsuleFactory,
        });
      } catch (error) {
        if (
          activeSelection.kind !== 'managed' ||
          !(error instanceof WorkerHostStartupError)
        ) {
          throw error;
        }
        throw new DefinitionStartupError(
          error.code === 'module_invalid'
            ? 'definition_invalid'
            : error.code === 'role_mismatch'
            ? 'definition_role_mismatch'
            : 'definition_evaluation_failed',
          'worker_start',
          error.message,
          definition,
        );
      }
    };
    const host = options.lazyInitialHost ? undefined : await openHost(descriptor);
    const initialSelection = host?.modelSelectionSnapshot() ??
      descriptor.modelSelection ??
      configuredDefaultSelection ?? defaultModelSelectionFor('openrouter-chat');
    const startupSnapshot = host?.startupSnapshot();
    const displayState = projectRuntimeDisplayState({
      productVersion: buildManifest().productVersion,
      workspaceRoot: workspace.root,
      agentId: activeSelection.id,
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
      definition,
      () => openHost(descriptor),
      options,
      activeSelection.kind === 'builtin',
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
            credentialAvailability: currentHost.credentialAvailabilitySnapshot()!,
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
