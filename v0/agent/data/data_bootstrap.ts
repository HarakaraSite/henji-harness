import { captureFailureDetails } from '../core/failure_details.ts';
import { createDataService } from './data_service.ts';
import {
  type DataConversationUpdate,
  type DataService,
  DataServiceError,
  type DataWorkerRequest,
  type DataWorkerResponse,
} from './data_contract.ts';

type DataWorkerScope = {
  onmessage: ((event: MessageEvent<DataWorkerRequest>) => void) | null;
  postMessage: (message: DataWorkerResponse, transfer?: Transferable[]) => void;
  close: () => void;
};

const scope = globalThis as unknown as DataWorkerScope;
let service: DataService | undefined;
const sessionWatches = new Map<string, () => void>();
let unsubscribeAgentEvents: (() => void) | undefined;

const asDataError = (error: unknown): DataServiceError =>
  error instanceof DataServiceError ? error : new DataServiceError(
    500,
    'data_read_failed',
    error instanceof Error ? error.message : String(error),
  );

const replyError = (id: number, error: unknown, operation: string): void => {
  const dataError = asDataError(error);
  scope.postMessage({
    id,
    kind: 'error',
    error: {
      status: dataError.status,
      code: dataError.code,
      message: dataError.message,
      details: captureFailureDetails(error, { operation: `data_${operation}` }),
    },
  });
};

const replyValue = (id: number, value: unknown): void => {
  scope.postMessage({ id, kind: 'value', value });
};

const postSessionDelta = (update: DataConversationUpdate): void => {
  scope.postMessage({ kind: 'session_delta', update });
};

const requireService = (): DataService => {
  if (service === undefined) {
    throw new DataServiceError(503, 'data_worker_not_initialized');
  }
  return service;
};

const handle = async (request: DataWorkerRequest): Promise<void> => {
  try {
    if (request.kind === 'initialize') {
      if (service !== undefined) {
        throw new DataServiceError(409, 'data_worker_initialized');
      }
      service = await createDataService({
        stateRoot: request.stateRoot,
        workspaceRoot: request.workspaceRoot,
      });
      scope.postMessage({ id: request.id, kind: 'initialized' });
      return;
    }

    if (request.kind === 'close') {
      for (const unsubscribe of sessionWatches.values()) unsubscribe();
      sessionWatches.clear();
      unsubscribeAgentEvents?.();
      unsubscribeAgentEvents = undefined;
      await service?.close();
      scope.postMessage({ id: request.id, kind: 'closed' });
      scope.close();
      return;
    }

    const data = requireService();
    switch (request.kind) {
      case 'history_read': {
        const result = await data.historyRead(request.input);
        scope.postMessage({
          id: request.id,
          kind: 'encoded',
          bytes: result.bytes,
        }, [
          result.bytes.buffer,
        ]);
        return;
      }
      case 'context_read': {
        const result = await data.contextRead(
          request.sessionId,
          request.pendingRecall,
          request.activeSession,
        );
        scope.postMessage({
          id: request.id,
          kind: 'encoded',
          bytes: result.bytes,
        }, [
          result.bytes.buffer,
        ]);
        return;
      }
      case 'execution_read':
        scope.postMessage({
          id: request.id,
          kind: 'execution',
          result: await data.executionRead(request.executionId),
        });
        return;
      case 'session_open':
        replyValue(request.id, await data.openSession(request.input));
        return;
      case 'session_close':
        await data.closeSession(request.sessionId);
        replyValue(request.id, undefined);
        return;
      case 'session_descriptor':
        replyValue(request.id, await data.sessionDescriptor(request.sessionId));
        return;
      case 'sessions_list':
        replyValue(request.id, await data.sessionsList());
        return;
      case 'session_delete':
        await data.deleteSession(request.sessionId);
        replyValue(request.id, undefined);
        return;
      case 'conversation_snapshot':
        replyValue(
          request.id,
          await data.conversationSnapshot(request.sessionId),
        );
        return;
      case 'watch_session': {
        const existing = sessionWatches.get(request.sessionId);
        if (existing !== undefined) {
          replyValue(
            request.id,
            await data.conversationSnapshot(request.sessionId),
          );
          return;
        }
        const buffered: DataConversationUpdate[] = [];
        let registering = true;
        const watched = await data.watchSession(request.sessionId, (update) => {
          if (registering) buffered.push(update);
          else postSessionDelta(update);
        });
        sessionWatches.set(request.sessionId, watched.unsubscribe);
        replyValue(request.id, watched.snapshot);
        registering = false;
        for (const update of buffered) {
          if (update.cut > watched.snapshot.cut) postSessionDelta(update);
        }
        return;
      }
      case 'unwatch_session': {
        sessionWatches.get(request.sessionId)?.();
        sessionWatches.delete(request.sessionId);
        replyValue(request.id, undefined);
        return;
      }
      case 'attach_generation': {
        const port = await data.attachGeneration(
          request.sessionId,
          request.correlation,
        );
        scope.postMessage(
          { id: request.id, kind: 'attached_generation', port },
          [port],
        );
        return;
      }
      case 'execution_admit':
        replyValue(
          request.id,
          await data.executionAdmit(request.sessionId, request.input),
        );
        return;
      case 'execution_control':
        replyValue(
          request.id,
          await data.recordExecutionControl(
            request.sessionId,
            request.executionId,
            request.input,
          ),
        );
        return;
      case 'prepare_proposal':
        replyValue(
          request.id,
          await data.prepareProposal(request.sessionId, request.input),
        );
        return;
      case 'authorize_commit':
        replyValue(
          request.id,
          await data.authorizeCommit(
            request.sessionId,
            request.token,
            request.decision,
          ),
        );
        return;
      case 'settle_failure':
        replyValue(
          request.id,
          await data.settleFailure(request.sessionId, request.input),
        );
        return;
      case 'seal_generation':
        replyValue(
          request.id,
          await data.sealGeneration(request.sessionId, request.input),
        );
        return;
      case 'settle_child':
        replyValue(
          request.id,
          await data.settleChildExecution(request.sessionId, request.input),
        );
        return;
      case 'execution_artifact_metadata':
        await data.updateExecutionArtifactMetadata(
          request.sessionId,
          request.executionId,
          request.metadata,
        );
        replyValue(request.id, undefined);
        return;
      case 'install_checkpoint':
        replyValue(
          request.id,
          await data.installCheckpoint(request.sessionId, request.message),
        );
        return;
      case 'update_model_selection':
        replyValue(
          request.id,
          await data.updateModelSelection(request.sessionId, request.selection),
        );
        return;
      case 'update_title':
        replyValue(
          request.id,
          await data.updateTitle(request.sessionId, request.title),
        );
        return;
      case 'prepare_recall':
        replyValue(
          request.id,
          await data.prepareRecall(
            request.sessionId,
            request.executionIdPrefix,
          ),
        );
        return;
      case 'clear_recall':
        replyValue(
          request.id,
          await data.clearPendingRecall(request.sessionId),
        );
        return;
      case 'consume_compaction_notice':
        replyValue(
          request.id,
          await data.consumeAutoCompactionNotice(request.sessionId),
        );
        return;
      case 'agent_events_enabled':
        if (request.enabled && unsubscribeAgentEvents === undefined) {
          unsubscribeAgentEvents = data.subscribeAgentEvents(
            (sessionId, eventBytes) => {
              scope.postMessage({ kind: 'agent_event', sessionId, eventBytes });
            },
          );
        } else if (!request.enabled && unsubscribeAgentEvents !== undefined) {
          unsubscribeAgentEvents();
          unsubscribeAgentEvents = undefined;
        }
        replyValue(request.id, undefined);
        return;
      case 'persist_catalog_facts':
        await data.persistCatalogFacts(request.facts);
        replyValue(request.id, undefined);
        return;
    }
  } catch (error) {
    replyError(request.id, error, request.kind);
  }
};

scope.onmessage = (event): void => {
  // Requests remain independent so a pending final-sequence barrier never blocks seal/terminal.
  void handle(event.data);
};
