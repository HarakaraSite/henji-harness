import { type LoopOutcome, type Message, type Model, type ModelRequest } from './contracts.ts';
import { type AgentEventSink } from './events.ts';
import { type AgentTurnOptions, runAgentTurn } from './loop.ts';
import { Registry } from './tools.ts';
import { snapshotMessages } from './events.ts';
import { type ContextMetrics, prepareModelContext } from './context.ts';
import { type ParentTurnExecutionContext } from './execution_context.ts';
import { type CancelRequestResult, TurnCancellationOwner } from './cancellation.ts';

export const AGENT_SESSION_UNAVAILABLE = 'agent session unavailable';

export interface AgentSessionOptions {
  readonly maxSteps?: number;
  readonly systemInstruction?: string;
  readonly eventSink?: AgentEventSink;
  /** Runtime-owned factory that gives every accepted turn a fresh request context. */
  readonly createTurnExecutionContext?: (
    turn: number,
    signal?: AbortSignal,
    cancellation?: TurnCancellationOwner,
  ) => ParentTurnExecutionContext;
}

/**
 * A private, in-memory conversation. Submissions are deliberately sequential and nonqueueing:
 * callers must wait for the active turn to finish before submitting another one.
 */
export class AgentSession {
  private readonly model: Model;
  private readonly registry: Registry;
  private readonly options: AgentTurnOptions;
  private readonly createTurnContext?: (
    turn: number,
    signal?: AbortSignal,
    cancellation?: TurnCancellationOwner,
  ) => ParentTurnExecutionContext;
  private committedTranscript: Message[] = [];
  private active = false;
  private activeCancellation: TurnCancellationOwner | null = null;
  private unavailable = false;
  private nextTurn = 1;
  private committedContextSnapshot: ContextMetrics | undefined;

  constructor(model: Model, registry: Registry, options: AgentSessionOptions = {}) {
    const maxSteps = options.maxSteps ?? 8;
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      throw new RangeError('maxSteps must be a positive integer');
    }
    this.model = model;
    this.registry = registry;
    this.options = {
      maxSteps,
      systemInstruction: options.systemInstruction,
      eventSink: options.eventSink,
    };
    this.createTurnContext = options.createTurnExecutionContext;
  }

  /** Return a defensive snapshot of all messages from successfully committed turns. */
  transcriptSnapshot(): readonly Message[] {
    return snapshotMessages(this.committedTranscript);
  }

  /** Return metrics for the current committed transcript, never an uncommitted turn draft. */
  contextSnapshot(): ContextMetrics | undefined {
    return this.committedContextSnapshot === undefined
      ? undefined
      : { ...this.committedContextSnapshot };
  }

  /** Request cancellation for the currently settling turn, without allocating another turn. */
  cancelActiveTurn(): CancelRequestResult {
    const cancellation = this.activeCancellation;
    if (!this.active || cancellation === null || cancellation.state === 'settled') return 'idle';
    return cancellation.request();
  }

  /** Submit one nonblank turn; an active turn is rejected rather than queued. */
  async submit(userText: string): Promise<LoopOutcome> {
    if (this.unavailable) throw new Error(AGENT_SESSION_UNAVAILABLE);
    if (typeof userText !== 'string' || userText.trim().length === 0) {
      throw new RangeError('user text must not be blank');
    }
    if (this.active) throw new Error('agent session is busy');

    this.active = true;
    const turn = this.nextTurn++;
    const cancellation = new TurnCancellationOwner();
    this.activeCancellation = cancellation;
    const previousTranscript = snapshotMessages(this.committedTranscript);
    const previousContext = this.committedContextSnapshot === undefined
      ? undefined
      : { ...this.committedContextSnapshot };
    try {
      const executionContext = this.createTurnContext?.(turn, cancellation.signal, cancellation) ??
        undefined;
      const outcome = await runAgentTurn(
        userText,
        snapshotMessages(this.committedTranscript),
        this.model,
        this.registry,
        {
          ...this.options,
          turn,
          executionContext,
          cancellation,
          signal: cancellation.signal,
          commit: (transcript) => {
            const committedTranscript = snapshotMessages(transcript);
            const request: ModelRequest = this.options.systemInstruction === undefined
              ? {
                transcript: committedTranscript,
                tools: this.registry.definitions(),
              }
              : {
                systemInstruction: this.options.systemInstruction,
                transcript: committedTranscript,
                tools: this.registry.definitions(),
              };
            const metrics = prepareModelContext(request).metrics;
            this.committedTranscript = committedTranscript;
            this.committedContextSnapshot = metrics;
          },
        },
      );
      return outcome;
    } catch (error) {
      // This also undoes a successful draft committed just before a failing turn_end sink.
      this.committedTranscript = previousTranscript;
      this.committedContextSnapshot = previousContext;
      throw error;
    } finally {
      if (cancellation.state === 'cleanup_failed') this.unavailable = true;
      this.activeCancellation = null;
      this.active = false;
    }
  }
}
