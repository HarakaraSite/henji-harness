import type { AgentEvent } from '../agent/core/events.ts';
import type { NavigationBinding } from '../agent/session/session_navigation.ts';
import type { SessionNavigationHost } from '../agent/session/session_navigation.ts';
import type { HistoryExportSessionIdentity } from '../agent/session/history_export.ts';
import {
  type PresentationContextMetrics,
  type PresentationContextPreview,
  type PresentationContextResult,
  PresentationDeliveryError,
  type PresentationEvent,
  type PresentationEventSink,
  type PresentationHistoryPage,
  type PresentationIntent,
  presentationIntent,
  type PresentationIntentDispatcher,
  type PresentationIntentResult,
  type PresentationMessage,
  type PresentationOutcome,
  type PresentationPosition,
  snapshotPresentation,
} from './contract.ts';
import type {
  AdapterNavigationPort,
  AdapterSessionPort,
  CoreSession,
  TuiPresentationAdapterOptions,
} from './adapter_contract.ts';
import {
  defaultModelSelectionFor,
  type ModelSelection,
  type ProviderId,
  type ReasoningEffort,
  selectModelFor,
} from '../agent/provider/model_catalog.ts';

const recallRejectionReason = (
  error: unknown,
): Extract<PresentationIntentResult, { readonly kind: 'rejected' }>['reason'] => {
  if (typeof error !== 'object' || error === null) return 'failed';
  const value = error as { readonly name?: unknown; readonly code?: unknown };
  if (value.name !== 'WorkerRecallSelectionError') return 'failed';
  return value.code === 'unavailable' || value.code === 'busy' || value.code === 'not_found' ||
      value.code === 'ambiguous'
    ? value.code
    : 'failed';
};
import {
  assistantMessage,
  bounded,
  callMessage,
  contextResult,
  count,
  diagnosticDurability,
  diagnosticPersistenceError,
  failureDiagnostic,
  fixedCount,
  history,
  humanHistoryDetail,
  humanHistoryPage,
  humanHistorySearchHit,
  listing,
  optionalBoundedCount,
  outcome,
  position,
  preview,
  providerEvidenceDurability,
  providerEvidenceId,
  providerEvidencePersistenceError,
  restoredPresentationMessages,
  result,
  text,
  userMessage,
} from './adapter_projection.ts';
/**
 * Translate one core session into the small port consumed by the retained UI.  The adapter owns
 * event identity, sanitization and error translation; the UI never receives the core session.
 */
export class TuiPresentationAdapter implements AdapterSessionPort, PresentationIntentDispatcher {
  private readonly callIds = new Map<string, string>();
  private callOrdinal = 0;
  private generation = 0;
  private sink: PresentationEventSink | undefined;
  private compactionAbort: AbortController | null = null;
  private readonly navigationAborts = new Set<AbortController>();

  constructor(
    private core: CoreSession,
    sink?: PresentationEventSink,
    private readonly coreNavigation?: SessionNavigationHost,
    private readonly options: TuiPresentationAdapterOptions = {},
  ) {
    this.sink = sink;
  }

  setSink(sink: PresentationEventSink): void {
    this.sink = sink;
  }

  private emit(event: PresentationEvent): void {
    if (this.sink === undefined) return;
    try {
      this.sink(snapshotPresentation(event));
    } catch {
      throw new PresentationDeliveryError();
    }
  }

  /** Core event entry point used only by the composition root. */
  deliverCoreEvent(event: AgentEvent): void {
    try {
      this.deliverCoreEventUnsafe(event);
    } catch (error) {
      if (error instanceof PresentationDeliveryError) throw error;
      throw new PresentationDeliveryError();
    }
  }

  private deliverCoreEventUnsafe(event: AgentEvent): void {
    const generation = ++this.generation;
    if (
      event === null || typeof event !== 'object' ||
      typeof event.kind !== 'string'
    ) {
      this.emit({
        kind: 'warning',
        code: 'unsupported_activity',
        text: 'unsupported activity omitted',
        generation,
      });
      return;
    }
    switch (event.kind) {
      case 'turn_start':
        this.callIds.clear();
        this.callOrdinal = 0;
        this.emit({ kind: 'turn_start', turn: event.turn });
        return;
      case 'user_message':
        this.emit({
          kind: 'user_message',
          turn: event.turn,
          message: userMessage(event.message),
        });
        return;
      case 'assistant_message':
        this.emit({
          kind: 'assistant_message',
          turn: event.turn,
          message: assistantMessage(
            event.message,
            this.callIds,
            () => `call-${++this.callOrdinal}`,
          ),
        });
        return;
      case 'assistant_progress':
        this.emit({
          kind: 'assistant_progress',
          turn: event.turn,
          text: text(event.text),
        });
        return;
      case 'tool_call': {
        const callId = this.callIds.get(event.call.callId) ??
          `call-${++this.callOrdinal}`;
        this.callIds.set(event.call.callId, callId);
        this.emit({
          kind: 'tool_call',
          turn: event.turn,
          call: callMessage(event.call, callId),
        });
        return;
      }
      case 'tool_result': {
        const callId = this.callIds.get(event.result.callId) ??
          `call-${++this.callOrdinal}`;
        this.callIds.set(event.result.callId, callId);
        this.emit({
          kind: 'tool_result',
          turn: event.turn,
          result: result(event.result, callId),
        });
        return;
      }
      case 'tool_progress': {
        const callId = this.callIds.get(event.callId) ??
          `call-${++this.callOrdinal}`;
        this.callIds.set(event.callId, callId);
        this.emit({
          kind: 'tool_progress',
          turn: event.turn,
          callId,
          name: text(event.name),
          text: text(event.text),
        });
        return;
      }
      case 'steering_message':
        this.emit({
          kind: 'steering_message',
          turn: event.turn,
          message: userMessage(event.message),
        });
        return;
      case 'turn_end':
        if (event.diagnostic !== undefined) {
          const durable = event.diagnosticDurability === undefined
            ? 'unknown' as const
            : diagnosticDurability(event.diagnosticDurability);
          this.emit({
            kind: 'failure_diagnostic',
            turn: event.turn,
            diagnostic: failureDiagnostic(event.diagnostic),
            durable,
            ...(event.diagnosticPersistenceError === undefined ? {} : {
              persistenceError: diagnosticPersistenceError(event.diagnosticPersistenceError),
            }),
          });
        }
        this.emit({
          kind: 'turn_end',
          turn: event.turn,
          outcome: event.outcome,
          committed: event.committed,
          ...(event.turnProviderRequestCount === undefined ? {} : {
            turnProviderRequestCount: optionalBoundedCount(event.turnProviderRequestCount),
          }),
          ...(event.runtimeProviderRequestCount === undefined ? {} : {
            runtimeProviderRequestCount: optionalBoundedCount(event.runtimeProviderRequestCount),
          }),
          ...(event.providerEvidenceId === undefined ? {} : {
            providerEvidenceId: providerEvidenceId(event.providerEvidenceId),
          }),
          ...(event.providerEvidenceDurability === undefined ? {} : {
            providerEvidenceDurability: providerEvidenceDurability(
              event.providerEvidenceDurability,
            ),
          }),
          ...(event.providerEvidencePersistenceError === undefined ? {} : {
            providerEvidencePersistenceError: providerEvidencePersistenceError(
              event.providerEvidencePersistenceError,
            ),
          }),
        });
        this.emit({
          kind: 'lifecycle',
          lifecycle: event.committed ? 'idle' : 'recoverable_error',
          generation,
        });
        return;
      default:
        this.emit({
          kind: 'warning',
          code: 'unsupported_activity',
          text: 'unsupported activity omitted',
          generation,
        });
        return;
    }
  }

  submit(textValue: string): Promise<PresentationOutcome> {
    return this.core.submit(textValue).then(outcome);
  }
  cancelActiveTurn() {
    return this.core.cancelActiveTurn?.() ?? 'idle';
  }
  steerActiveTurn(textValue: string) {
    return this.core.steerActiveTurn?.(textValue) ?? 'idle';
  }
  contextSnapshot(): PresentationContextMetrics | undefined {
    const value = this.core.contextSnapshot?.();
    return value === undefined ? undefined : Object.freeze({
      messageEstimatedTokensBefore: count(value.messageEstimatedTokensBefore),
      messageEstimatedTokensAfter: count(value.messageEstimatedTokensAfter),
      toolEstimatedTokens: count(value.toolEstimatedTokens),
      requestEstimatedTokensBefore: count(value.requestEstimatedTokensBefore),
      requestEstimatedTokensAfter: count(value.requestEstimatedTokensAfter),
      triggerTokens: fixedCount(value.triggerTokens, 65_536),
      targetTokens: fixedCount(value.targetTokens, 49_152),
      triggered: value.triggered,
      targetReached: value.targetReached,
      compressedResultCount: count(value.compressedResultCount),
      compressedMessageCount: count(value.compressedMessageCount),
    });
  }
  isAvailable(): boolean {
    return this.core.isAvailable?.() ?? true;
  }
  historyPage(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<PresentationHistoryPage | undefined> {
    return Promise.resolve(this.core.historyPage?.(page, turn, rows)).then((
      value,
    ) => value === undefined ? undefined : history(value));
  }
  currentPosition(): PresentationPosition | undefined {
    const value = this.core.currentPosition?.();
    return value === undefined ? undefined : position(value);
  }
  contextCompactionPreview(): PresentationContextPreview | undefined {
    const value = this.core.contextCompactionPreview?.();
    return value === undefined ? undefined : preview(value);
  }
  compactContext(signal?: AbortSignal): Promise<PresentationContextResult> {
    if (this.core.compactContext === undefined) {
      return Promise.resolve({ kind: 'refused', reason: 'unavailable' });
    }
    return this.core.compactContext(signal).then(contextResult);
  }
  checkpointSnapshot() {
    const value = this.core.checkpointSnapshot?.();
    return value === undefined ? undefined : Object.freeze({
      summary: text(value.summary),
      coveredThroughTurn: count(value.coveredThroughTurn),
      retainedFromTurn: count(value.retainedFromTurn),
    });
  }

  modelSelectionSnapshot(): ModelSelection | undefined {
    return this.core.modelSelectionSnapshot?.();
  }

  credentialAvailabilitySnapshot() {
    return this.core.credentialAvailabilitySnapshot?.();
  }

  selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'> {
    return this.core.selectModel?.(selection) ?? Promise.resolve('unavailable');
  }

  /** Own every in-flight navigation signal; the UI can only request cancellation by intent. */
  private navigationOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abort = new AbortController();
    this.navigationAborts.add(abort);
    return operation(abort.signal).finally(() => {
      this.navigationAborts.delete(abort);
    });
  }

  private cancelNavigationOperations(): void {
    for (const abort of this.navigationAborts) {
      abort.abort('navigation dismissed');
    }
  }

  private dispatchModelSelection(
    selection: ModelSelection,
  ): PresentationIntentResult | Promise<PresentationIntentResult> {
    if (this.core.selectModel === undefined) {
      return { kind: 'rejected', reason: 'unavailable' };
    }
    return this.core.selectModel(selection).then((status) => {
      if (status !== 'selected' && status !== 'unchanged') {
        return {
          kind: 'rejected' as const,
          reason: status === 'busy' ? 'busy' as const : 'unavailable' as const,
        };
      }
      const projected = {
        provider: selection.provider,
        modelId: selection.modelId,
        effort: selection.effort,
      };
      this.emit({ kind: 'model_selection_changed', selection: projected });
      return {
        kind: 'model_selection' as const,
        status,
        selection: projected,
      };
    });
  }

  /**
   * Single typed command authority for the human UI.  Validation happens before any core call;
   * session/navigation handles and abort owners remain private to this adapter.
   */
  dispatch(
    intent: PresentationIntent,
  ): PresentationIntentResult | Promise<PresentationIntentResult> {
    const admitted = presentationIntent(intent);
    switch (admitted.kind) {
      case 'ordinary_submit':
        return this.core.submit(admitted.text).then((value) => {
          const notice = this.core.consumeAutoCompactionNotice?.();
          if (notice !== undefined && notice !== null) {
            this.emit({
              kind: 'notice',
              generation: ++this.generation,
              text: bounded(
                `context auto-compacted through turn ${notice.coveredThroughTurn}; retained from turn ${notice.retainedFromTurn}; sending your message`,
              ),
            });
          }
          return {
            kind: 'outcome',
            outcome: outcome(value),
          };
        });
      case 'steering_submit': {
        const result = this.core.steerActiveTurn?.(admitted.text) ?? 'idle';
        return result === 'accepted'
          ? { kind: 'accepted' }
          : { kind: 'rejected', reason: result === 'idle' ? 'idle' : 'busy' };
      }
      case 'follow_up_queue':
        return { kind: 'accepted' };
      case 'cancel_active':
        this.cancelNavigationOperations();
        return (this.core.cancelActiveTurn?.() ?? 'idle') === 'idle'
          ? { kind: 'rejected', reason: 'idle' }
          : { kind: 'accepted' };
      case 'exit':
        this.cancelNavigationOperations();
        return { kind: 'exit', code: admitted.code };
      case 'list_sessions':
        return this.coreNavigation === undefined
          ? { kind: 'listing', listing: { sessions: [], skippedInvalid: 0 } }
          : this.navigationOperation((signal) => this.coreNavigation!.list(signal)).then(
            (value) => ({
              kind: 'listing',
              listing: listing(value),
            }),
          );
      case 'rename_session': {
        const status = this.coreNavigation?.renameCurrent(admitted.title) ?? 'unavailable';
        const title = status === 'renamed' || status === 'unchanged'
          ? this.coreNavigation?.currentPosition().title ?? admitted.title
          : admitted.title;
        return status === 'renamed' || status === 'unchanged'
          ? { kind: 'session_title', status, title }
          : {
            kind: 'rejected',
            reason: status === 'busy' ? 'busy' : 'unavailable',
          };
      }
      case 'new_session':
        return this.dispatchNewSession();
      case 'resume_session':
        return this.dispatchResume(admitted.id);
      case 'recall_execution':
        if (
          this.coreNavigation?.persistent !== true || this.core.prepareRecall === undefined
        ) return { kind: 'rejected', reason: 'unavailable' };
        return this.core.prepareRecall(admitted.id).then((selected) => ({
          kind: 'recall' as const,
          sourceExecutionId: selected.sourceExecutionId,
          evidence: selected.evidence,
        }), (error: unknown) => ({
          kind: 'rejected' as const,
          reason: recallRejectionReason(error),
        }));
      case 'clear_recall':
        this.core.clearPendingRecall?.();
        return { kind: 'accepted' };
      case 'select_provider': {
        const current = this.core.modelSelectionSnapshot?.();
        const selection = current?.provider === admitted.provider
          ? current
          : defaultModelSelectionFor(admitted.provider as ProviderId);
        return this.dispatchModelSelection(selection);
      }
      case 'select_model': {
        const current = this.core.modelSelectionSnapshot?.();
        if (current !== undefined && current.provider !== admitted.provider) {
          return { kind: 'rejected', reason: 'invalid' };
        }
        let selection: ModelSelection;
        try {
          selection = selectModelFor(
            admitted.provider as ProviderId,
            admitted.modelId,
            admitted.effort as ReasoningEffort,
          );
        } catch {
          return { kind: 'rejected', reason: 'invalid' };
        }
        return this.dispatchModelSelection(selection);
      }
      case 'history_export': {
        const core = this.core;
        const positionValue = core.currentPosition?.();
        const transcript = core.transcriptSnapshot?.();
        const exporter = this.options.historyExporter;
        const mode = this.options.historySessionMode;
        if (
          positionValue === undefined || transcript === undefined || exporter === undefined ||
          mode === undefined
        ) return { kind: 'rejected', reason: 'unavailable' };
        const session: HistoryExportSessionIdentity = mode === 'none'
          ? Object.freeze({ kind: 'none' as const })
          : positionValue.sessionId === undefined
          ? (() => {
            throw new PresentationDeliveryError();
          })()
          : Object.freeze({ kind: 'durable' as const, sessionId: positionValue.sessionId });
        // Capture every mutable binding value before the writer's first asynchronous boundary.
        const operation = exporter.write({
          transcript,
          position: {
            agent: positionValue.agent,
            committedTurn: positionValue.committedTurn,
            createdAt: positionValue.createdAt,
            ...(positionValue.title === undefined ? {} : { title: positionValue.title }),
          },
          session,
          ...(this.options.startupState === undefined ? {} : {
            runtime: {
              instructionSource: this.options.startupState.instructions.source,
              skillNames: [...this.options.startupState.skills.names],
              omittedSkills: this.options.startupState.skills.omitted,
              hardSandbox: this.options.startupState.trust.hardSandbox,
            },
          }),
        });
        return operation.then((receipt) => ({
          kind: 'history_export' as const,
          path: bounded(receipt.path),
          throughTurn: receipt.throughTurn,
        }));
      }
      case 'human_history_open':
      case 'human_history_page': {
        const positionValue = this.core.currentPosition?.();
        const reader = this.options.humanHistoryReader;
        if (
          positionValue?.sessionId === undefined || reader === undefined ||
          this.options.historySessionMode !== 'durable'
        ) {
          return { kind: 'rejected', reason: 'unavailable' };
        }
        const pageValue = reader.readHumanHistoryPage({
          sessionId: positionValue.sessionId,
          direction: admitted.kind === 'human_history_open' ? 'latest' : admitted.direction,
          ...(admitted.kind === 'human_history_page' && admitted.cursor !== undefined
            ? { cursor: admitted.cursor }
            : {}),
        });
        return { kind: 'human_history_page', page: humanHistoryPage(pageValue) };
      }
      case 'human_history_detail': {
        const positionValue = this.core.currentPosition?.();
        const reader = this.options.humanHistoryReader;
        if (
          positionValue?.sessionId === undefined || reader === undefined ||
          this.options.historySessionMode !== 'durable'
        ) {
          return { kind: 'rejected', reason: 'unavailable' };
        }
        const value = reader.readHumanHistoryDetail(
          positionValue.sessionId,
          admitted.detailId,
          admitted.scalarOffset,
        );
        return { kind: 'human_history_detail', detail: humanHistoryDetail(value) };
      }
      case 'human_history_search': {
        const positionValue = this.core.currentPosition?.();
        const reader = this.options.humanHistoryReader;
        if (
          positionValue?.sessionId === undefined || reader === undefined ||
          this.options.historySessionMode !== 'durable'
        ) {
          return { kind: 'rejected', reason: 'unavailable' };
        }
        const value = reader.searchHumanHistory({
          sessionId: positionValue.sessionId,
          query: admitted.query,
          direction: admitted.direction,
          ...(admitted.fromEntryId === undefined ? {} : { fromEntryId: admitted.fromEntryId }),
          ...(admitted.fromSourceScalarOffset === undefined
            ? {}
            : { fromSourceScalarOffset: admitted.fromSourceScalarOffset }),
        });
        return {
          kind: 'human_history_search',
          ...(value === undefined ? {} : { hit: humanHistorySearchHit(value) }),
        };
      }
      case 'history_export_all': {
        const positionValue = this.core.currentPosition?.();
        const exporter = this.options.humanHistoryExporter;
        if (
          positionValue?.sessionId === undefined || exporter === undefined ||
          this.options.historySessionMode !== 'durable'
        ) {
          return { kind: 'rejected', reason: 'unavailable' };
        }
        return exporter.write(positionValue.sessionId).then((receipt) => ({
          kind: 'history_export_all' as const,
          path: bounded(receipt.path),
          sessionId: bounded(receipt.sessionId),
          stateRevision: receipt.stateRevision,
          ...(receipt.tailExecutionId === undefined
            ? {}
            : { tailExecutionId: bounded(receipt.tailExecutionId) }),
          executionCount: receipt.executionCount,
          byteLength: receipt.byteLength,
          sha256: bounded(receipt.sha256),
        }));
      }
      case 'history_page':
        return this.dispatchHistory(admitted.page, admitted.turn);
      case 'compaction': {
        if (admitted.action === 'cancel') {
          this.compactionAbort?.abort('context compaction cancelled');
          return { kind: 'accepted' };
        }
        if (admitted.action === 'preview') {
          const value = this.core.contextCompactionPreview?.();
          const previewValue = value === undefined ? undefined : preview(value);
          if (previewValue !== undefined) {
            this.emit({ kind: 'context_preview', preview: previewValue });
          }
          return { kind: 'context_preview', preview: previewValue };
        }
        if (this.core.compactContext === undefined) {
          return Promise.resolve({
            kind: 'context_result' as const,
            result: { kind: 'refused' as const, reason: 'unavailable' },
          });
        }
        const abort = new AbortController();
        this.compactionAbort = abort;
        return this.core.compactContext(abort.signal).then((value) => {
          const resultValue = contextResult(value);
          this.emit({ kind: 'context_result', result: resultValue });
          return { kind: 'context_result' as const, result: resultValue };
        }).finally(() => {
          if (this.compactionAbort === abort) this.compactionAbort = null;
        });
      }
      case 'dismiss_overlay':
        this.cancelNavigationOperations();
        return { kind: 'accepted' };
    }
  }

  private async dispatchHistory(
    page: number,
    turn: number,
  ): Promise<PresentationIntentResult> {
    const value = this.coreNavigation === undefined
      ? await this.core.historyPage?.(page, turn, 16)
      : await this.coreNavigation.historyPage(page, turn, 16);
    const pageValue = value === undefined ? undefined : history(value);
    return { kind: 'history', page: pageValue };
  }

  private dispatchResume(id: string): Promise<PresentationIntentResult> {
    if (this.coreNavigation === undefined) {
      throw new PresentationDeliveryError();
    }
    return this.navigationOperation(async (signal) => {
      const binding = await this.coreNavigation!.switchTo(id, signal);
      // SessionNavigationHost has already crossed the irreversible old-close boundary. Adopt the
      // target before delivery so stale modal dismissal cannot resurrect the closed binding.
      this.core = binding.session as CoreSession;
      const positionValue = position(binding.position);
      const selected = this.core.modelSelectionSnapshot?.();
      this.emit({
        kind: 'session_binding_replaced',
        position: positionValue,
        ...(selected === undefined ? {} : {
          modelSelection: {
            provider: selected.provider,
            modelId: selected.modelId,
            effort: selected.effort,
          },
        }),
      });
      let restoredValue: {
        readonly messages: readonly PresentationMessage[];
        readonly omitted: number;
      } | undefined;
      if (binding.restored !== undefined) {
        restoredValue = {
          messages: restoredPresentationMessages(binding.restored.messages),
          omitted: binding.restored.omitted,
        };
        this.emit({ kind: 'restored_log', ...restoredValue });
      }
      return {
        kind: 'binding' as const,
        position: positionValue,
        ...(restoredValue === undefined ? {} : { restored: restoredValue }),
      };
    });
  }

  private dispatchNewSession(): PresentationIntentResult | Promise<PresentationIntentResult> {
    if (this.coreNavigation?.createNew === undefined) {
      return { kind: 'rejected', reason: 'unavailable' };
    }
    return this.navigationOperation(async (signal) => {
      const binding = await this.coreNavigation!.createNew!(signal);
      this.core = binding.session as CoreSession;
      const positionValue = position(binding.position);
      const selected = this.core.modelSelectionSnapshot?.();
      this.emit({
        kind: 'session_binding_replaced',
        position: positionValue,
        ...(selected === undefined ? {} : {
          modelSelection: {
            provider: selected.provider,
            modelId: selected.modelId,
            effort: selected.effort,
          },
        }),
      });
      const restoredValue = {
        messages: restoredPresentationMessages(binding.restored?.messages ?? []),
        omitted: binding.restored?.omitted ?? 0,
      };
      this.emit({ kind: 'restored_log', ...restoredValue });
      return {
        kind: 'binding' as const,
        position: positionValue,
        restored: restoredValue,
      };
    });
  }

  navigationPort(): AdapterNavigationPort | undefined {
    const navigation = this.coreNavigation;
    if (navigation === undefined) return undefined;
    return {
      persistent: navigation.persistent,
      list: async (signal) => listing(await navigation.list(signal)),
      renameCurrent: (title) => navigation.renameCurrent(title),
      ...(navigation.createNew === undefined ? {} : {
        createNew: async (signal?: AbortSignal) => {
          const binding = await navigation.createNew!(signal);
          return Object.freeze({
            session: new TuiPresentationAdapter(binding.session as CoreSession, this.sink),
            position: position(binding.position),
            restored: Object.freeze({
              messages: Object.freeze([]),
              omitted: 0,
            }),
          });
        },
      }),
      switchTo: async (id, signal) => {
        const binding: NavigationBinding = await navigation.switchTo(
          id,
          signal,
        );
        const restoredCallIds = new Map<string, string>();
        let restoredOrdinal = 0;
        const restoredCallId = (raw: string): string => {
          const existing = restoredCallIds.get(raw);
          if (existing !== undefined) return existing;
          const next = `call-${++restoredOrdinal}`;
          restoredCallIds.set(raw, next);
          return next;
        };
        return Object.freeze({
          session: new TuiPresentationAdapter(
            binding.session as CoreSession,
            this.sink,
          ),
          position: position(binding.position),
          ...(binding.restored === undefined ? {} : {
            restored: Object.freeze({
              messages: Object.freeze(
                binding.restored.messages.map((message) => {
                  if (message.role === 'user') return userMessage(message);
                  if (message.role === 'assistant') {
                    return assistantMessage(
                      message,
                      restoredCallIds,
                      () => `call-${++restoredOrdinal}`,
                    );
                  }
                  return Object.freeze({
                    role: 'tool' as const,
                    content: Object.freeze(
                      message.content.map((item) => result(item, restoredCallId(item.callId))),
                    ),
                  });
                }),
              ),
              omitted: binding.restored.omitted,
            }),
          }),
        });
      },
      historyPage: async (page, turn, rows) => {
        const value = await navigation.historyPage(page, turn, rows);
        return value === undefined ? undefined : history(value);
      },
      currentPosition: () => position(navigation.currentPosition()),
    };
  }
}

export const createTuiPresentationAdapter = (
  session: CoreSession,
  sink?: PresentationEventSink,
  navigation?: SessionNavigationHost,
  options: TuiPresentationAdapterOptions = {},
): TuiPresentationAdapter => new TuiPresentationAdapter(session, sink, navigation, options);
