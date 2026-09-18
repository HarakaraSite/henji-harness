import type { AgentEventSink } from '../core/events.ts';
import type { LoopOutcome, Message } from '../core/contracts.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import type { ProviderEvidenceStore } from '../provider/provider_evidence.ts';
import {
  builtinProviderDeclarations,
  loadProviderDeclarations,
  resolveProviderRegistry,
} from '../provider/provider_declaration.ts';
import {
  DefinitionStartupError,
  type HostDefinitionSelection,
  resolveRequestedDefinition,
} from '../definitions/definition_selection.ts';
import {
  projectRuntimeDisplayState,
  type RuntimeDisplayState,
} from '../runtime/startup_orientation.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import type { FailureDiagnosticPersister } from '../session/failure_diagnostic.ts';
import type {
  NavigationBinding,
  NavigationListing,
  NavigationPosition,
  NavigationSessionLike,
  SessionNavigationHost,
} from '../session/session_navigation.ts';
import { NavigationCancelledError, NavigationFatalError } from '../session/session_navigation.ts';
import { historyPageWindow, type SessionHistoryPage } from '../session/session_history.ts';
import {
  type DefinitionRevisionRef,
  launcherStateRoot,
  restoredMessages,
  type SemanticContextCheckpointV1,
  type SessionRecord,
  SessionStoreError,
  type StoredSessionRecord,
  type WorkerSessionHandle,
} from '../session/session_store.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import {
  managedToolDefinitionLoadRequest,
  managedWorkerDefinitionLoadRequest,
} from './worker_capsule.ts';
import {
  BUNDLED_SUBAGENT_NAMES,
  BUNDLED_TOOL_DEFINITION_IDENTITIES,
  bundledSubagentLoadRequest,
  bundledToolDefinitionLoadRequest,
  workerBuiltinModulePath,
} from './worker_definition_revision.ts';
import {
  AgentBindingError,
  resolveAgentSlotBindings,
  type ResolvedAgentSlotBinding,
} from '../definitions/agent_slot_binding.ts';
import {
  type ResolvedToolDefinitionBinding,
  resolveToolDefinitionBindings,
  ToolBindingError,
} from '../definitions/tool_binding.ts';
import type {
  WorkerSubagentLoadRequest,
  WorkerToolDefinitionLoadRequest,
} from './worker_protocol.ts';
import type { WorkerHostCapsule } from './worker_host_contract.ts';
import { sameRef } from './worker_host_outcome.ts';
import { WorkerHostSession, WorkerHostStartupError } from './worker_host_session.ts';
import type { WorkerExecutionArtifactStore } from './worker_execution_artifact_store.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import type { HumanHistoryReadPort } from '../history/human_history.ts';
import {
  builtinHenjiBaseInstruction,
  resolveActiveHenjiBaseInstruction,
  type SelectedHenjiBaseInstruction,
} from '../instructions/managed_instruction.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

class MemoryWorkerHandle implements WorkerSessionHandle {
  private current: StoredSessionRecord | undefined;
  private currentCheckpoint: SemanticContextCheckpointV1 | undefined;

  constructor(readonly id: string) {}

  get record(): StoredSessionRecord | undefined {
    return this.current === undefined ? undefined : structuredClone(this.current);
  }

  get checkpoint(): SemanticContextCheckpointV1 | undefined {
    return this.currentCheckpoint === undefined
      ? undefined
      : structuredClone(this.currentCheckpoint);
  }

  commit(record: StoredSessionRecord): void {
    this.current = structuredClone(record);
  }

  rollback(): void {
    this.current = undefined;
  }

  installCheckpoint(checkpoint: SemanticContextCheckpointV1): void {
    this.currentCheckpoint = structuredClone(checkpoint);
  }

  rollbackCheckpoint(): void {
    this.currentCheckpoint = undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface WorkerSessionOptions {
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
  readonly persistence: 'new' | 'continue' | 'session' | 'none';
  readonly sessionId?: string;
  readonly agent?: SessionRecord['agent'];
  readonly selection?: HostDefinitionSelection;
  readonly dataRoot?: string;
  readonly configRoot?: string;
  readonly physicalIoMode?: 'provider-free' | 'production';
  readonly rootMaxSteps?: number;
  readonly providerTimeoutMs?: number;
  readonly initialModelSelection?: ModelSelection;
  readonly eventSink?: AgentEventSink;
  readonly diagnosticPersistence?: FailureDiagnosticPersister;
  readonly providerEvidenceStore?: ProviderEvidenceStore;
  readonly executionArtifactStore?: WorkerExecutionArtifactStore;
  readonly capsuleFactory?: (url: URL) => WorkerHostCapsule;
}

export interface WorkerSessionResult {
  readonly session: WorkerHostSession;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
  readonly workspaceRoot: string;
  readonly restored?: {
    readonly messages: readonly Message[];
    readonly omitted: number;
  };
  readonly displayState: RuntimeDisplayState;
  readonly navigation?: SessionNavigationHost;
  readonly humanHistoryReader?: HumanHistoryReadPort;
}

const navigationPosition = (
  value: ReturnType<WorkerHostSession['currentPosition']>,
): NavigationPosition => ({
  sessionId: value.sessionId,
  createdAt: value.createdAt,
  ...(value.title === undefined ? {} : { title: value.title }),
  agent: value.agent,
  committedTurn: value.committedTurn,
  messageCount: value.messageCount,
  ...(value.checkpoint === undefined ? {} : { checkpoint: value.checkpoint }),
});

const restoreRecordMessages = (
  record: StoredSessionRecord | undefined,
):
  | { readonly messages: readonly Message[]; readonly omitted: number }
  | undefined => record === undefined ? undefined : restoredMessages(record.transcript);

/** Methods the TUI navigation and presentation use on the active session. */
export interface TuiActiveSession extends NavigationSessionLike {
  readonly definition: DefinitionRevisionRef;
  readonly sessionId: string;
  currentPosition(): ReturnType<WorkerHostSession['currentPosition']>;
  modelSelectionSnapshot(): ModelSelection;
  credentialAvailabilitySnapshot(): CredentialAvailability | undefined;
  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined;
  consumeAutoCompactionNotice(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null;
  prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }>;
  clearPendingRecall(): boolean;
  renameTitle(value: string): 'renamed' | 'unchanged' | 'busy' | 'unavailable';
  historyPage(page: number, turn?: number, rows?: number): SessionHistoryPage | undefined;
  requestCount(): number;
  close(): Promise<void>;
}

/**
 * A stored Session opened as the active session without starting a Worker generation.
 *
 * Opening and closing it (or reading its stored transcript and history) never starts the Worker.
 * The first operation that needs live agent behavior (submit, model selection, rename, recall,
 * compaction) starts the generation under the Definition resolved at open time.
 */
class LazyWorkerSession implements TuiActiveSession {
  private host: WorkerHostSession | undefined;
  private starting: Promise<WorkerHostSession> | undefined;
  private closed = false;

  constructor(
    private readonly handle: WorkerSessionHandle,
    private readonly record: StoredSessionRecord,
    private readonly selected: DefinitionRevisionRef,
    private readonly startHost: () => Promise<WorkerHostSession>,
  ) {}

  get definition(): DefinitionRevisionRef {
    return structuredClone(this.selected);
  }

  get sessionId(): string {
    return this.handle.id;
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

  async submit(text: string): Promise<LoopOutcome> {
    return await (await this.ensureStarted()).submit(text);
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    return this.host?.cancelActiveTurn() ?? 'idle';
  }

  steerActiveTurn(text: string): 'accepted' | 'idle' | 'already_accepted' {
    return this.host?.steerActiveTurn(text) ?? 'idle';
  }

  isAvailable(): boolean {
    return !this.closed;
  }

  transcriptSnapshot(): readonly Message[] {
    return this.host?.transcriptSnapshot() ?? structuredClone(this.record.transcript);
  }

  currentPosition(): ReturnType<WorkerHostSession['currentPosition']> {
    if (this.host !== undefined) return this.host.currentPosition();
    const checkpoint = this.handle.checkpoint;
    return {
      sessionId: this.handle.id,
      createdAt: this.record.createdAt,
      ...(this.record.title === null ? {} : { title: this.record.title }),
      agent: this.record.agent,
      committedTurn: this.record.nextTurn - 1,
      messageCount: this.record.transcript.length,
      ...(checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: checkpoint.coveredThroughTurn,
          retainedFromTurn: checkpoint.retainedFromTurn,
        },
      }),
    };
  }

  modelSelectionSnapshot(): ModelSelection {
    return this.host?.modelSelectionSnapshot() ?? structuredClone(this.record.activeModel);
  }

  credentialAvailabilitySnapshot(): CredentialAvailability | undefined {
    return this.host?.credentialAvailabilitySnapshot();
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.host?.checkpointSnapshot() ??
      (this.handle.checkpoint === undefined ? undefined : structuredClone(this.handle.checkpoint));
  }

  consumeAutoCompactionNotice(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null {
    return this.host?.consumeAutoCompactionNotice() ?? null;
  }

  clearPendingRecall(): boolean {
    return this.host?.clearPendingRecall() ?? false;
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

  renameTitle(value: string): 'renamed' | 'unchanged' | 'busy' | 'unavailable' {
    return this.host?.renameTitle(value) ?? 'unavailable';
  }

  historyPage(page: number, turn?: number, rows = 16): SessionHistoryPage | undefined {
    if (this.host !== undefined) return this.host.historyPage(page, turn, rows);
    return historyPageWindow(
      this.record.transcript,
      turn ?? this.record.nextTurn - 1,
      page,
      { sessionId: this.handle.id, agent: this.record.agent, rows },
    );
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
    await this.handle.close();
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
      : resolveActiveHenjiBaseInstruction(dataRoot!, configRoot!);
  const providerDeclarations = resolveManagedInstruction
    ? resolveProviderRegistry(
      builtinProviderDeclarations(),
      await loadProviderDeclarations({ configRoot: configRoot! }),
    ).declarations
    : Object.freeze([] as const);
  let baseInstruction: SelectedHenjiBaseInstruction = await resolveBaseInstruction();
  const sqliteHistory = options.persistence !== 'none' || options.physicalIoMode === 'production'
    ? new SqliteHistoryStore(
      options.stateRoot ?? launcherStateRoot(),
      workspace.root,
    )
    : undefined;
  const store = options.persistence === 'none' ? undefined : sqliteHistory;
  let handle: WorkerSessionHandle;
  let record: StoredSessionRecord | undefined;
  let selection = options.selection;
  if (selection !== undefined && options.agent !== undefined && selection.id !== options.agent) {
    throw new DefinitionStartupError(
      'definition_role_mismatch',
      'session_binding',
      'Explicit Agent role does not match the selected Definition',
      selection.ref,
    );
  }
  const requestedSelection = async (): Promise<HostDefinitionSelection> =>
    selection ??= await resolveRequestedDefinition(
      options.agent,
      undefined,
      options.dataRoot,
      configRoot,
    );
  const bindRecord = async (
    candidate: StoredSessionRecord,
    requested?: HostDefinitionSelection,
  ): Promise<HostDefinitionSelection> => {
    if (candidate.workspaceRoot !== workspace.root) {
      throw new SessionStoreError('session_invalid');
    }
    // A stored Session keeps its per-turn Definition attribution, but continuing it uses the
    // currently resolved Definition. A differing stored revision is a transition, not a failure.
    const current = requested ?? await requestedSelection();
    if (candidate.agent !== current.id) {
      throw new DefinitionStartupError(
        'definition_role_mismatch',
        'session_binding',
        'Session Agent role does not match the selected Definition',
        candidate.definition,
      );
    }
    return current;
  };
  if (options.persistence === 'none') {
    selection = await requestedSelection();
    handle = new MemoryWorkerHandle(crypto.randomUUID().toLowerCase());
  } else if (options.persistence === 'continue') {
    const requested = await requestedSelection();
    const listed = await store!.listWorker();
    const candidate = listed.sessions.find((item) => item.agent === requested.id);
    if (candidate === undefined) throw new Error('session not found');
    handle = await store!.openExistingWorker(candidate.id);
    record = handle.record;
    if (record === undefined) {
      await handle.close();
      throw new SessionStoreError('session_invalid');
    }
    try {
      selection = await bindRecord(record, requested);
    } catch (error) {
      await handle.close();
      throw error;
    }
  } else if (options.persistence === 'session') {
    if (options.sessionId === undefined) throw new Error('session id required');
    handle = await store!.openExistingWorker(options.sessionId);
    record = handle.record;
    if (record === undefined) {
      await handle.close();
      throw new SessionStoreError('session_invalid');
    }
    try {
      selection = await bindRecord(record, selection);
    } catch (error) {
      await handle.close();
      throw error;
    }
  } else {
    selection = await requestedSelection();
    handle = await store!.allocateWorker(selection.id, selection.ref);
  }
  try {
    if (selection === undefined) throw new SessionStoreError('session_invalid');
    if (options.persistence === 'none') await sqliteHistory?.initialize();
    const activeSelection = selection;
    const modulePath = activeSelection.kind === 'builtin'
      ? workerBuiltinModulePath(activeSelection.id)
      : undefined;
    const loadDescriptor = activeSelection.kind === 'managed'
      ? managedWorkerDefinitionLoadRequest(activeSelection.revision)
      : undefined;
    const definition = activeSelection.ref;
    const defaultDiagnosticStore = sqliteHistory?.diagnostics;
    const defaultEvidenceStore = sqliteHistory?.providerEvidence;
    const defaultExecutionArtifactStore = options.executionArtifactStore ??
      sqliteHistory?.executionArtifacts;
    if (
      record !== undefined &&
      (record.workspaceRoot !== workspace.root ||
        record.agent !== activeSelection.id)
    ) {
      throw new Error('session binding does not match the selected Definition');
    }
    /*
     * Resolve every activation-level `subagent:<name>` slot for each root parent generation. A
     * bound managed revision wins; otherwise a bundled module is used when one exists. Binding
     * changes apply only to generations opened after the change, never to a running generation.
     */
    const resolveSubagentDefinitions = async (): Promise<
      readonly WorkerSubagentLoadRequest[] | undefined
    > => {
      let bindings: ReadonlyMap<string, ResolvedAgentSlotBinding>;
      try {
        bindings = configRoot === undefined || dataRoot === undefined
          ? new Map<string, ResolvedAgentSlotBinding>()
          : await resolveAgentSlotBindings(configRoot, dataRoot);
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
      const requests: WorkerSubagentLoadRequest[] = [];
      const resolvedNames = new Set<string>();
      for (const resolvedBinding of bindings.values()) {
        if (resolvedBinding.slot.kind !== 'subagent') continue;
        requests.push({
          subagentName: resolvedBinding.slot.name,
          ref: structuredClone(resolvedBinding.ref),
          module: managedWorkerDefinitionLoadRequest(resolvedBinding.revision),
        });
        resolvedNames.add(resolvedBinding.slot.name);
      }
      for (const name of BUNDLED_SUBAGENT_NAMES) {
        if (resolvedNames.has(name)) continue;
        requests.push(await bundledSubagentLoadRequest(name));
      }
      return requests.length === 0 ? undefined : requests;
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
      workerHandle: WorkerSessionHandle,
      initialModelSelection = options.initialModelSelection,
    ): Promise<WorkerHostSession> => {
      try {
        baseInstruction = await resolveBaseInstruction();
        return await WorkerHostSession.open({
          handle: workerHandle,
          workspaceRoot: workspace.root,
          agent: activeSelection.id,
          definition,
          modulePath,
          loadDescriptor,
          subagentDefinitions: await resolveSubagentDefinitions(),
          toolDefinitions: await resolveToolDefinitions(),
          physicalIoMode: options.physicalIoMode,
          rootMaxSteps: options.rootMaxSteps,
          providerTimeoutMs: options.providerTimeoutMs,
          initialModelSelection,
          baseInstruction,
          providerDeclarations,
          eventSink: options.eventSink,
          diagnosticPersistence: options.diagnosticPersistence ??
            defaultDiagnosticStore?.persist,
          providerEvidenceStore: options.providerEvidenceStore ?? defaultEvidenceStore,
          executionArtifactStore: defaultExecutionArtifactStore,
          ...(sqliteHistory === undefined ? {} : {
            historyPersistence: sqliteHistory,
            durableCanonicalHistory: options.persistence !== 'none',
          }),
          capsuleFactory: options.capsuleFactory,
        });
      } catch (error) {
        if (activeSelection.kind !== 'managed' || !(error instanceof WorkerHostStartupError)) {
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
    const host = await openHost(handle);
    const initialSelection = host.modelSelectionSnapshot();
    const startupSnapshot = host.startupSnapshot();
    const displayState = projectRuntimeDisplayState({
      productVersion: buildManifest().productVersion,
      workspaceRoot: workspace.root,
      agentId: activeSelection.id,
      profileId: modelRouteProfileId(initialSelection),
      provider: initialSelection.provider,
      modelId: initialSelection.modelId,
      effort: initialSelection.effort,
      sessionMode: options.persistence,
      instructionSource: startupSnapshot.instructionSource,
      baseInstruction: {
        resourceId: baseInstruction.ref.resourceId,
        selectionSource: baseInstruction.selectionSource,
        revisionDigest: baseInstruction.ref.revision.digest,
      },
      skillNames: startupSnapshot.skillNames,
    });
    let currentHost: TuiActiveSession = host;
    let currentHandle = handle;
    let currentRecord = record;
    const position = (): NavigationPosition => navigationPosition(currentHost.currentPosition());
    const navigation = store === undefined ? undefined : {
      persistent: true,
      async list(signal?: AbortSignal): Promise<NavigationListing> {
        if (signal?.aborted) throw new Error('navigation cancelled');
        const listed = await store!.listWorker();
        if (signal?.aborted) throw new Error('navigation cancelled');
        return {
          sessions: listed.sessions.map((item) => ({
            ...item,
            current: item.id === currentHandle.id,
            resumed: item.id === currentHandle.id,
            mismatch: item.agent !== activeSelection.id || item.definition === undefined ||
              !sameRef(item.definition, definition),
          })),
          skippedInvalid: listed.skippedInvalid,
        };
      },
      renameCurrent(title: string) {
        return currentHost.renameTitle(title);
      },
      async createNew(signal?: AbortSignal): Promise<NavigationBinding> {
        if (signal?.aborted) throw new NavigationCancelledError();
        const inheritedSelection = currentHost.modelSelectionSnapshot();
        const targetHandle = await store!.allocateWorker(activeSelection.id, definition);
        let targetHost: WorkerHostSession | undefined;
        const cleanupTarget = async (): Promise<void> => {
          if (targetHost === undefined) await targetHandle.close();
          else await targetHost.close();
        };
        try {
          if (signal?.aborted) throw new NavigationCancelledError();
          targetHost = await openHost(targetHandle, inheritedSelection);
          if (signal?.aborted) throw new NavigationCancelledError();
        } catch (error) {
          try {
            await cleanupTarget();
          } catch {
            throw new NavigationFatalError('new session cleanup failed');
          }
          throw error;
        }
        try {
          await currentHost.close();
        } catch {
          try {
            await cleanupTarget();
          } catch {
            throw new NavigationFatalError('new session cleanup failed');
          }
          throw new NavigationFatalError('current session close failed');
        }
        currentHost = targetHost;
        currentHandle = targetHandle;
        currentRecord = targetHandle.record;
        return {
          session: currentHost,
          position: position(),
          restored: { messages: [], omitted: 0 },
        };
      },
      async switchTo(
        id: string,
        signal?: AbortSignal,
      ): Promise<NavigationBinding> {
        if (signal?.aborted) throw new Error('navigation cancelled');
        const targetHandle = await store!.openExistingWorker(id);
        try {
          const targetRecord = targetHandle.record;
          if (
            targetRecord === undefined ||
            targetRecord.workspaceRoot !== workspace.root ||
            targetRecord.agent !== activeSelection.id
          ) throw new Error('session binding does not match the selected Definition');
          // Open the stored Session as the active session without starting a Worker. The generation
          // starts lazily under the currently resolved Definition on the first live operation.
          const lazy = new LazyWorkerSession(
            targetHandle,
            targetRecord,
            definition,
            () => openHost(targetHandle),
          );
          await currentHost.close();
          currentHost = lazy;
          currentHandle = targetHandle;
          currentRecord = targetRecord;
          const restored = restoreRecordMessages(targetRecord);
          return {
            session: currentHost,
            position: position(),
            ...(restored === undefined ? {} : { restored }),
          };
        } catch (error) {
          await targetHandle.close();
          throw error;
        }
      },
      historyPage(page: number, turn?: number, rows?: number) {
        return Promise.resolve(currentHost.historyPage(page, turn, rows));
      },
      currentPosition: position,
    } satisfies SessionNavigationHost;
    return {
      session: host,
      requestCount: () => currentHost.requestCount(),
      close: () => currentHost.close(),
      workspaceRoot: workspace.root,
      displayState,
      ...(currentRecord === undefined ? {} : { restored: restoreRecordMessages(currentRecord) }),
      ...(navigation === undefined ? {} : { navigation }),
      ...(sqliteHistory === undefined || options.persistence === 'none'
        ? {}
        : { humanHistoryReader: sqliteHistory }),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
};
