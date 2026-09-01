import { type AgentEvent } from './events.ts';
import { type LoopOutcome, type Message } from './contracts.ts';
import { type ContextMetrics } from './context.ts';
import {
  type ContextRecoveryPreview,
  type ContextRecoveryResult,
  type NavigationBinding,
  type NavigationListing,
  type NavigationPosition,
  type SessionNavigationHost,
} from './session_navigation.ts';
import { type SessionHistoryPage } from './session_history.ts';
import {
  boundedPresentationText,
  type PresentationAssistantMessage,
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
  type PresentationJson,
  type PresentationMessage,
  type PresentationNavigationListing,
  type PresentationOutcome,
  type PresentationOutcomeReason,
  type PresentationPosition,
  type PresentationProjection,
  type PresentationStartupState,
  type PresentationToolCall,
  type PresentationToolResult,
  type PresentationUserMessage,
  snapshotPresentation,
} from '../presentation/contract.ts';

export interface AdapterSessionPort {
  submit(text: string): Promise<PresentationOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): PresentationContextMetrics | undefined;
  isAvailable?(): boolean;
  historyPage?(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<PresentationHistoryPage | undefined> | PresentationHistoryPage | undefined;
  currentPosition?(): PresentationPosition | undefined;
  contextCompactionPreview?(): PresentationContextPreview | undefined;
  compactContext?(signal?: AbortSignal): Promise<PresentationContextResult>;
  checkpointSnapshot?(): {
    readonly summary: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
}

export interface AdapterNavigationPort {
  readonly persistent: boolean;
  list(signal?: AbortSignal): Promise<PresentationNavigationListing>;
  switchTo(id: string, signal?: AbortSignal): Promise<{
    readonly session: AdapterSessionPort;
    readonly position: PresentationPosition;
    readonly restored?: {
      readonly messages: readonly PresentationMessage[];
      readonly omitted: number;
    };
  }>;
  historyPage(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<PresentationHistoryPage | undefined>;
  currentPosition(): PresentationPosition;
}

type CoreSession = {
  submit(text: string): Promise<LoopOutcome>;
  cancelActiveTurn?(): 'requested' | 'already_requested' | 'idle';
  steerActiveTurn?(text: string): 'accepted' | 'idle' | 'already_accepted';
  contextSnapshot?(): ContextMetrics | undefined;
  isAvailable?(): boolean;
  historyPage?(
    page: number,
    turn?: number,
    rows?: number,
  ): Promise<SessionHistoryPage | undefined> | SessionHistoryPage | undefined;
  currentPosition?(): NavigationPosition;
  contextCompactionPreview?(): ContextRecoveryPreview;
  compactContext?(signal?: AbortSignal): Promise<ContextRecoveryResult>;
  checkpointSnapshot?(): {
    readonly summary: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;
};

const MAX_GENERATION_TEXT = 64 * 1024;
const encoder = new TextEncoder();

const bounded = (value: string): string => {
  const text = boundedPresentationText(value);
  if (encoder.encode(text).byteLength > MAX_GENERATION_TEXT) throw new PresentationDeliveryError();
  return text;
};

const json = (value: unknown, depth = 0, seen = new WeakSet<object>()): PresentationJson => {
  if (value === null) return null;
  if (depth > 8) throw new PresentationDeliveryError();
  switch (typeof value) {
    case 'string':
      return bounded(value);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'object': {
      if (seen.has(value)) throw new PresentationDeliveryError();
      seen.add(value);
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (
          value.length > 256 ||
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.values(descriptors).some((descriptor) =>
            descriptor.get !== undefined || descriptor.set !== undefined
          ) || Reflect.ownKeys(value).some((key) => {
            if (key === 'length') return false;
            if (typeof key !== 'string' || !/^\d+$/u.test(key)) return true;
            const index = Number(key);
            return !Number.isSafeInteger(index) || index < 0 || index >= value.length;
          }) || [...Array(Math.min(value.length, 256)).keys()].some((index) =>
            !Object.hasOwn(value, String(index))
          )
        ) {
          throw new PresentationDeliveryError();
        }
        const result = Object.freeze(
          value.slice(0, 256).map((item) =>
            json(item, depth + 1, seen)
          ),
        );
        seen.delete(value);
        return result;
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
      ) {
        throw new PresentationDeliveryError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (
        Reflect.ownKeys(descriptors).length > 256 ||
        Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string') ||
        Object.values(descriptors).some((descriptor) =>
          descriptor.get !== undefined || descriptor.set !== undefined
        )
      ) {
        throw new PresentationDeliveryError();
      }
      const result = Object.freeze(
        Object.fromEntries(
          Object.entries(value).slice(0, 256).map((
            [key, item],
          ) => [bounded(key), json(item, depth + 1, seen)]),
        ),
      ) as PresentationJson;
      seen.delete(value);
      return result;
    }
    default:
      throw new PresentationDeliveryError();
  }
};

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new PresentationDeliveryError();
  return bounded(value);
};
const count = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PresentationDeliveryError();
  return value as number;
};
const fixedCount = <T extends number>(value: unknown, expected: T): T => {
  if (value !== expected) throw new PresentationDeliveryError();
  return expected;
};
const outcomeReason = (value: unknown): PresentationOutcomeReason => {
  if (
    value !== 'final' && value !== 'tool_terminal' && value !== 'max_steps' &&
    value !== 'contract_failure' && value !== 'cancelled'
  ) throw new PresentationDeliveryError();
  return value;
};
const agentId = (value: unknown): 'default' | 'planner' => {
  if (value !== 'default' && value !== 'planner') throw new PresentationDeliveryError();
  return value;
};
const historyRole = (value: unknown): PresentationHistoryPage['entries'][number]['role'] => {
  if (
    value !== 'user' && value !== 'steer' && value !== 'assistant' && value !== 'tool>' &&
    value !== 'tool<'
  ) {
    throw new PresentationDeliveryError();
  }
  return value;
};
const contextResultKind = (value: unknown): PresentationContextResult['kind'] => {
  if (value !== 'installed' && value !== 'refused' && value !== 'failed' && value !== 'cancelled') {
    throw new PresentationDeliveryError();
  }
  return value;
};
const boolean = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new PresentationDeliveryError();
  return value;
};

const userMessage = (message: Message): PresentationUserMessage => {
  if (message.role !== 'user' || message.content.kind !== 'text') {
    throw new PresentationDeliveryError();
  }
  return Object.freeze({
    role: 'user',
    content: Object.freeze({ kind: 'text', text: text(message.content.text) }),
  });
};

const callMessage = (
  call: { readonly callId: string; readonly name: string; readonly arguments: unknown },
  callId: string,
): PresentationToolCall =>
  Object.freeze({
    kind: 'tool_call',
    callId,
    name: text(call.name),
    arguments: json(call.arguments),
  });

const assistantMessage = (
  message: Message,
  callIds: Map<string, string>,
  nextCallId: () => string,
): PresentationAssistantMessage => {
  if (message.role !== 'assistant') throw new PresentationDeliveryError();
  if (!Array.isArray(message.content) && 'text' in message.content) {
    return Object.freeze({
      role: 'assistant',
      content: Object.freeze({ kind: 'text', text: text(message.content.text) }),
    });
  }
  const calls = message.content.map((call) => {
    const id = callIds.get(call.callId) ?? nextCallId();
    callIds.set(call.callId, id);
    return callMessage(call, id);
  });
  return Object.freeze({ role: 'assistant', content: Object.freeze(calls) });
};

const result = (
  value: {
    readonly callId: string;
    readonly name: string;
    readonly text: string;
    readonly outcome: 'success' | 'error';
    readonly terminal?: 'json_result';
  },
  callId: string,
): PresentationToolResult =>
  (value.outcome !== 'success' && value.outcome !== 'error') ||
    (value.terminal !== undefined && value.terminal !== 'json_result')
    ? (() => {
      throw new PresentationDeliveryError();
    })()
    : Object.freeze({
      kind: 'tool_result',
      callId,
      name: text(value.name),
      text: text(value.text),
      outcome: value.outcome,
      ...(value.terminal === undefined ? {} : { terminal: 'json_result' as const }),
    });

const position = (value: NavigationPosition): PresentationPosition =>
  Object.freeze({
    ...(value.sessionId === undefined ? {} : { sessionId: text(value.sessionId) }),
    agent: agentId(value.agent),
    committedTurn: count(value.committedTurn),
    messageCount: count(value.messageCount),
    ...(value.checkpoint === undefined ? {} : {
      checkpoint: Object.freeze({
        coveredThroughTurn: count(value.checkpoint.coveredThroughTurn),
        retainedFromTurn: count(value.checkpoint.retainedFromTurn),
        ...(value.checkpoint.projectedMessagesBytes === undefined
          ? {}
          : { projectedMessagesBytes: count(value.checkpoint.projectedMessagesBytes) }),
      }),
    }),
  });

const listing = (value: NavigationListing): PresentationNavigationListing =>
  Object.freeze({
    sessions: Object.freeze(value.sessions.map((row) =>
      Object.freeze({
        id: text(row.id),
        agent: agentId(row.agent),
        createdAt: text(row.createdAt),
        updatedAt: text(row.updatedAt),
        turnCount: count(row.turnCount),
        messageCount: count(row.messageCount),
        current: boolean(row.current),
        resumed: boolean(row.resumed),
        mismatch: boolean(row.mismatch),
      })
    )),
    skippedInvalid: count(value.skippedInvalid),
  });

const history = (value: SessionHistoryPage): PresentationHistoryPage =>
  (value.entries.length > 16 || value.sourceBytes > 8 * 1024)
    ? (() => {
      throw new PresentationDeliveryError();
    })()
    : Object.freeze({
      ...(value.sessionId === undefined ? {} : { sessionId: text(value.sessionId) }),
      ...(value.agent === undefined ? {} : { agent: agentId(value.agent) }),
      turn: count(value.turn),
      totalTurns: count(value.totalTurns),
      page: count(value.page),
      pageCount: count(value.pageCount),
      sourceBytes: count(value.sourceBytes),
      omitted: boolean(value.omitted),
      entries: Object.freeze(value.entries.map((entry) =>
        Object.freeze({
          turn: count(entry.turn),
          role: historyRole(entry.role),
          messageIndex: count(entry.messageIndex),
          text: text(entry.text),
        })
      )),
    });

const preview = (value: ContextRecoveryPreview): PresentationContextPreview =>
  Object.freeze({
    useful: boolean(value.useful),
    currentTurn: count(value.currentTurn),
    ...(value.currentCheckpoint === undefined ? {} : {
      currentCheckpoint: Object.freeze({
        coveredThroughTurn: count(value.currentCheckpoint.coveredThroughTurn),
        retainedFromTurn: count(value.currentCheckpoint.retainedFromTurn),
      }),
    }),
    ...(value.proposed === undefined ? {} : {
      proposed: Object.freeze({
        coveredThroughTurn: count(value.proposed.coveredThroughTurn),
        retainedFromTurn: count(value.proposed.retainedFromTurn),
      }),
    }),
    ...(value.baselineMessagesBytes === undefined
      ? {}
      : { baselineMessagesBytes: count(value.baselineMessagesBytes) }),
    ...(value.projectedMessagesBytes === undefined
      ? {}
      : { projectedMessagesBytes: count(value.projectedMessagesBytes) }),
  });

const contextResult = (value: ContextRecoveryResult): PresentationContextResult =>
  Object.freeze({
    kind: contextResultKind(value.kind),
    ...(value.coveredThroughTurn === undefined
      ? {}
      : { coveredThroughTurn: count(value.coveredThroughTurn) }),
    ...(value.retainedFromTurn === undefined
      ? {}
      : { retainedFromTurn: count(value.retainedFromTurn) }),
    reason: value.reason === undefined ? undefined : text(value.reason),
  });

const outcome = (value: LoopOutcome): PresentationOutcome => {
  const callIds = new Map<string, string>();
  let ordinal = 0;
  const opaque = (raw: string): string => {
    const existing = callIds.get(raw);
    if (existing !== undefined) return existing;
    const next = `call-${++ordinal}`;
    callIds.set(raw, next);
    return next;
  };
  return Object.freeze({
    ok: boolean(value.ok),
    task: text(value.task),
    outcome: outcomeReason(value.outcome),
    stopReason: outcomeReason(value.stopReason),
    finalText: value.finalText === undefined ? undefined : text(value.finalText),
    ...(value.terminalKind === undefined ? {} : { terminalKind: 'json_result' as const }),
    error: value.error === undefined ? undefined : text(value.error),
    steps: count(value.steps),
    toolCallCount: count(value.toolCallCount),
    toolResultCount: count(value.toolResultCount),
    transcript: Object.freeze(value.transcript.map((message) => {
      if (message.role === 'user') return userMessage(message);
      if (message.role === 'assistant') {
        return assistantMessage(message, callIds, () => `call-${++ordinal}`);
      }
      return Object.freeze({
        role: 'tool' as const,
        content: Object.freeze(message.content.map((item) => result(item, opaque(item.callId)))),
      });
    })) as readonly PresentationMessage[],
  });
};

const restoredPresentationMessages = (
  messages: readonly Message[],
): readonly PresentationMessage[] => {
  const callIds = new Map<string, string>();
  let ordinal = 0;
  const opaque = (raw: string): string => {
    const existing = callIds.get(raw);
    if (existing !== undefined) return existing;
    const next = `call-${++ordinal}`;
    callIds.set(raw, next);
    return next;
  };
  return Object.freeze(messages.map((message) => {
    if (message.role === 'user') return userMessage(message);
    if (message.role === 'assistant') {
      return assistantMessage(message, callIds, () => `call-${++ordinal}`);
    }
    return Object.freeze({
      role: 'tool' as const,
      content: Object.freeze(message.content.map((item) => result(item, opaque(item.callId)))),
    });
  }));
};

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
    if (event === null || typeof event !== 'object' || typeof event.kind !== 'string') {
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
        this.emit({ kind: 'user_message', turn: event.turn, message: userMessage(event.message) });
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
        this.emit({ kind: 'assistant_progress', turn: event.turn, text: text(event.text) });
        return;
      case 'tool_call': {
        const callId = this.callIds.get(event.call.callId) ?? `call-${++this.callOrdinal}`;
        this.callIds.set(event.call.callId, callId);
        this.emit({ kind: 'tool_call', turn: event.turn, call: callMessage(event.call, callId) });
        return;
      }
      case 'tool_result': {
        const callId = this.callIds.get(event.result.callId) ?? `call-${++this.callOrdinal}`;
        this.callIds.set(event.result.callId, callId);
        this.emit({ kind: 'tool_result', turn: event.turn, result: result(event.result, callId) });
        return;
      }
      case 'tool_progress': {
        const callId = this.callIds.get(event.callId) ?? `call-${++this.callOrdinal}`;
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
        this.emit({
          kind: 'turn_end',
          turn: event.turn,
          outcome: event.outcome,
          committed: event.committed,
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
    return Promise.resolve(this.core.historyPage?.(page, turn, rows)).then((value) =>
      value === undefined ? undefined : history(value)
    );
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
    for (const abort of this.navigationAborts) abort.abort('navigation dismissed');
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
        return this.core.submit(admitted.text).then((value) => ({
          kind: 'outcome',
          outcome: outcome(value),
        }));
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
      case 'resume_session':
        return this.dispatchResume(admitted.id);
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

  private async dispatchHistory(page: number, turn: number): Promise<PresentationIntentResult> {
    const value = this.coreNavigation === undefined
      ? await this.core.historyPage?.(page, turn, 16)
      : await this.coreNavigation.historyPage(page, turn, 16);
    const pageValue = value === undefined ? undefined : history(value);
    if (pageValue !== undefined) this.emit({ kind: 'history_page', page: pageValue });
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
      this.emit({ kind: 'session_binding_replaced', position: positionValue });
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

  navigationPort(): AdapterNavigationPort | undefined {
    const navigation = this.coreNavigation;
    if (navigation === undefined) return undefined;
    return {
      persistent: navigation.persistent,
      list: async (signal) => listing(await navigation.list(signal)),
      switchTo: async (id, signal) => {
        const binding: NavigationBinding = await navigation.switchTo(id, signal);
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
          session: new TuiPresentationAdapter(binding.session as CoreSession, this.sink),
          position: position(binding.position),
          ...(binding.restored === undefined ? {} : {
            restored: Object.freeze({
              messages: Object.freeze(binding.restored.messages.map((message) => {
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
              })),
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
): TuiPresentationAdapter => new TuiPresentationAdapter(session, sink, navigation);

/** Build the neutral retained-screen projection from the runtime's already-resolved facts. */
export const presentationProjectionFromStartup = (
  startup: PresentationStartupState,
  position: PresentationPosition | undefined,
  capabilities: PresentationProjection['capabilities'] = {
    canNavigate: false,
    canHistory: false,
    canCompact: false,
  },
): PresentationProjection =>
  Object.freeze({
    lifecycle: 'starting',
    agentId: startup.agentId,
    sessionId: position?.sessionId,
    committedTurn: position?.committedTurn ?? 0,
    workspace: startup.workspace,
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    checkpoint: position?.checkpoint,
    pending: Object.freeze([]),
    capabilities: Object.freeze({ ...capabilities }),
    generation: 0,
  });
