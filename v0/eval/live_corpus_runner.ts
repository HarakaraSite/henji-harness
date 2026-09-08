import type { ValidatedTaskCorpus } from '../corpus/task_corpus.ts';
import type { LiveCorpusEvalReportV1, LiveCorpusEvalReportV2 } from './live_corpus_contract.ts';
import { isRecord } from './live_corpus_value.ts';
import {
  serializeLiveCorpusEvalReportV1,
  validateLiveCorpusEvalReportV1,
} from './live_corpus_report_v1.ts';
import {
  serializeLiveCorpusEvalReportV2,
  validateLiveCorpusEvalReportV2,
} from './live_corpus_report_v2.ts';

export {
  CANONICAL_SUITE,
  CANONICAL_TASK_IDS,
  LiveCorpusEvalError,
  REPORT_ID,
  REPORT_ID_V1,
  SENTINEL_SUITE,
  SENTINEL_TASK_IDS,
} from './live_corpus_contract.ts';
export type {
  LiveCorpusCaseResult,
  LiveCorpusCaseResultV2,
  LiveCorpusErrorResult,
  LiveCorpusEvalReportV1,
  LiveCorpusEvalReportV2,
  LiveCorpusEvalTestSeam,
  LiveCorpusFailedResult,
  LiveCorpusFailedResultV2,
  LiveCorpusNotRunResult,
  LiveCorpusPassedResult,
  LiveCorpusPassedResultV2,
  LiveCorpusSuite,
  LiveReportSuite,
  LiveRunnerFailureCode,
} from './live_corpus_contract.ts';
export { validateLiveSuite } from './live_corpus_value.ts';
export {
  serializeLiveCorpusEvalReportV1,
  validateLiveCorpusEvalReportV1,
} from './live_corpus_report_v1.ts';
export {
  serializeLiveCorpusEvalReportV2,
  validateLiveCorpusEvalReportV2,
} from './live_corpus_report_v2.ts';
export { runLiveCorpusEval, runLiveCorpusEvalV1 } from './live_corpus_execution.ts';

export type LiveCorpusEvalReport = LiveCorpusEvalReportV1 | LiveCorpusEvalReportV2;

export const validateLiveCorpusEvalReport = (
  value: unknown,
  corpus: ValidatedTaskCorpus,
): LiveCorpusEvalReport => {
  if (isRecord(value) && value.schemaVersion === 1) {
    return validateLiveCorpusEvalReportV1(value, corpus);
  }
  return validateLiveCorpusEvalReportV2(value, corpus);
};

export const serializeLiveCorpusEvalReport = (
  report: LiveCorpusEvalReport,
  corpus: ValidatedTaskCorpus,
): string =>
  report.schemaVersion === 1
    ? serializeLiveCorpusEvalReportV1(report, corpus)
    : serializeLiveCorpusEvalReportV2(report, corpus);
