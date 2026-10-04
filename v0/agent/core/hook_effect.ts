import type { LoopOutcome } from './contracts.ts';

/** Source identity for one hook contribution that changed a tool call or result. */
export interface HookEffectSource {
  readonly name: string;
  readonly path?: string;
}

/** A hook phase failure kept beside the tool result it affected. */
export interface HookEffectFailure extends HookEffectSource {
  readonly phase: 'before_tool' | 'after_tool';
  readonly reason: string;
}

/** Semantic sidecar for the original and effective values of one tool occurrence. */
export interface ToolHookEffect {
  readonly originalArguments?: import('./contracts.ts').JsonValue;
  readonly effectiveArguments?: import('./contracts.ts').JsonValue;
  readonly argumentHooks?: readonly HookEffectSource[];
  readonly originalText?: string;
  readonly textHooks?: readonly HookEffectSource[];
  readonly failure?: HookEffectFailure;
}

/** Compact Data settlement facts supplied to an after_turn handler. */
export interface AfterTurnSettlement {
  readonly accepted: boolean;
  readonly adopted: boolean;
  readonly durable: boolean;
  readonly stateRevision: number;
  /** Data owner's terminal status, kept separate from the Worker's proposed draft. */
  readonly terminalOutcome: Pick<
    LoopOutcome,
    'ok' | 'outcome' | 'stopReason' | 'error'
  >;
}

export interface AfterTurnHookContribution extends HookEffectSource {
  readonly checkpoint?: {
    readonly summary: string;
    readonly coveredThroughTurn: number;
  };
  readonly failure?: { readonly reason: string };
}

/** Semantic record of ordered after_turn contributions and the accepted effective checkpoint. */
export interface AfterTurnHookEffect {
  readonly settlement: AfterTurnSettlement;
  readonly contributions: readonly AfterTurnHookContribution[];
  readonly checkpoint?: {
    readonly contextSchemaVersion: 1;
    readonly sessionId: string;
    readonly createdAt: string;
    readonly sourceProfileId: string;
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
    readonly summary: string;
  };
}

/** One runtime_stop handler outcome retained beside the execution it followed. */
export interface HookLifecycleContribution extends HookEffectSource {
  readonly outcome: 'completed' | 'failed';
  readonly reason?: string;
}

/** Semantic result of the ordered runtime_stop phase. */
export interface RuntimeStopHookEffect {
  readonly phase: 'runtime_stop';
  readonly settlement?: AfterTurnSettlement;
  readonly contributions: readonly HookLifecycleContribution[];
}

/** Runtime stop result returned in a close reply and persisted when a turn exists. */
export interface RuntimeStopHookResult {
  readonly effect: RuntimeStopHookEffect;
  readonly providerObservations:
    readonly import('../provider/provider_evidence.ts').ProviderEvidenceObservation[];
}
