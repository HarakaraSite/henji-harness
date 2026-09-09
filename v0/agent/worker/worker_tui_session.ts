import type { AgentEventSink } from '../core/events.ts';
import type { Message } from '../core/contracts.ts';
import { discoverAgentInstructionSnapshot } from '../definitions/agent_instructions.ts';
import { discoverSkills } from '../definitions/skills.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { ProviderEvidenceStore } from '../provider/provider_evidence.ts';
import { DenoProviderEvidenceStore } from '../provider/provider_evidence_store.ts';
import {
  projectRuntimeDisplayState,
  type RuntimeDisplayState,
} from '../runtime/startup_orientation.ts';
import type { FailureDiagnosticPersister } from '../session/failure_diagnostic.ts';
import { DenoFailureDiagnosticStore } from '../session/failure_diagnostic_store.ts';
import type {
  NavigationBinding,
  NavigationListing,
  NavigationPosition,
  SessionNavigationHost,
} from '../session/session_navigation.ts';
import {
  type DefinitionRevisionRef,
  DenoSessionStore,
  launcherStateRoot,
  restoredMessages,
  type SemanticContextCheckpointV1,
  type SessionRecord,
  type StoredSessionRecord,
  type WorkerSessionHandle,
  type WorkerSessionStorePort,
} from '../session/session_store.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import { readDefinitionRevision, workerBuiltinModulePath } from './worker_definition_revision.ts';
import type { WorkerHostCapsule } from './worker_host_contract.ts';
import { sameRef } from './worker_host_outcome.ts';
import { WorkerHostSession } from './worker_host_session.ts';
import {
  DenoWorkerExecutionArtifactStore,
  type WorkerExecutionArtifactStore,
} from './worker_execution_artifact_store.ts';

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
  readonly agent: SessionRecord['agent'];
  readonly externalDefinitionPath?: string;
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
  readonly sessionLine?: string;
  readonly restored?: {
    readonly messages: readonly Message[];
    readonly omitted: number;
  };
  readonly displayState: RuntimeDisplayState;
  readonly navigation?: SessionNavigationHost;
}

const recordRefMatches = (
  record: StoredSessionRecord | undefined,
  definition: DefinitionRevisionRef,
): boolean => {
  if (record === undefined || record.schemaVersion === 1) {
    return definition.kind === 'builtin';
  }
  return sameRef(record.definition, definition);
};

const navigationPosition = (
  value: ReturnType<WorkerHostSession['currentPosition']>,
): NavigationPosition => ({
  sessionId: value.sessionId,
  agent: value.agent,
  committedTurn: value.committedTurn,
  messageCount: value.messageCount,
  ...(value.checkpoint === undefined ? {} : { checkpoint: value.checkpoint }),
});

const workerDefinitionPath = async (
  workspaceRoot: string,
  externalPath: string,
): Promise<string> => {
  if (!externalPath.endsWith('.ts')) {
    throw new Error('external Definition must be a TypeScript file');
  }
  const candidate = externalPath.startsWith('/') ? externalPath : `${Deno.cwd()}/${externalPath}`;
  const canonical = await Deno.realPath(candidate);
  if (
    canonical !== workspaceRoot && !canonical.startsWith(`${workspaceRoot}/`)
  ) {
    throw new Error('external Definition must stay within the workspace');
  }
  return canonical;
};

const restoreRecordMessages = (
  record: StoredSessionRecord | undefined,
):
  | { readonly messages: readonly Message[]; readonly omitted: number }
  | undefined => record === undefined ? undefined : restoredMessages(record.transcript);

/** Build one Host-owned session through the common headless Worker route. */
export const createWorkerSession = async (
  options: WorkerSessionOptions,
): Promise<WorkerSessionResult> => {
  const workspace = await resolveWorkspace(options.workspaceRoot);
  const instructionSnapshot = await discoverAgentInstructionSnapshot(
    workspace.root,
  );
  const skillCatalog = await discoverSkills(workspace.root);
  const modulePath = options.externalDefinitionPath === undefined
    ? workerBuiltinModulePath(options.agent)
    : await workerDefinitionPath(
      workspace.root,
      options.externalDefinitionPath,
    );
  const definition = await readDefinitionRevision(
    modulePath,
    options.externalDefinitionPath === undefined ? 'builtin' : 'external',
    options.externalDefinitionPath === undefined ? options.agent : undefined,
  );
  const productionStateRoot = options.physicalIoMode === 'production'
    ? options.stateRoot ?? launcherStateRoot()
    : undefined;
  const defaultDiagnosticStore = options.physicalIoMode === 'production' &&
      options.diagnosticPersistence === undefined
    ? new DenoFailureDiagnosticStore(productionStateRoot!, workspace.root)
    : undefined;
  const defaultEvidenceStore = options.physicalIoMode === 'production' &&
      options.providerEvidenceStore === undefined
    ? new DenoProviderEvidenceStore(productionStateRoot!, workspace.root)
    : undefined;
  const defaultExecutionArtifactStore = options.executionArtifactStore ??
    (options.physicalIoMode === 'production' || options.stateRoot !== undefined
      ? new DenoWorkerExecutionArtifactStore(
        options.stateRoot ?? launcherStateRoot(),
        workspace.root,
      )
      : undefined);
  const store: WorkerSessionStorePort | undefined = options.persistence === 'none'
    ? undefined
    : new DenoSessionStore(
      options.stateRoot ?? launcherStateRoot(),
      workspace.root,
    );
  let handle: WorkerSessionHandle;
  let record: StoredSessionRecord | undefined;
  if (options.persistence === 'none') {
    handle = new MemoryWorkerHandle(crypto.randomUUID().toLowerCase());
  } else if (options.persistence === 'continue') {
    const listed = await store!.listWorker();
    const candidate = listed.sessions.find((item) =>
      item.agent === options.agent &&
      (item.definition === undefined
        ? definition.kind === 'builtin'
        : sameRef(item.definition, definition))
    );
    if (candidate === undefined) throw new Error('session not found');
    handle = await store!.openExistingWorker(candidate.id);
    record = handle.record;
  } else if (options.persistence === 'session') {
    if (options.sessionId === undefined) throw new Error('session id required');
    handle = await store!.openExistingWorker(options.sessionId);
    record = handle.record;
  } else {
    handle = await store!.allocateWorker(options.agent, definition);
  }
  try {
    if (
      record !== undefined &&
      (record.workspaceRoot !== workspace.root ||
        record.agent !== options.agent ||
        !recordRefMatches(record, definition))
    ) {
      throw new Error(
        'session Definition revision does not match the selected binding',
      );
    }
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: workspace.root,
      agent: options.agent,
      definition,
      modulePath,
      physicalIoMode: options.physicalIoMode,
      rootMaxSteps: options.rootMaxSteps,
      providerTimeoutMs: options.providerTimeoutMs,
      initialModelSelection: options.initialModelSelection,
      eventSink: options.eventSink,
      diagnosticPersistence: options.diagnosticPersistence ??
        defaultDiagnosticStore?.persist,
      providerEvidenceStore: options.providerEvidenceStore ?? defaultEvidenceStore,
      executionArtifactStore: defaultExecutionArtifactStore,
      capsuleFactory: options.capsuleFactory,
    });
    const initialSelection = host.modelSelectionSnapshot();
    const displayState = projectRuntimeDisplayState({
      workspaceRoot: workspace.root,
      agentId: options.agent,
      profileId: modelRouteProfileId(initialSelection),
      provider: initialSelection.provider,
      modelId: initialSelection.modelId,
      effort: initialSelection.effort,
      sessionMode: options.persistence,
      instructionSource: instructionSnapshot?.source,
      skillNames: skillCatalog.skills.map((skill) => skill.name),
    });
    let currentHost = host;
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
            mismatch: item.agent !== options.agent ||
              (item.definition === undefined
                ? definition.kind !== 'builtin'
                : !sameRef(item.definition, definition)),
          })),
          skippedInvalid: listed.skippedInvalid,
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
            targetRecord.agent !== options.agent ||
            !recordRefMatches(targetRecord, definition)
          ) throw new Error('session Definition revision mismatch');
          const targetHost = await WorkerHostSession.open({
            handle: targetHandle,
            workspaceRoot: workspace.root,
            agent: options.agent,
            definition,
            modulePath,
            physicalIoMode: options.physicalIoMode,
            rootMaxSteps: options.rootMaxSteps,
            providerTimeoutMs: options.providerTimeoutMs,
            eventSink: options.eventSink,
            diagnosticPersistence: options.diagnosticPersistence ??
              defaultDiagnosticStore?.persist,
            providerEvidenceStore: options.providerEvidenceStore ??
              defaultEvidenceStore,
            executionArtifactStore: defaultExecutionArtifactStore,
            capsuleFactory: options.capsuleFactory,
          });
          await currentHost.close();
          currentHost = targetHost;
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
      ...(options.persistence === 'none' ? {} : {
        sessionLine: `session> ${handle.id} ${currentRecord === undefined ? '(new)' : '(resumed)'}`,
      }),
      ...(navigation === undefined ? {} : { navigation }),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

/** Compatibility alias for the current terminal Surface. */
export const createWorkerTuiSession = createWorkerSession;
export type WorkerTuiSessionOptions = WorkerSessionOptions;
export type WorkerTuiSessionResult = WorkerSessionResult;

export const workerSessionRecord = (
  record: StoredSessionRecord | undefined,
): StoredSessionRecord | undefined => record === undefined ? undefined : structuredClone(record);
