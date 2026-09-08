import type { LoopOutcome } from '../agent/core/contracts.ts';
import {
  type CorpusCaseScore,
  type CorpusObservation,
  type CorpusTask,
  scoreCorpusObservation,
  type ValidatedTaskCorpus,
} from '../corpus/task_corpus.ts';
import { PRODUCTION_PROFILE } from '../agent/provider/provider_profile.ts';
import {
  CANONICAL_SUITE,
  type LiveCorpusCaseResult,
  type LiveCorpusErrorResult,
  type LiveCorpusEvalReportV1,
  type LiveCorpusNotRunResult,
  type LiveRunnerFailureCode,
  REPORT_ID_V1,
  SENTINEL_SUITE,
} from './live_corpus_contract.ts';
import {
  corpusFailureCodes,
  equalJson,
  exactKeys,
  fail,
  isNonnegativeInteger,
  isRecord,
  runnerCodes,
  suiteRequestCeiling,
  suiteTasks,
} from './live_corpus_value.ts';

const validateLoopCounters = (outcome: Record<string, unknown>, maxSteps: number): void => {
  if (
    !isNonnegativeInteger(outcome.steps) || outcome.steps < 1 || outcome.steps > maxSteps ||
    !isNonnegativeInteger(outcome.toolCallCount) || !isNonnegativeInteger(outcome.toolResultCount)
  ) fail('loop_outcome_invalid');
};

export const validateLoopOutcome = (task: CorpusTask, value: unknown): LoopOutcome => {
  const object = isRecord(value) ? value : fail('loop_outcome_invalid');
  const allowed = [
    'ok',
    'task',
    'outcome',
    'stopReason',
    'finalText',
    'terminalKind',
    'error',
    'steps',
    'toolCallCount',
    'toolResultCount',
    'transcript',
  ];
  if (Object.keys(object).some((key) => !allowed.includes(key))) fail('loop_outcome_invalid');
  if (
    typeof object.ok !== 'boolean' || object.task !== task.prompt ||
    !Array.isArray(object.transcript)
  ) {
    fail('loop_outcome_invalid');
  }
  validateLoopCounters(object, task.maxRequests);
  if (object.ok && object.stopReason === 'final') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'finalText',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ]) || object.outcome !== 'final' || object.stopReason !== 'final' ||
      typeof object.finalText !== 'string' || 'error' in object
    ) fail('loop_outcome_invalid');
  } else if (object.ok && object.stopReason === 'tool_terminal') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'finalText',
        'terminalKind',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ]) || object.outcome !== 'final' || object.stopReason !== 'tool_terminal' ||
      object.terminalKind !== 'json_result' || typeof object.finalText !== 'string' ||
      'error' in object
    ) fail('loop_outcome_invalid');
  } else if (object.outcome === 'contract_failure') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'error',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ]) || object.stopReason !== object.outcome || typeof object.error !== 'string'
    ) {
      fail('loop_outcome_invalid');
    }
  } else if (object.outcome === 'max_steps') {
    if (
      !exactKeys(object, [
        'ok',
        'task',
        'outcome',
        'stopReason',
        'steps',
        'toolCallCount',
        'toolResultCount',
        'transcript',
      ]) || object.stopReason !== object.outcome
    ) fail('loop_outcome_invalid');
  } else {
    fail('loop_outcome_invalid');
  }
  return object as unknown as LoopOutcome;
};

const validateObservation = (value: unknown): CorpusObservation => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, ['finalText', 'requestCount', 'toolEvents']) ||
    typeof object.finalText !== 'string' || !isNonnegativeInteger(object.requestCount) ||
    !Array.isArray(object.toolEvents)
  ) fail('report_contract_invalid');
  const requestCount = object.requestCount as number;
  const ids = new Set<string>();
  const toolEvents = (object.toolEvents as unknown[]).map((raw) => {
    const event = isRecord(raw) ? raw : fail('report_contract_invalid');
    if (
      !exactKeys(event, [
        'requestOrdinal',
        'callId',
        'resultCallId',
        'callName',
        'resultName',
        'outcome',
      ]) || !isNonnegativeInteger(event.requestOrdinal) || event.requestOrdinal >= requestCount ||
      typeof event.callId !== 'string' || event.callId.trim() === '' || ids.has(event.callId) ||
      typeof event.resultCallId !== 'string' || event.resultCallId !== event.callId ||
      typeof event.callName !== 'string' || event.callName.trim() === '' ||
      typeof event.resultName !== 'string' || event.resultName !== event.callName ||
      (event.outcome !== 'success' && event.outcome !== 'error')
    ) fail('report_contract_invalid');
    ids.add(event.callId as string);
    return event as unknown as CorpusObservation['toolEvents'][number];
  });
  return {
    finalText: object.finalText as string,
    requestCount,
    toolEvents,
    submission: null,
  };
};

const validateDimension = (value: unknown): void => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, ['passed', 'failureCodes']) || typeof object.passed !== 'boolean' ||
    !Array.isArray(object.failureCodes)
  ) fail('report_contract_invalid');
  const codes = object.failureCodes as unknown[];
  if (
    codes.some((code) => typeof code !== 'string' || !corpusFailureCodes.has(code)) ||
    new Set(codes).size !== codes.length || object.passed !== (codes.length === 0)
  ) {
    fail('report_contract_invalid');
  }
};

type LegacyCorpusCaseScore = Omit<CorpusCaseScore, 'submission'>;

export const validateScore = (value: unknown, taskId: string): LegacyCorpusCaseScore => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, ['taskId', 'passed', 'oracle', 'tools', 'requests', 'failureCodes']) ||
    object.taskId !== taskId || typeof object.passed !== 'boolean'
  ) fail('report_contract_invalid');
  validateDimension(object.oracle);
  validateDimension(object.tools);
  validateDimension(object.requests);
  if (!Array.isArray(object.failureCodes)) fail('report_contract_invalid');
  const failures = object.failureCodes as unknown[];
  if (
    failures.some((code) => typeof code !== 'string' || !corpusFailureCodes.has(code)) ||
    new Set(failures).size !== failures.length || object.passed !== (failures.length === 0)
  ) {
    fail('report_contract_invalid');
  }
  const dimensions = [object.oracle, object.tools, object.requests] as Record<string, unknown>[];
  const dimensionFailures = new Set(
    dimensions.flatMap((dimension) => dimension.failureCodes as string[]),
  );
  if (
    dimensionFailures.size !== failures.length ||
    failures.some((code) => typeof code !== 'string' || !dimensionFailures.has(code))
  ) fail('report_contract_invalid');
  return object as unknown as CorpusCaseScore;
};

const legacyScore = (task: CorpusTask, observation: CorpusObservation): LegacyCorpusCaseScore => {
  const current = scoreCorpusObservation(task, { ...observation, submission: null });
  const failureCodes = current.failureCodes.filter((code) =>
    code !== 'submission_missing' && code !== 'submission_unexpected'
  );
  return {
    taskId: current.taskId,
    passed: failureCodes.length === 0,
    oracle: current.oracle,
    tools: current.tools,
    requests: current.requests,
    failureCodes,
  };
};

const validateCaseResult = (value: unknown, task: CorpusTask): LiveCorpusCaseResult => {
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
        'score',
      ]) ||
      typeof object.finalText !== 'string' || !isNonnegativeInteger(object.requestCount) ||
      object.requestCount < 1 || object.requestCount > task.maxRequests
    ) {
      fail('report_contract_invalid');
    }
    const observation = validateObservation({
      finalText: object.finalText,
      requestCount: object.requestCount,
      toolEvents: object.toolEvents,
    });
    const score = validateScore(object.score, task.id);
    let recomputed: LegacyCorpusCaseScore | undefined;
    try {
      recomputed = legacyScore(task, observation);
    } catch {
      fail('report_contract_invalid');
    }
    if (
      recomputed === undefined || !equalJson(score, recomputed) ||
      (object.status === 'passed') !== score.passed
    ) {
      fail('report_contract_invalid');
    }
    return {
      taskId: task.id,
      status: object.status,
      finalText: observation.finalText,
      requestCount: observation.requestCount,
      toolEvents: observation.toolEvents,
      score,
    } as LiveCorpusCaseResult;
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

export const reportStatusCounts = (results: readonly LiveCorpusCaseResult[]) => ({
  passed: results.filter((result) => result.status === 'passed').length,
  failed: results.filter((result) => result.status === 'failed').length,
  errors: results.filter((result) => result.status === 'error').length,
  notRun: results.filter((result) => result.status === 'not_run').length,
});

export const validateLiveCorpusEvalReportV1 = (
  value: unknown,
  corpus: ValidatedTaskCorpus,
): LiveCorpusEvalReportV1 => {
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
    ]) || object.schemaVersion !== 1 || object.reportId !== REPORT_ID_V1 ||
    object.mode !== 'live_openrouter' ||
    (object.suite !== SENTINEL_SUITE && object.suite !== CANONICAL_SUITE)
  ) {
    fail('report_contract_invalid');
  }
  const suite = object.suite === SENTINEL_SUITE ? 'sentinel' : 'canonical';
  let tasks: readonly CorpusTask[] = [];
  try {
    tasks = suiteTasks(corpus, suite);
  } catch {
    fail('report_contract_invalid');
  }
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
    (completion.abortCode !== null &&
      (typeof completion.abortCode !== 'string' ||
        !runnerCodes.includes(completion.abortCode as LiveRunnerFailureCode))) ||
    (completion.abortTaskId !== null && typeof completion.abortTaskId !== 'string')
  ) {
    fail('report_contract_invalid');
  }
  const counts = isRecord(object.counts) ? object.counts : fail('report_contract_invalid');
  if (
    !exactKeys(counts, ['total', 'completed', 'passed', 'failed', 'errors', 'notRun']) ||
    counts.total !== tasks.length || (counts.total !== 6 && counts.total !== 24) ||
    !isNonnegativeInteger(counts.completed) || !isNonnegativeInteger(counts.passed) ||
    !isNonnegativeInteger(counts.failed) || !isNonnegativeInteger(counts.errors) ||
    !isNonnegativeInteger(counts.notRun)
  ) fail('report_contract_invalid');
  const rawResults = Array.isArray(object.results)
    ? object.results
    : fail('report_contract_invalid');
  if (rawResults.length !== tasks.length) fail('report_contract_invalid');
  const results = rawResults.map((result, index) => validateCaseResult(result, tasks[index]));
  const resultExternalRequests = results.reduce((total, result) => {
    if (result.status === 'passed' || result.status === 'failed') {
      return total + result.requestCount;
    }
    return result.status === 'error' ? total + result.externalRequests : total;
  }, 0);
  if (object.externalRequests !== resultExternalRequests) fail('report_contract_invalid');
  const statusCounts = reportStatusCounts(results);
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
    const errorIndex = results.findIndex((result) => result.status === 'error');
    if (
      errorIndex < 0 || results[errorIndex].taskId !== completion.abortTaskId ||
      (results[errorIndex] as LiveCorpusErrorResult).errorCode !== completion.abortCode ||
      results.slice(0, errorIndex).some((result) =>
        result.status === 'error' || result.status === 'not_run'
      ) ||
      results.slice(errorIndex + 1).some((result) => result.status !== 'not_run')
    ) {
      fail('report_contract_invalid');
    }
  }
  return object as unknown as LiveCorpusEvalReportV1;
};

export const serializeLiveCorpusEvalReportV1 = (
  report: LiveCorpusEvalReportV1,
  corpus: ValidatedTaskCorpus,
): string => {
  validateLiveCorpusEvalReportV1(report, corpus);
  try {
    return `${JSON.stringify(report)}\n`;
  } catch {
    return fail('report_contract_invalid');
  }
};
