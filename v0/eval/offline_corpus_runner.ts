import type { ValidatedTaskCorpus } from '../corpus/task_corpus.ts';
import type {
  OfflineCorpusEvalReportV1,
  OfflineCorpusEvalReportV2,
} from './offline_corpus_contract.ts';
import { serializeOfflineCorpusEvalReportV1 } from './offline_corpus_report_v1.ts';
import { serializeOfflineCorpusEvalReportV2 } from './offline_corpus_report_v2.ts';

export {
  MAX_STEPS,
  OfflineCorpusEvalError,
  REPORT_ID,
  REPORT_ID_V1,
} from './offline_corpus_contract.ts';
export type {
  OfflineCorpusCaseResult,
  OfflineCorpusCaseResultV2,
  OfflineCorpusErrorResult,
  OfflineCorpusEvalReportV1,
  OfflineCorpusEvalReportV2,
  OfflineCorpusEvalTestSeam,
  OfflineCorpusFailedResult,
  OfflineCorpusFailedResultV2,
  OfflineCorpusNotRunResult,
  OfflineCorpusPassedResult,
  OfflineCorpusPassedResultV2,
  OfflineRunnerFailureCode,
} from './offline_corpus_contract.ts';
export { runOfflineCorpusEval, runOfflineCorpusEvalV1 } from './offline_corpus_execution.ts';
export {
  serializeOfflineCorpusEvalReportV1,
  validateOfflineCorpusEvalReportV1,
} from './offline_corpus_report_v1.ts';
export {
  serializeOfflineCorpusEvalReportV2,
  validateCorpusObservationV2,
  validateCorpusScoreV2,
  validateOfflineCorpusEvalReportV2,
} from './offline_corpus_report_v2.ts';
export { observationFromLoopOutcome } from './offline_corpus_transcript.ts';

export type OfflineCorpusEvalReport =
  | OfflineCorpusEvalReportV1
  | OfflineCorpusEvalReportV2;

export const serializeOfflineCorpusEvalReport = (
  report: OfflineCorpusEvalReport,
  corpus: ValidatedTaskCorpus,
): string =>
  report.schemaVersion === 1
    ? serializeOfflineCorpusEvalReportV1(report, corpus)
    : serializeOfflineCorpusEvalReportV2(report, corpus);
