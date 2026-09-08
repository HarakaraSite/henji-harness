import type {
  CorpusCaseScore,
  CorpusObservation,
  CorpusTask,
  FixtureReader,
} from '../corpus/task_corpus.ts';
import type { Model } from '../agent/core/contracts.ts';
import { runAgent } from '../agent/core/loop.ts';
import type { Registry as RegistryType } from '../agent/tools/tools.ts';

export const MAX_STEPS = 8;
export const REPORT_ID_V1 = 'henji-offline-corpus-eval-v1';
export const REPORT_ID = 'henji-offline-corpus-eval-v2';

export type OfflineRunnerFailureCode =
  | 'corpus_preflight_failed'
  | 'dependency_construction_failed'
  | 'case_execution_failed'
  | 'loop_contract_failure'
  | 'loop_max_steps'
  | 'loop_outcome_invalid'
  | 'transcript_malformed'
  | 'score_contract_invalid'
  | 'report_contract_invalid'
  | 'run_aborted';

export class OfflineCorpusEvalError extends Error {
  readonly code: OfflineRunnerFailureCode;

  constructor(code: OfflineRunnerFailureCode) {
    super(code);
    this.name = 'OfflineCorpusEvalError';
    this.code = code;
  }
}

export interface OfflineCorpusPassedResult {
  readonly taskId: string;
  readonly status: 'passed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly submission?: CorpusObservation['submission'];
  readonly score: CorpusCaseScore;
}

export interface OfflineCorpusFailedResult {
  readonly taskId: string;
  readonly status: 'failed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly submission?: CorpusObservation['submission'];
  readonly score: CorpusCaseScore;
}

export interface OfflineCorpusErrorResult {
  readonly taskId: string;
  readonly status: 'error';
  readonly errorCode: OfflineRunnerFailureCode;
}

export interface OfflineCorpusNotRunResult {
  readonly taskId: string;
  readonly status: 'not_run';
  readonly errorCode: 'run_aborted';
}

export type OfflineCorpusCaseResult =
  | OfflineCorpusPassedResult
  | OfflineCorpusFailedResult
  | OfflineCorpusErrorResult
  | OfflineCorpusNotRunResult;

export interface OfflineCorpusEvalReportV1 {
  readonly schemaVersion: 1;
  readonly reportId: typeof REPORT_ID_V1;
  readonly mode: 'offline_scripted';
  readonly corpus: {
    readonly schemaVersion: 1;
    readonly corpusId: 'henji-normal-cli-small-v1';
  };
  readonly completion: {
    readonly status: 'completed' | 'aborted';
    readonly abortCode: OfflineRunnerFailureCode | null;
    readonly abortTaskId: string | null;
  };
  readonly counts: {
    readonly total: 24;
    readonly completed: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly results: readonly OfflineCorpusCaseResult[];
}

export interface OfflineCorpusEvalTestSeam {
  readonly fixtureReader?: FixtureReader;
  readonly createCaseDependencies?: (
    task: CorpusTask,
  ) => { readonly model: Model; readonly registry: RegistryType };
  readonly runLoop?: typeof runAgent;
}

export interface OfflineCorpusPassedResultV2 {
  readonly taskId: string;
  readonly status: 'passed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly submission: CorpusObservation['submission'];
  readonly score: CorpusCaseScore;
}

export interface OfflineCorpusFailedResultV2 {
  readonly taskId: string;
  readonly status: 'failed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
  readonly submission: CorpusObservation['submission'];
  readonly score: CorpusCaseScore;
}

export type OfflineCorpusCaseResultV2 =
  | OfflineCorpusPassedResultV2
  | OfflineCorpusFailedResultV2
  | OfflineCorpusErrorResult
  | OfflineCorpusNotRunResult;

export interface OfflineCorpusEvalReportV2 {
  readonly schemaVersion: 2;
  readonly reportId: typeof REPORT_ID;
  readonly mode: 'offline_scripted';
  readonly corpus: {
    readonly schemaVersion: 1;
    readonly corpusId: 'henji-normal-cli-small-v1';
  };
  readonly completion: OfflineCorpusEvalReportV1['completion'];
  readonly counts: OfflineCorpusEvalReportV1['counts'];
  readonly results: readonly OfflineCorpusCaseResultV2[];
}
