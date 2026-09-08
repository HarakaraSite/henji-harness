import {
  type CorpusCaseScore,
  type CorpusObservation,
  type CorpusTask,
  scoreCorpusObservation,
  type ValidatedTaskCorpus,
} from '../corpus/task_corpus.ts';
import { PRODUCTION_PROFILE } from '../agent/provider/provider_profile.ts';
import { validateCorpusObservationV2, validateCorpusScoreV2 } from './offline_corpus_runner.ts';
import {
  CANONICAL_SUITE,
  type LiveCorpusCaseResultV2,
  type LiveCorpusErrorResult,
  type LiveCorpusEvalReportV2,
  type LiveCorpusNotRunResult,
  type LiveRunnerFailureCode,
  REPORT_ID,
  SENTINEL_SUITE,
} from './live_corpus_contract.ts';
import {
  equalJson,
  exactKeys,
  fail,
  isNonnegativeInteger,
  isRecord,
  runnerCodes,
  suiteRequestCeiling,
  suiteTasks,
} from './live_corpus_value.ts';

const validateLiveCaseResultV2 = (
  value: unknown,
  task: CorpusTask,
): LiveCorpusCaseResultV2 => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (object.taskId !== task.id || typeof object.taskId !== 'string') {
    fail('report_contract_invalid');
  }
  if (object.status === 'passed' || object.status === 'failed') {
    if (
      !exactKeys(object, [
        'taskId',
        'status',
        'finalText',
        'requestCount',
        'toolEvents',
        'submission',
        'score',
      ])
    ) fail('report_contract_invalid');
    let observation: CorpusObservation | undefined;
    try {
      observation = validateCorpusObservationV2({
        finalText: object.finalText,
        requestCount: object.requestCount,
        toolEvents: object.toolEvents,
        submission: object.submission,
      });
    } catch {
      fail('report_contract_invalid');
    }
    if (observation === undefined) return fail('report_contract_invalid');
    let score: CorpusCaseScore | undefined;
    try {
      score = validateCorpusScoreV2(object.score, task.id);
    } catch {
      fail('report_contract_invalid');
    }
    if (score === undefined) return fail('report_contract_invalid');
    const recomputed = scoreCorpusObservation(task, observation);
    if (!equalJson(score, recomputed) || (object.status === 'passed') !== score.passed) {
      fail('report_contract_invalid');
    }
    return {
      taskId: task.id,
      status: object.status,
      finalText: observation.finalText,
      requestCount: observation.requestCount,
      toolEvents: observation.toolEvents,
      submission: observation.submission,
      score,
    };
  }
  if (object.status === 'error') {
    if (
      !exactKeys(object, ['taskId', 'status', 'errorCode', 'externalRequests']) ||
      typeof object.errorCode !== 'string' || object.errorCode === 'run_aborted' ||
      !runnerCodes.includes(object.errorCode as LiveRunnerFailureCode) ||
      !isNonnegativeInteger(object.externalRequests) || object.externalRequests > task.maxRequests
    ) {
      fail('report_contract_invalid');
    }
    return object as unknown as LiveCorpusErrorResult;
  }
  if (object.status === 'not_run') {
    if (
      !exactKeys(object, ['taskId', 'status', 'errorCode']) || object.errorCode !== 'run_aborted'
    ) {
      fail('report_contract_invalid');
    }
    return object as unknown as LiveCorpusNotRunResult;
  }
  return fail('report_contract_invalid');
};

export const validateLiveCorpusEvalReportV2 = (
  value: unknown,
  corpus: ValidatedTaskCorpus,
): LiveCorpusEvalReportV2 => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, [
      'schemaVersion',
      'reportId',
      'mode',
      'suite',
      'profile',
      'corpus',
      'requestCeiling',
      'externalRequests',
      'completion',
      'counts',
      'results',
    ]) || object.schemaVersion !== 2 || object.reportId !== REPORT_ID ||
    object.mode !== 'live_openrouter' ||
    (object.suite !== SENTINEL_SUITE && object.suite !== CANONICAL_SUITE)
  ) {
    fail('report_contract_invalid');
  }
  const suite = object.suite === SENTINEL_SUITE ? 'sentinel' : 'canonical';
  const tasks = suiteTasks(corpus, suite);
  const profile = isRecord(object.profile) ? object.profile : fail('report_contract_invalid');
  if (
    !exactKeys(profile, ['id', 'model']) || profile.id !== PRODUCTION_PROFILE.id ||
    profile.model !== PRODUCTION_PROFILE.model
  ) {
    fail('report_contract_invalid');
  }
  const reportCorpus = isRecord(object.corpus) ? object.corpus : fail('report_contract_invalid');
  if (
    !exactKeys(reportCorpus, ['schemaVersion', 'corpusId']) ||
    reportCorpus.schemaVersion !== corpus.schemaVersion || reportCorpus.corpusId !== corpus.corpusId
  ) {
    fail('report_contract_invalid');
  }
  const ceiling = suiteRequestCeiling(suite);
  if (
    object.requestCeiling !== ceiling || !isNonnegativeInteger(object.externalRequests) ||
    object.externalRequests > ceiling
  ) fail('report_contract_invalid');
  const completion = isRecord(object.completion)
    ? object.completion
    : fail('report_contract_invalid');
  if (
    !exactKeys(completion, ['status', 'abortCode', 'abortTaskId']) ||
    (completion.status !== 'completed' && completion.status !== 'aborted') ||
    (completion.abortCode !== null && (typeof completion.abortCode !== 'string' ||
      !runnerCodes.includes(completion.abortCode as LiveRunnerFailureCode))) ||
    (completion.abortTaskId !== null && typeof completion.abortTaskId !== 'string')
  ) {
    fail('report_contract_invalid');
  }
  const counts = isRecord(object.counts) ? object.counts : fail('report_contract_invalid');
  if (
    !exactKeys(counts, ['total', 'completed', 'passed', 'failed', 'errors', 'notRun']) ||
    counts.total !== tasks.length || !isNonnegativeInteger(counts.completed) ||
    !isNonnegativeInteger(counts.passed) || !isNonnegativeInteger(counts.failed) ||
    !isNonnegativeInteger(counts.errors) || !isNonnegativeInteger(counts.notRun)
  ) {
    fail('report_contract_invalid');
  }
  const rawResults = Array.isArray(object.results)
    ? object.results
    : fail('report_contract_invalid');
  if (rawResults.length !== tasks.length) fail('report_contract_invalid');
  const results = rawResults.map((result, index) => validateLiveCaseResultV2(result, tasks[index]));
  const externalRequests = results.reduce((sum, result) => {
    if (result.status === 'passed' || result.status === 'failed') return sum + result.requestCount;
    return result.status === 'error' ? sum + result.externalRequests : sum;
  }, 0);
  if (object.externalRequests !== externalRequests) fail('report_contract_invalid');
  const statusCounts = {
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    errors: results.filter((result) => result.status === 'error').length,
    notRun: results.filter((result) => result.status === 'not_run').length,
  };
  if (
    counts.passed !== statusCounts.passed || counts.failed !== statusCounts.failed ||
    counts.errors !== statusCounts.errors || counts.notRun !== statusCounts.notRun ||
    counts.completed !== statusCounts.passed + statusCounts.failed
  ) fail('report_contract_invalid');
  if (completion.status === 'completed') {
    if (
      completion.abortCode !== null || completion.abortTaskId !== null ||
      statusCounts.errors !== 0 || statusCounts.notRun !== 0
    ) fail('report_contract_invalid');
  } else {
    if (completion.abortCode === null || completion.abortTaskId === null) {
      fail('report_contract_invalid');
    }
    const errorIndex = results.findIndex((result) => result.taskId === completion.abortTaskId);
    if (
      errorIndex < 0 || results[errorIndex].status !== 'error' ||
      (results[errorIndex] as LiveCorpusErrorResult).errorCode !== completion.abortCode ||
      results.filter((result) => result.status === 'error').length !== 1 ||
      results.slice(0, errorIndex).some((result) =>
        result.status !== 'passed' && result.status !== 'failed'
      ) ||
      results.slice(errorIndex + 1).some((result) => result.status !== 'not_run')
    ) {
      fail('report_contract_invalid');
    }
  }
  return object as unknown as LiveCorpusEvalReportV2;
};

export const serializeLiveCorpusEvalReportV2 = (
  report: LiveCorpusEvalReportV2,
  corpus: ValidatedTaskCorpus,
): string => {
  validateLiveCorpusEvalReportV2(report, corpus);
  return `${JSON.stringify(report)}\n`;
};
