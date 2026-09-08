import type { ResolvedAgentDefinition } from '../definitions/agent_definition.ts';
import type { AgentResourceIdentity } from '../definitions/resource_identity.ts';
import type {
  AgentResolvedManifestIdentity,
  AgentResolvedManifestV1,
} from '../definitions/resolved_manifest.ts';
import type {
  AgentReplayEnvelopeIdentity,
  AgentReplayEnvelopeV1,
} from '../session/replay_envelope.ts';
import type { AgentExecutionRecordV1 } from './execution_record.ts';
import type { Message } from '../core/contracts.ts';

export const FRESH_RUNTIME_COMPARISON_SCHEMA_VERSION = 1 as const;
export const FRESH_RUNTIME_COMPARISON_CASE_ID = 'v1.default-max-steps-comparison' as const;
export const FRESH_RUNTIME_SCRIPT_ID = 'five-step-uppercase-v1' as const;
export const FRESH_RUNTIME_TOOL_FIXTURE_ID = 'uppercase-text-v1' as const;
export const FRESH_RUNTIME_TASK = 'Complete four uppercase checks, then finish.' as const;
export const FRESH_RUNTIME_MODEL_IDENTITY =
  'model:openrouter:openrouter-deepseek-deepseek-v4-pro-0813-high-v1' as const;
export const FRESH_RUNTIME_MAX_WALL_TIME_MICROS = 1_000_000 as const;

export interface FreshRuntimeComparisonCaseV1 {
  readonly schemaVersion: 1;
  readonly caseId: typeof FRESH_RUNTIME_COMPARISON_CASE_ID;
  readonly task: typeof FRESH_RUNTIME_TASK;
  readonly workspace: AgentReplayEnvelopeV1['workspace'];
  readonly modelIdentity: AgentResourceIdentity;
  readonly initialTranscript: readonly Message[];
  readonly ceilings: {
    readonly plannerModelRequests: 0;
    readonly maxExternalRequests: 0;
    readonly maxWallTimeMicros: 1_000_000;
  };
  readonly scriptId: typeof FRESH_RUNTIME_SCRIPT_ID;
  readonly toolFixtureId: typeof FRESH_RUNTIME_TOOL_FIXTURE_ID;
}

export interface FreshRuntimeRunSpec {
  readonly side: 'current' | 'variant';
  readonly runOrdinal: 1 | 2;
  readonly definitionId: 'default' | 'default-max-steps-4';
  readonly definition: ResolvedAgentDefinition;
  readonly manifest: AgentResolvedManifestV1;
  readonly envelope: AgentReplayEnvelopeV1;
  readonly scriptId: typeof FRESH_RUNTIME_SCRIPT_ID;
  readonly toolFixtureId: typeof FRESH_RUNTIME_TOOL_FIXTURE_ID;
}

export interface AgentFreshRuntimeComparisonPair {
  readonly current: FreshRuntimeRunSpec;
  readonly variant: FreshRuntimeRunSpec;
}

export class AgentFreshRuntimeComparisonError extends Error {
  constructor() {
    super('agent fresh-runtime comparison failed');
    this.name = 'AgentFreshRuntimeComparisonError';
  }
}

export type FreshRuntimeComparisonFailurePhase =
  | 'setup'
  | 'model'
  | 'tool'
  | 'observer'
  | 'recorder'
  | 'clock'
  | 'correlation'
  | 'partial-second-run';
export type FreshRuntimeComparisonExecutionPosition = 'first' | 'second';
export type FreshRuntimeComparisonConstructionKind =
  | 'evaluator'
  | 'model'
  | 'tool'
  | 'registry'
  | 'clock'
  | 'abort'
  | 'recorder'
  | 'commit'
  | 'counters'
  | 'transcript';
export interface FreshRuntimeComparisonTestHooks {
  readonly failure?: {
    readonly phase: FreshRuntimeComparisonFailurePhase;
    readonly position: FreshRuntimeComparisonExecutionPosition | 'any';
  };
  readonly onConstruct?: (
    kind: FreshRuntimeComparisonConstructionKind,
    side: 'current' | 'variant',
    position: FreshRuntimeComparisonExecutionPosition,
  ) => void;
  readonly onRunComplete?: (
    side: 'current' | 'variant',
    position: FreshRuntimeComparisonExecutionPosition,
  ) => void;
  /** Test-only marker emitted after each model settlement has entered the recorder. */
  readonly onProgress?: (
    marker: 'model-settled-recorded',
    side: 'current' | 'variant',
    position: FreshRuntimeComparisonExecutionPosition,
    ordinal: number,
  ) => void;
}

export interface AgentFreshRuntimeRunCounts {
  readonly modelRequests: number;
  readonly externalRequests: number;
  readonly steps: number;
  readonly toolCalls: number;
  readonly toolResults: number;
}

export interface AgentFreshRuntimeCausalToolNode {
  readonly ordinal: number;
  readonly name: string;
  readonly outcome: 'success' | 'error';
}

export interface AgentFreshRuntimeRunResult {
  readonly runOrdinal: 1 | 2;
  readonly definitionId: 'default' | 'default-max-steps-4';
  readonly manifestIdentity: AgentResolvedManifestIdentity;
  readonly envelopeIdentity: AgentReplayEnvelopeIdentity;
  readonly maxSteps: 64 | 4;
  readonly state: 'completed' | 'stopped';
  readonly counts: AgentFreshRuntimeRunCounts;
  readonly record: AgentExecutionRecordV1;
  readonly causalToolPath: readonly AgentFreshRuntimeCausalToolNode[];
}

export interface AgentFreshRuntimePair<T> {
  readonly current: T;
  readonly variant: T;
}

export interface AgentFreshRuntimeAllowedEnvelopeDiff {
  readonly definitionId: AgentFreshRuntimePair<'default' | 'default-max-steps-4'>;
  readonly maxSteps: AgentFreshRuntimePair<64 | 4>;
  readonly parentModelRequestCeiling: AgentFreshRuntimePair<64 | 4>;
  readonly aggregateModelRequestCeiling: AgentFreshRuntimePair<64 | 4>;
  readonly manifestIdentity: AgentFreshRuntimePair<AgentResolvedManifestIdentity>;
  readonly envelopeIdentity: AgentFreshRuntimePair<AgentReplayEnvelopeIdentity>;
}

export interface AgentFreshRuntimeExecutionDelta {
  readonly state: AgentFreshRuntimePair<'completed' | 'stopped'>;
  readonly stopReason: AgentFreshRuntimePair<'final' | 'max_steps'>;
  readonly committed: AgentFreshRuntimePair<boolean>;
  readonly modelRequests: AgentFreshRuntimePair<number>;
  readonly externalRequests: AgentFreshRuntimePair<number>;
  readonly steps: AgentFreshRuntimePair<number>;
  readonly toolCalls: AgentFreshRuntimePair<number>;
  readonly toolResults: AgentFreshRuntimePair<number>;
  readonly durationMicros: AgentFreshRuntimePair<number>;
  readonly providerTokenUsage: AgentFreshRuntimePair<'unsupported'>;
  readonly cost: AgentFreshRuntimePair<'unsupported'>;
}

export interface AgentFreshRuntimeComparisonShared {
  readonly taskIdentifier: typeof FRESH_RUNTIME_COMPARISON_CASE_ID;
  readonly workspaceEntryCount: 2;
  readonly modelIdentity: AgentResourceIdentity;
  readonly initialTranscriptCount: 0;
  readonly plannerModelRequestCeiling: 0;
  readonly maxExternalRequestCeiling: 0;
  readonly maxWallTimeMicros: 1_000_000;
  readonly scriptId: typeof FRESH_RUNTIME_SCRIPT_ID;
  readonly toolFixtureId: typeof FRESH_RUNTIME_TOOL_FIXTURE_ID;
}

export interface AgentFreshRuntimeComparisonResultV1 {
  readonly schemaVersion: 1;
  readonly caseId: typeof FRESH_RUNTIME_COMPARISON_CASE_ID;
  readonly shared: AgentFreshRuntimeComparisonShared;
  readonly current: AgentFreshRuntimeRunResult;
  readonly variant: AgentFreshRuntimeRunResult;
  readonly allowedEnvelopeDiff: AgentFreshRuntimeAllowedEnvelopeDiff;
  readonly executionDelta: AgentFreshRuntimeExecutionDelta;
}
