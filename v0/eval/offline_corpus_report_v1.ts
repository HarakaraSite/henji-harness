import type {
  CorpusCaseScore,
  CorpusObservation,
  CorpusTask,
  ValidatedTaskCorpus,
} from '../corpus/task_corpus.ts';
import { scoreCorpusObservation } from '../corpus/task_corpus.ts';
import {
  type OfflineCorpusCaseResult,
  type OfflineCorpusErrorResult,
  type OfflineCorpusEvalReportV1,
  type OfflineCorpusNotRunResult,
  type OfflineRunnerFailureCode,
  REPORT_ID_V1,
} from './offline_corpus_contract.ts';
import {
  corpusFailureCodes,
  equalJson,
  exactKeys,
  fail,
  isNonnegativeInteger,
  isRecord,
  runnerCodes,
  validateDimension,
} from './offline_corpus_value.ts';

const validateObservation = (value: unknown): CorpusObservation => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (!exactKeys(object, ['finalText', 'requestCount', 'toolEvents'])) {
    fail('report_contract_invalid');
  }
  if (
    typeof object.finalText !== 'string' ||
    !isNonnegativeInteger(object.requestCount)
  ) {
    fail('report_contract_invalid');
  }
  if (!Array.isArray(object.toolEvents)) fail('report_contract_invalid');
  const ids = new Set<string>();
  const rawEvents = object.toolEvents as unknown[];
  const requestCount = object.requestCount as number;
  const finalText = object.finalText as string;
  const events = rawEvents.map((event: unknown) => {
    const eventObject = isRecord(event) ? event : fail('report_contract_invalid');
    if (
      !exactKeys(eventObject, [
        'requestOrdinal',
        'callId',
        'resultCallId',
        'callName',
        'resultName',
        'outcome',
      ])
    ) fail('report_contract_invalid');
    if (
      !isNonnegativeInteger(eventObject.requestOrdinal) ||
      eventObject.requestOrdinal >= requestCount ||
      typeof eventObject.callId !== 'string' ||
      eventObject.callId.trim() === '' ||
      ids.has(eventObject.callId) ||
      typeof eventObject.resultCallId !== 'string' ||
      eventObject.resultCallId !== eventObject.callId ||
      typeof eventObject.callName !== 'string' ||
      eventObject.callName.trim() === '' ||
      typeof eventObject.resultName !== 'string' ||
      eventObject.resultName !== eventObject.callName ||
      (eventObject.outcome !== 'success' && eventObject.outcome !== 'error')
    ) fail('report_contract_invalid');
    ids.add(typeof eventObject.callId === 'string' ? eventObject.callId : '');
    return eventObject as unknown as CorpusObservation['toolEvents'][number];
  });
  return { finalText, requestCount, toolEvents: events, submission: null };
};

type LegacyCorpusCaseScore = Omit<CorpusCaseScore, 'submission'>;

export const validateScore = (
  value: unknown,
  taskId: string,
): LegacyCorpusCaseScore => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, [
      'taskId',
      'passed',
      'oracle',
      'tools',
      'requests',
      'failureCodes',
    ])
  ) {
    fail('report_contract_invalid');
  }
  if (object.taskId !== taskId || typeof object.passed !== 'boolean') {
    fail('report_contract_invalid');
  }
  validateDimension(object.oracle);
  validateDimension(object.tools);
  validateDimension(object.requests);
  if (!Array.isArray(object.failureCodes)) fail('report_contract_invalid');
  const failures = object.failureCodes as unknown[];
  if (
    failures.some((code: unknown) => typeof code !== 'string' || !corpusFailureCodes.has(code)) ||
    new Set(failures).size !== failures.length ||
    object.passed !== (failures.length === 0)
  ) fail('report_contract_invalid');
  const dimensions = [object.oracle, object.tools, object.requests] as Record<
    string,
    unknown
  >[];
  const dimensionFailures = new Set(
    dimensions.flatMap((dimension) => dimension.failureCodes as string[]),
  );
  if (
    dimensionFailures.size !== failures.length ||
    failures.some((failureCode: unknown) =>
      typeof failureCode !== 'string' || !dimensionFailures.has(failureCode)
    )
  ) fail('report_contract_invalid');
  return object as unknown as CorpusCaseScore;
};

const legacyScore = (
  task: CorpusTask,
  observation: CorpusObservation,
): LegacyCorpusCaseScore => {
  const current = scoreCorpusObservation(task, {
    ...observation,
    submission: null,
  });
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

export const countStatuses = (results: readonly OfflineCorpusCaseResult[]) => ({
  passed: results.filter((result) => result.status === 'passed').length,
  failed: results.filter((result) => result.status === 'failed').length,
});

const validateResult = (
  value: unknown,
  task: CorpusTask,
): OfflineCorpusCaseResult => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (typeof object.taskId !== 'string' || object.taskId !== task.id) {
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
      ])
    ) {
      fail('report_contract_invalid');
    }
    const observation = validateObservation({
      finalText: object.finalText,
      requestCount: object.requestCount,
      toolEvents: object.toolEvents,
    });
    const score = validateScore(object.score, task.id);
    const recomputed = (() => {
      try {
        return legacyScore(task, observation);
      } catch {
        return fail('report_contract_invalid');
      }
    })();
    if (!equalJson(score, recomputed)) fail('report_contract_invalid');
    if ((object.status === 'passed') !== score.passed) {
      fail('report_contract_invalid');
    }
    return {
      taskId: task.id,
      status: object.status,
      finalText: observation.finalText,
      requestCount: observation.requestCount,
      toolEvents: observation.toolEvents,
      score,
    } as OfflineCorpusCaseResult;
  }
  if (object.status === 'error') {
    if (!exactKeys(object, ['taskId', 'status', 'errorCode'])) {
      fail('report_contract_invalid');
    }
    if (
      typeof object.errorCode !== 'string' ||
      !runnerCodes.includes(object.errorCode as OfflineRunnerFailureCode) ||
      object.errorCode === 'run_aborted'
    ) fail('report_contract_invalid');
    return object as unknown as OfflineCorpusErrorResult;
  }
  if (object.status === 'not_run') {
    if (
      !exactKeys(object, ['taskId', 'status', 'errorCode']) ||
      object.errorCode !== 'run_aborted'
    ) {
      fail('report_contract_invalid');
    }
    return object as unknown as OfflineCorpusNotRunResult;
  }
  return fail('report_contract_invalid');
};

export const validateOfflineCorpusEvalReportV1 = (
  value: unknown,
  corpus: ValidatedTaskCorpus,
): OfflineCorpusEvalReportV1 => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, [
      'schemaVersion',
      'reportId',
      'mode',
      'corpus',
      'completion',
      'counts',
      'results',
    ])
  ) fail('report_contract_invalid');
  if (
    object.schemaVersion !== 1 || object.reportId !== REPORT_ID_V1 ||
    object.mode !== 'offline_scripted'
  ) {
    return fail('report_contract_invalid');
  }
  const reportCorpus = isRecord(object.corpus) ? object.corpus : fail('report_contract_invalid');
  if (!exactKeys(reportCorpus, ['schemaVersion', 'corpusId'])) {
    fail('report_contract_invalid');
  }
  if (
    reportCorpus.schemaVersion !== corpus.schemaVersion ||
    reportCorpus.corpusId !== corpus.corpusId
  ) {
    fail('report_contract_invalid');
  }
  const completion = isRecord(object.completion)
    ? object.completion
    : fail('report_contract_invalid');
  if (!exactKeys(completion, ['status', 'abortCode', 'abortTaskId'])) {
    fail('report_contract_invalid');
  }
  if (
    completion.status !== 'completed' && completion.status !== 'aborted'
  ) fail('report_contract_invalid');
  if (
    completion.abortCode !== null &&
    (typeof completion.abortCode !== 'string' ||
      !runnerCodes.includes(completion.abortCode as OfflineRunnerFailureCode))
  ) fail('report_contract_invalid');
  if (
    completion.abortTaskId !== null &&
    typeof completion.abortTaskId !== 'string'
  ) {
    fail('report_contract_invalid');
  }
  const counts = isRecord(object.counts) ? object.counts : fail('report_contract_invalid');
  if (!exactKeys(counts, ['total', 'completed', 'passed', 'failed'])) {
    fail('report_contract_invalid');
  }
  if (
    counts.total !== corpus.tasks.length || counts.total !== 24 ||
    !isNonnegativeInteger(counts.completed) ||
    !isNonnegativeInteger(counts.passed) ||
    !isNonnegativeInteger(counts.failed)
  ) fail('report_contract_invalid');
  const rawResults = Array.isArray(object.results)
    ? object.results
    : fail('report_contract_invalid');
  if (rawResults.length !== corpus.tasks.length) {
    fail('report_contract_invalid');
  }
  const results = rawResults.map((result: unknown, index: number) =>
    validateResult(result, corpus.tasks[index])
  );
  const statuses = countStatuses(results);
  if (
    counts.passed !== statuses.passed || counts.failed !== statuses.failed ||
    counts.completed !== statuses.passed + statuses.failed
  ) fail('report_contract_invalid');
  if (completion.status === 'completed') {
    if (completion.abortCode !== null || completion.abortTaskId !== null) {
      fail('report_contract_invalid');
    }
    if (
      results.some((result: OfflineCorpusCaseResult) =>
        result.status === 'error' || result.status === 'not_run'
      )
    ) {
      fail('report_contract_invalid');
    }
  } else {
    if (completion.abortCode === null || completion.abortTaskId === null) {
      fail('report_contract_invalid');
    }
    const errorIndex = results.findIndex((result: OfflineCorpusCaseResult) =>
      result.status === 'error'
    );
    if (errorIndex < 0) fail('report_contract_invalid');
    if (
      results.slice(0, errorIndex).some((result: OfflineCorpusCaseResult) =>
        result.status === 'error' || result.status === 'not_run'
      ) ||
      results[errorIndex].taskId !== completion.abortTaskId ||
      (results[errorIndex] as OfflineCorpusErrorResult).errorCode !==
        completion.abortCode ||
      results.slice(errorIndex + 1).some((result: OfflineCorpusCaseResult) =>
        result.status !== 'not_run'
      ) ||
      results.slice(errorIndex + 1).some((result: OfflineCorpusCaseResult) =>
        (result as OfflineCorpusNotRunResult).errorCode !== 'run_aborted'
      )
    ) fail('report_contract_invalid');
  }
  return object as unknown as OfflineCorpusEvalReportV1;
};

export const serializeOfflineCorpusEvalReportV1 = (
  report: OfflineCorpusEvalReportV1,
  corpus: ValidatedTaskCorpus,
): string => {
  validateOfflineCorpusEvalReportV1(report, corpus);
  try {
    return `${JSON.stringify(report)}\n`;
  } catch {
    return fail('report_contract_invalid');
  }
};
