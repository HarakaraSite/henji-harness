import type { CorpusCaseScore, CorpusObservation, FixtureReader } from '../corpus/task_corpus.ts';
import { scoreCorpusObservation } from '../corpus/task_corpus.ts';
import type { Model } from '../agent/core/contracts.ts';
import type {
  CredentialSource,
  OpenRouterAgentModelOptions,
} from '../agent/provider/openrouter_model.ts';
import { runAgent } from '../agent/core/loop.ts';
import type { Registry as RegistryType } from '../agent/tools/tools.ts';
import { PRODUCTION_PROFILE } from '../agent/provider/provider_profile.ts';

export const REPORT_ID_V1 = 'henji-live-corpus-eval-v1';
export const REPORT_ID = 'henji-live-corpus-eval-v2';
export const SENTINEL_SUITE = 'sentinel_v1' as const;
export const CANONICAL_SUITE = 'canonical_v1' as const;

export const SENTINEL_TASK_IDS = [
  'v1.character-count.henji-chick.explicit',
  'v1.count-json-array-items.complex.explicit',
  'v1.final-only.echo',
  'v1.list-json-object-keys.fmt.explicit',
  'v1.multi-tool.fmt.explicit',
  'v1.uppercase-text.ascii.explicit',
] as const;

export const CANONICAL_TASK_IDS = [
  'v1.character-count.henji-chick.explicit',
  'v1.character-count.henji-chick.implicit',
  'v1.character-count.naive.explicit',
  'v1.character-count.naive.implicit',
  'v1.count-json-array-items.complex.explicit',
  'v1.count-json-array-items.complex.implicit',
  'v1.count-json-array-items.simple.explicit',
  'v1.count-json-array-items.simple.implicit',
  'v1.final-only.echo',
  'v1.final-only.json',
  'v1.final-only.multiline',
  'v1.final-only.token',
  'v1.list-json-object-keys.fmt.explicit',
  'v1.list-json-object-keys.fmt.implicit',
  'v1.list-json-object-keys.lint.explicit',
  'v1.list-json-object-keys.lint.implicit',
  'v1.multi-tool.fmt.explicit',
  'v1.multi-tool.fmt.implicit',
  'v1.multi-tool.lint.explicit',
  'v1.multi-tool.lint.implicit',
  'v1.uppercase-text.ascii.explicit',
  'v1.uppercase-text.ascii.implicit',
  'v1.uppercase-text.unicode.explicit',
  'v1.uppercase-text.unicode.implicit',
] as const;

export type LiveCorpusSuite = 'sentinel' | 'canonical';
export type LiveReportSuite = typeof SENTINEL_SUITE | typeof CANONICAL_SUITE;

export type LiveRunnerFailureCode =
  | 'corpus_preflight_failed'
  | 'suite_contract_invalid'
  | 'dependency_construction_failed'
  | 'provider_invalid_input'
  | 'provider_missing_credential'
  | 'provider_transport_error'
  | 'provider_http_error'
  | 'provider_response_error'
  | 'provider_limit_exceeded'
  | 'external_request_ceiling'
  | 'case_execution_failed'
  | 'loop_contract_failure'
  | 'loop_max_steps'
  | 'loop_outcome_invalid'
  | 'transcript_malformed'
  | 'score_contract_invalid'
  | 'report_contract_invalid'
  | 'run_aborted';

export class LiveCorpusEvalError extends Error {
  readonly code: LiveRunnerFailureCode;

  constructor(code: LiveRunnerFailureCode) {
    super(code);
    this.name = 'LiveCorpusEvalError';
    this.code = code;
  }
}

export interface LiveCorpusPassedResult {
  readonly taskId: string;
  readonly status: 'passed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly score: CorpusCaseScore;
}

export interface LiveCorpusFailedResult {
  readonly taskId: string;
  readonly status: 'failed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly score: CorpusCaseScore;
}

export interface LiveCorpusErrorResult {
  readonly taskId: string;
  readonly status: 'error';
  readonly errorCode: LiveRunnerFailureCode;
  readonly externalRequests: number;
}

export interface LiveCorpusNotRunResult {
  readonly taskId: string;
  readonly status: 'not_run';
  readonly errorCode: 'run_aborted';
}

export type LiveCorpusCaseResult =
  | LiveCorpusPassedResult
  | LiveCorpusFailedResult
  | LiveCorpusErrorResult
  | LiveCorpusNotRunResult;

export interface LiveCorpusEvalReportV1 {
  readonly schemaVersion: 1;
  readonly reportId: typeof REPORT_ID_V1;
  readonly mode: 'live_openrouter';
  readonly suite: LiveReportSuite;
  readonly profile: {
    readonly id: typeof PRODUCTION_PROFILE.id;
    readonly model: typeof PRODUCTION_PROFILE.model;
  };
  readonly corpus: {
    readonly schemaVersion: 1;
    readonly corpusId: 'henji-normal-cli-small-v1';
  };
  readonly requestCeiling: 12 | 48;
  readonly externalRequests: number;
  readonly completion: {
    readonly status: 'completed' | 'aborted';
    readonly abortCode: LiveRunnerFailureCode | null;
    readonly abortTaskId: string | null;
  };
  readonly counts: {
    readonly total: 6 | 24;
    readonly completed: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly notRun: number;
  };
  readonly results: readonly LiveCorpusCaseResult[];
}

export interface LiveCorpusPassedResultV2 {
  readonly taskId: string;
  readonly status: 'passed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly submission: CorpusObservation['submission'];
  readonly score: CorpusCaseScore;
}

export interface LiveCorpusFailedResultV2 {
  readonly taskId: string;
  readonly status: 'failed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly submission: CorpusObservation['submission'];
  readonly score: CorpusCaseScore;
}

export type LiveCorpusCaseResultV2 =
  | LiveCorpusPassedResultV2
  | LiveCorpusFailedResultV2
  | LiveCorpusErrorResult
  | LiveCorpusNotRunResult;

export interface LiveCorpusEvalReportV2 {
  readonly schemaVersion: 2;
  readonly reportId: typeof REPORT_ID;
  readonly mode: 'live_openrouter';
  readonly suite: LiveReportSuite;
  readonly profile: LiveCorpusEvalReportV1['profile'];
  readonly corpus: LiveCorpusEvalReportV1['corpus'];
  readonly requestCeiling: 12 | 48;
  readonly externalRequests: number;
  readonly completion: LiveCorpusEvalReportV1['completion'];
  readonly counts: LiveCorpusEvalReportV1['counts'];
  readonly results: readonly LiveCorpusCaseResultV2[];
}

export interface LiveCorpusEvalTestSeam {
  readonly fixtureReader?: FixtureReader;
  readonly fetcher?: typeof fetch;
  readonly credential?: string;
  readonly credentialSource?: CredentialSource;
  readonly createRegistry?: () => RegistryType;
  readonly createModel?: (options: OpenRouterAgentModelOptions) => Model;
  readonly runLoop?: typeof runAgent;
  /** Direct-test seam for exercising scorer contract aborts without changing the scorer. */
  readonly scoreObservation?: typeof scoreCorpusObservation;
}
