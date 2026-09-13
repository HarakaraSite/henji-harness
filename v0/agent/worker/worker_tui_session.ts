import type { AgentEventSink } from '../core/events.ts';
import type { Message } from '../core/contracts.ts';
import { modelRouteProfileId } from '../provider/model_selection.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { ProviderEvidenceStore } from '../provider/provider_evidence.ts';
import {
  DefinitionStartupError,
  type HostDefinitionSelection,
  resolveDefinitionRef,
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
  SessionNavigationHost,
} from '../session/session_navigation.ts';
import { NavigationCancelledError, NavigationFatalError } from '../session/session_navigation.ts';
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
import { managedWorkerDefinitionLoadRequest } from './worker_capsule.ts';
import { workerBuiltinModulePath } from './worker_definition_revision.ts';
import type { WorkerHostCapsule } from './worker_host_contract.ts';
import { sameRef } from './worker_host_outcome.ts';
import { WorkerHostSession, WorkerHostStartupError } from './worker_host_session.ts';
import type { WorkerExecutionArtifactStore } from './worker_execution_artifact_store.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import type { HumanHistoryReadPort } from '../history/human_history.ts';

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

const recordRefMatches = (
  record: StoredSessionRecord | undefined,
  definition: DefinitionRevisionRef,
): boolean => {
  return record === undefined || sameRef(record.definition, definition);
};

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

/** Build one Host-owned session through the common headless Worker route. */
export const createWorkerSession = async (
  options: WorkerSessionOptions,
): Promise<WorkerSessionResult> => {
  const workspace = await resolveWorkspace(options.workspaceRoot);
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
    selection ??= await resolveRequestedDefinition(options.agent, undefined, options.dataRoot);
  const bindRecord = async (
    candidate: StoredSessionRecord,
    requested?: HostDefinitionSelection,
  ): Promise<HostDefinitionSelection> => {
    if (candidate.workspaceRoot !== workspace.root) {
      throw new SessionStoreError('session_invalid');
    }
    const resolved = await resolveDefinitionRef(candidate.definition, options.dataRoot);
    if (candidate.agent !== resolved.id) {
      throw new DefinitionStartupError(
        'definition_role_mismatch',
        'session_binding',
        'Session Agent role does not match its exact Definition revision',
        candidate.definition,
      );
    }
    if (requested !== undefined && !sameRef(requested.ref, candidate.definition)) {
      throw new DefinitionStartupError(
        'definition_invalid',
        'session_binding',
        'Session exact Definition revision does not match the explicit selector',
        candidate.definition,
      );
    }
    return resolved;
  };
  if (options.persistence === 'none') {
    selection = await requestedSelection();
    handle = new MemoryWorkerHandle(crypto.randomUUID().toLowerCase());
  } else if (options.persistence === 'continue') {
    const requested = await requestedSelection();
    const listed = await store!.listWorker();
    const candidate = listed.sessions.find((item) =>
      item.agent === requested.id && item.definition !== undefined &&
      sameRef(item.definition, requested.ref)
    );
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
        record.agent !== activeSelection.id ||
        !recordRefMatches(record, definition))
    ) {
      throw new Error(
        'session Definition revision does not match the selected binding',
      );
    }
    const openHost = async (
      workerHandle: WorkerSessionHandle,
      initialModelSelection = options.initialModelSelection,
    ): Promise<WorkerHostSession> => {
      try {
        return await WorkerHostSession.open({
          handle: workerHandle,
          workspaceRoot: workspace.root,
          agent: activeSelection.id,
          definition,
          modulePath,
          loadDescriptor,
          physicalIoMode: options.physicalIoMode,
          rootMaxSteps: options.rootMaxSteps,
          providerTimeoutMs: options.providerTimeoutMs,
          initialModelSelection,
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
      skillNames: startupSnapshot.skillNames,
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
            targetRecord.agent !== activeSelection.id ||
            !recordRefMatches(targetRecord, definition)
          ) throw new Error('session Definition revision mismatch');
          const targetHost = await openHost(targetHandle);
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
