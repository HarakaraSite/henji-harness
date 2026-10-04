import type { JsonValue, LoopOutcome, Message, ToolDefinition } from './core/contracts.ts';
import type { AfterTurnSettlement } from './core/hook_effect.ts';
import type { InstructionComponent } from './instructions/component.ts';
import type { ProviderRequestFn } from './provider/auxiliary_request.ts';
import type { AuthProfileId, CredentialAvailabilityStatus } from './provider/model_selection.ts';
import type { ProcessExecutor } from './runtime/process_contract.ts';
import type { Workspace, WorkToolSeams } from './tools/work_tool_contract.ts';

/** Contract implemented by modules listed in hooks.json. */
export const HOOK_API_CONTRACT = 'henji-hooks/v1' as const;

export type HookPhase =
  | 'runtime_start'
  | 'runtime_stop'
  | 'before_turn'
  | 'after_turn'
  | 'before_tool'
  | 'after_tool';

export const HOOK_PHASES: readonly HookPhase[] = Object.freeze([
  'runtime_start',
  'runtime_stop',
  'before_turn',
  'after_turn',
  'before_tool',
  'after_tool',
]);

export type HookHandler<I, O> = (input: I) => O | void | PromiseLike<O | void>;

export interface HookFactoryInput {
  readonly workspace: Workspace;
  readonly processExecutor?: ProcessExecutor;
  readonly workTools: WorkToolSeams;
  /** Credential-resolving request seam; credential values and Authorization are not exposed. */
  readonly requestProvider?: ProviderRequestFn;
  readonly credentialAvailability?: (
    authProfile: AuthProfileId,
    registrationId?: string | null,
  ) => Promise<CredentialAvailabilityStatus>;
}

export type HookRuntimeIdentity = {
  readonly component: 'agent';
  readonly agentName: string;
  readonly role: 'root';
  readonly workspaceRoot: string;
  readonly sessionId?: string;
  readonly workerGeneration: string;
} | {
  readonly component: 'agent';
  readonly agentName: string;
  readonly role: 'child';
  readonly workspaceRoot: string;
  readonly sessionId?: string;
  readonly workerGeneration: string;
  readonly parentExecutionId: string;
  readonly spawnCallId?: string;
};

export type HookTurnRuntime = HookRuntimeIdentity & {
  readonly executionId: string;
  readonly turnNumber: number;
  readonly signal?: AbortSignal;
};

export type HookToolRuntime = HookTurnRuntime & {
  readonly modelStep: number;
  readonly callId: string;
};

export interface HookTranscriptTurn {
  readonly turn: number;
  /** References to the canonical messages in this turn; hook inputs do not own live runtime state. */
  readonly messages: readonly Message[];
}

export interface HookCheckpointSnapshot {
  readonly summary: string;
  readonly coveredThroughTurn: number;
  readonly retainedFromTurn: number;
}

/** Turn-range view over canonical history, kept as message references rather than a second copy. */
export interface HookTranscriptSnapshot {
  readonly turns: readonly HookTranscriptTurn[];
}

/** The projected request context is described by its checkpoint and retained canonical turns. */
export interface HookProjectedContext {
  readonly checkpoint?: HookCheckpointSnapshot;
  readonly retainedTurns: readonly HookTranscriptTurn[];
}

export interface HookContextSnapshot {
  readonly systemInstruction: string;
  readonly instructionComponents: readonly InstructionComponent[];
  readonly tools: readonly ToolDefinition[];
  readonly transcript: HookTranscriptSnapshot;
  readonly checkpoint?: HookCheckpointSnapshot;
  readonly projectedContext: HookProjectedContext;
}

export interface RuntimeStartInput {
  readonly runtime: HookRuntimeIdentity;
  readonly context: HookContextSnapshot;
}

export interface RuntimeStopInput {
  readonly runtime: HookRuntimeIdentity;
  readonly reason: string;
  readonly context: HookContextSnapshot;
}

export interface BeforeTurnInput {
  readonly runtime: HookTurnRuntime;
  /** Current turn input, separate from the already settled canonical transcript. */
  readonly task: string;
  readonly context: HookContextSnapshot;
}

export interface AfterTurnInput {
  readonly runtime: HookTurnRuntime;
  readonly outcome: LoopOutcome;
  readonly settlement: AfterTurnSettlement;
  readonly context: HookContextSnapshot;
}

export interface BeforeToolInput {
  readonly runtime: HookToolRuntime;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly context: HookContextSnapshot;
}

export type HookToolResult =
  | { readonly outcome: 'success'; readonly text: string }
  | {
    readonly outcome: 'terminal';
    readonly text: string;
    readonly finalText: string;
    readonly terminalKind: 'json_result';
  }
  | { readonly outcome: 'error'; readonly text: string };

export interface AfterToolInput {
  readonly runtime: HookToolRuntime;
  readonly toolName: string;
  readonly arguments: JsonValue;
  readonly result: HookToolResult;
  readonly context: HookContextSnapshot;
}

export interface ContextAddition {
  readonly context: readonly string[];
}

export interface NextContextUpdate {
  readonly checkpoint: {
    readonly summary: string;
    readonly coveredThroughTurn: number;
  };
}

export interface ToolArgumentsUpdate {
  readonly arguments: JsonValue;
}

export interface ToolTextUpdate {
  readonly text: string;
}

export interface HookHandlers {
  runtime_start?: HookHandler<RuntimeStartInput, ContextAddition>;
  runtime_stop?: HookHandler<RuntimeStopInput, void>;
  before_turn?: HookHandler<BeforeTurnInput, ContextAddition>;
  after_turn?: HookHandler<AfterTurnInput, NextContextUpdate>;
  before_tool?: HookHandler<BeforeToolInput, ToolArgumentsUpdate>;
  after_tool?: HookHandler<AfterToolInput, ToolTextUpdate>;
}

export type HookFactory = (
  input: HookFactoryInput,
) => HookHandlers | PromiseLike<HookHandlers>;

export interface HookInputByPhase {
  runtime_start: RuntimeStartInput;
  runtime_stop: RuntimeStopInput;
  before_turn: BeforeTurnInput;
  after_turn: AfterTurnInput;
  before_tool: BeforeToolInput;
  after_tool: AfterToolInput;
}

export interface HookResultByPhase {
  runtime_start: ContextAddition;
  runtime_stop: void;
  before_turn: ContextAddition;
  after_turn: NextContextUpdate;
  before_tool: ToolArgumentsUpdate;
  after_tool: ToolTextUpdate;
}
