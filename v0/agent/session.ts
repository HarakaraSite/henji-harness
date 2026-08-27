import { type LoopOutcome, type Message, type Model } from './contracts.ts';
import { type AgentEventSink } from './events.ts';
import { type AgentTurnOptions, runAgentTurn } from './loop.ts';
import { Registry } from './tools.ts';
import { snapshotMessages } from './events.ts';
import { type ParentTurnExecutionContext } from './execution_context.ts';

export interface AgentSessionOptions {
  readonly maxSteps?: number;
  readonly systemInstruction?: string;
  readonly eventSink?: AgentEventSink;
  /** Runtime-owned factory that gives every accepted turn a fresh request context. */
  readonly createTurnExecutionContext?: (turn: number) => ParentTurnExecutionContext;
}

/**
 * A private, in-memory conversation. Submissions are deliberately sequential and nonqueueing:
 * callers must wait for the active turn to finish before submitting another one.
 */
export class AgentSession {
  private readonly model: Model;
  private readonly registry: Registry;
  private readonly options: AgentTurnOptions;
  private readonly createTurnContext?: (turn: number) => ParentTurnExecutionContext;
  private committedTranscript: Message[] = [];
  private active = false;
  private nextTurn = 1;

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

  /** Submit one nonblank turn; an active turn is rejected rather than queued. */
  async submit(userText: string): Promise<LoopOutcome> {
    if (typeof userText !== 'string' || userText.trim().length === 0) {
      throw new RangeError('user text must not be blank');
    }
    if (this.active) throw new Error('agent session is busy');

    this.active = true;
    const turn = this.nextTurn++;
    const executionContext = this.createTurnContext?.(turn);
    const previousTranscript = snapshotMessages(this.committedTranscript);
    try {
      const outcome = await runAgentTurn(
        userText,
        snapshotMessages(this.committedTranscript),
        this.model,
        this.registry,
        {
          ...this.options,
          turn,
          executionContext,
          commit: (transcript) => {
            this.committedTranscript = snapshotMessages(transcript);
          },
        },
      );
      return outcome;
    } catch (error) {
      // This also undoes a successful draft committed just before a failing turn_end sink.
      this.committedTranscript = previousTranscript;
      throw error;
    } finally {
      this.active = false;
    }
  }
}
