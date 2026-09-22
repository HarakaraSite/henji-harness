import type { AgentEvent } from '../core/events.ts';
import type { AssistantMessage } from '../core/contracts.ts';

export const CLI_RUN_EVENT_VERSION = 1 as const;

/**
 * Host-owned, credential-free projection of one headless turn. Internal `AgentEvent` values and
 * provider-private replay state are intentionally not exposed on the CLI wire.
 */
export type CliRunEvent =
  | { readonly kind: 'turn_start'; readonly turn: number }
  | { readonly kind: 'user_message'; readonly turn: number; readonly text: string }
  | {
    readonly kind: 'assistant_delta';
    readonly turn: number;
    readonly text: string;
    readonly reset?: true;
  }
  | { readonly kind: 'assistant_message'; readonly turn: number; readonly text: string }
  | {
    readonly kind: 'tool_call';
    readonly turn: number;
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
  }
  | {
    readonly kind: 'tool_result';
    readonly turn: number;
    readonly callId: string;
    readonly name: string;
    readonly outcome: string;
    readonly text: string;
  }
  | { readonly kind: 'steering_message'; readonly turn: number; readonly text: string };

export interface CliRunResult {
  readonly kind: 'result';
  readonly ok: boolean;
  readonly stopReason: string;
  readonly committed: boolean;
  readonly steps: number;
  readonly toolCallCount: number;
  readonly toolResultCount: number;
  readonly requestCount: number;
  readonly finalText?: string;
  readonly terminalKind?: string;
  readonly error?: string;
  readonly diagnostic?: unknown;
}

export interface CliRunError {
  readonly kind: 'error';
  readonly error: unknown;
}

export type CliRunRecord = CliRunEvent | CliRunResult | CliRunError;

export const serializeCliRunRecord = (record: CliRunRecord): string =>
  `${JSON.stringify({ v: CLI_RUN_EVENT_VERSION, ...record })}\n`;

const visibleAssistantText = (message: AssistantMessage): string =>
  'kind' in message.content && message.content.kind === 'text'
    ? message.content.text
    : (message.text ?? '');

/**
 * Map internal events to the CLI projection and derive `assistant_delta` from the per-request
 * visible-prefix snapshots. A snapshot that is not an extension of the previous one marks a new
 * model step with `reset: true` so consumers can concatenate deltas deterministically.
 */
export class CliRunEventProjector {
  private lastProgress = '';
  private committed = false;

  project(event: AgentEvent): readonly CliRunEvent[] {
    switch (event.kind) {
      case 'turn_start':
        this.lastProgress = '';
        return [{ kind: 'turn_start', turn: event.turn }];
      case 'user_message':
        return [{ kind: 'user_message', turn: event.turn, text: event.message.content.text }];
      case 'assistant_progress': {
        if (event.text.startsWith(this.lastProgress)) {
          const delta = event.text.slice(this.lastProgress.length);
          this.lastProgress = event.text;
          return delta.length === 0
            ? []
            : [{ kind: 'assistant_delta', turn: event.turn, text: delta }];
        }
        this.lastProgress = event.text;
        return [{ kind: 'assistant_delta', turn: event.turn, text: event.text, reset: true }];
      }
      case 'assistant_message': {
        this.lastProgress = '';
        const text = visibleAssistantText(event.message);
        return text.length === 0 ? [] : [{ kind: 'assistant_message', turn: event.turn, text }];
      }
      case 'tool_call':
        this.lastProgress = '';
        return [{
          kind: 'tool_call',
          turn: event.turn,
          callId: event.call.callId,
          name: event.call.name,
          arguments: event.call.arguments,
        }];
      case 'tool_result':
        this.lastProgress = '';
        return [{
          kind: 'tool_result',
          turn: event.turn,
          callId: event.result.callId,
          name: event.result.name,
          outcome: event.result.outcome,
          text: event.result.text,
        }];
      case 'tool_progress':
        return [];
      case 'steering_message':
        return [{ kind: 'steering_message', turn: event.turn, text: event.message.content.text }];
      case 'turn_end':
        this.committed = event.committed;
        return [];
      default:
        return [];
    }
  }

  get wasCommitted(): boolean {
    return this.committed;
  }
}

const argumentPreview = (value: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = '';
  }
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

/** Human-readable `--stream` rendering. Assistant text goes to stdout; tool activity to stderr. */
export const renderStreamEvent = (
  event: CliRunEvent,
): { readonly stdout?: string; readonly stderr?: string } => {
  switch (event.kind) {
    case 'assistant_delta':
      return { stdout: event.reset === true ? `\n${event.text}` : event.text };
    case 'tool_call':
      return { stderr: `tool> ${event.name} ${argumentPreview(event.arguments)}\n` };
    case 'tool_result':
      return { stderr: `tool< ${event.name} ${event.outcome}\n` };
    default:
      return {};
  }
};

type OutputWriter = (text: string) => void | PromiseLike<void>;

/**
 * Ordered, non-blocking text writer. The synchronous event sink only enqueues; a single async
 * pump performs the writes, and `drain` waits for every queued line before the process exits.
 */
export class OrderedTextWriter {
  private readonly queue: string[] = [];
  private current: Promise<void> | undefined;
  private failed = false;

  constructor(private readonly write: OutputWriter) {}

  enqueue(text: string): void {
    if (this.failed || text.length === 0) return;
    this.queue.push(text);
    if (this.current === undefined) this.current = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift()!;
        try {
          await this.write(text);
        } catch {
          this.failed = true;
          this.queue.length = 0;
        }
      }
    } finally {
      this.current = undefined;
    }
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.current !== undefined) {
      if (this.current === undefined) this.current = this.pump();
      await this.current;
    }
  }
}
