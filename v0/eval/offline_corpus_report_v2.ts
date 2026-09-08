import type {
  CorpusCaseScore,
  CorpusObservation,
  CorpusTask,
  ValidatedTaskCorpus,
} from '../corpus/task_corpus.ts';
import { scoreCorpusObservation } from '../corpus/task_corpus.ts';
import {
  type OfflineCorpusCaseResultV2,
  type OfflineCorpusErrorResult,
  type OfflineCorpusEvalReportV2,
  type OfflineCorpusNotRunResult,
  type OfflineRunnerFailureCode,
  REPORT_ID,
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

export const validateCorpusObservationV2 = (
  value: unknown,
): CorpusObservation => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, [
      'finalText',
      'requestCount',
      'toolEvents',
      'submission',
    ])
  ) {
    fail('report_contract_invalid');
  }
  if (
    typeof object.finalText !== 'string' ||
    !isNonnegativeInteger(object.requestCount) ||
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
      ])
    ) fail('report_contract_invalid');
    if (
      !isNonnegativeInteger(event.requestOrdinal) ||
      event.requestOrdinal >= requestCount ||
      typeof event.callId !== 'string' || event.callId.trim() === '' ||
      ids.has(event.callId) ||
      typeof event.resultCallId !== 'string' ||
      event.resultCallId !== event.callId ||
      typeof event.callName !== 'string' || event.callName.trim() === '' ||
      typeof event.resultName !== 'string' ||
      event.resultName !== event.callName ||
      (event.outcome !== 'success' && event.outcome !== 'error') ||
      event.callName === 'submit_json_result'
    ) fail('report_contract_invalid');
    ids.add(event.callId as string);
    return event as unknown as CorpusObservation['toolEvents'][number];
  });
  const rawSubmission = object.submission;
  let submission: CorpusObservation['submission'] = null;
  if (rawSubmission !== null) {
    const value = isRecord(rawSubmission) ? rawSubmission : fail('report_contract_invalid');
    if (
      !exactKeys(value, [
        'kind',
        'requestOrdinal',
        'callId',
        'resultCallId',
        'outcome',
      ])
    ) {
      fail('report_contract_invalid');
    }
    if (
      value.kind !== 'json_result' ||
      !isNonnegativeInteger(value.requestOrdinal) ||
      requestCount < 1 || value.requestOrdinal !== requestCount - 1 ||
      toolEvents.some((event) => event.requestOrdinal >= (value.requestOrdinal as number)) ||
      typeof value.callId !== 'string' ||
      value.callId.trim() === '' || ids.has(value.callId) ||
      typeof value.resultCallId !== 'string' ||
      value.resultCallId !== value.callId ||
      value.outcome !== 'success'
    ) fail('report_contract_invalid');
    ids.add(value.callId as string);
    submission = value as unknown as CorpusObservation['submission'];
  }
  return {
    finalText: object.finalText as string,
    requestCount,
    toolEvents,
    submission,
  };
};

export const validateCorpusScoreV2 = (
  value: unknown,
  taskId: string,
): CorpusCaseScore => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, [
      'taskId',
      'passed',
      'oracle',
      'tools',
      'submission',
      'requests',
      'failureCodes',
    ])
  ) fail('report_contract_invalid');
  if (object.taskId !== taskId || typeof object.passed !== 'boolean') {
    fail('report_contract_invalid');
  }
  validateDimension(object.oracle);
  validateDimension(object.tools);
  validateDimension(object.submission);
  validateDimension(object.requests);
  if (!Array.isArray(object.failureCodes)) fail('report_contract_invalid');
  const failures = object.failureCodes as unknown[];
  if (
    failures.some((code: unknown) => typeof code !== 'string' || !corpusFailureCodes.has(code)) ||
    new Set(failures).size !== failures.length ||
    object.passed !== (failures.length === 0)
  ) fail('report_contract_invalid');
  const dimensions = [
    object.oracle,
    object.tools,
    object.submission,
    object.requests,
  ] as Record<
    string,
    unknown
  >[];
  const dimensionFailures = new Set(
    dimensions.flatMap((dimension) => dimension.failureCodes as string[]),
  );
  if (
    dimensionFailures.size !== failures.length ||
    failures.some((code) => typeof code !== 'string' || !dimensionFailures.has(code))
  ) fail('report_contract_invalid');
  return object as unknown as CorpusCaseScore;
};

const validateResultV2 = (
  value: unknown,
  task: CorpusTask,
): OfflineCorpusCaseResultV2 => {
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
    const observation = validateCorpusObservationV2({
      finalText: object.finalText,
      requestCount: object.requestCount,
      toolEvents: object.toolEvents,
      submission: object.submission,
    });
    const score = validateCorpusScoreV2(object.score, task.id);
    const recomputed = scoreCorpusObservation(task, observation);
    if (
      !equalJson(score, recomputed) ||
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
      submission: observation.submission,
      score,
    };
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

export const validateOfflineCorpusEvalReportV2 = (
  value: unknown,
  corpus: ValidatedTaskCorpus,
): OfflineCorpusEvalReportV2 => {
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
    ]) || object.schemaVersion !== 2 || object.reportId !== REPORT_ID ||
    object.mode !== 'offline_scripted'
  ) {
    fail('report_contract_invalid');
  }
  const reportCorpus = isRecord(object.corpus) ? object.corpus : fail('report_contract_invalid');
  if (
    !exactKeys(reportCorpus, ['schemaVersion', 'corpusId']) ||
    reportCorpus.schemaVersion !== corpus.schemaVersion ||
    reportCorpus.corpusId !== corpus.corpusId
  ) {
    fail('report_contract_invalid');
  }
  const completion = isRecord(object.completion)
    ? object.completion
    : fail('report_contract_invalid');
  if (
    !exactKeys(completion, ['status', 'abortCode', 'abortTaskId']) ||
    (completion.status !== 'completed' && completion.status !== 'aborted') ||
    (completion.abortCode !== null &&
      (typeof completion.abortCode !== 'string' ||
        !runnerCodes.includes(
          completion.abortCode as OfflineRunnerFailureCode,
        ))) ||
    (completion.abortTaskId !== null &&
      typeof completion.abortTaskId !== 'string')
  ) {
    fail('report_contract_invalid');
  }
  const counts = isRecord(object.counts) ? object.counts : fail('report_contract_invalid');
  if (
    !exactKeys(counts, ['total', 'completed', 'passed', 'failed']) ||
    counts.total !== corpus.tasks.length ||
    counts.total !== 24 || !isNonnegativeInteger(counts.completed) ||
    !isNonnegativeInteger(counts.passed) || !isNonnegativeInteger(counts.failed)
  ) {
    fail('report_contract_invalid');
  }
  const rawResults = Array.isArray(object.results)
    ? object.results
    : fail('report_contract_invalid');
  if (rawResults.length !== corpus.tasks.length) {
    fail('report_contract_invalid');
  }
  const results = rawResults.map((result, index) => validateResultV2(result, corpus.tasks[index]));
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  if (
    counts.passed !== passed || counts.failed !== failed ||
    counts.completed !== passed + failed
  ) {
    fail('report_contract_invalid');
  }
  if (completion.status === 'completed') {
    if (
      completion.abortCode !== null || completion.abortTaskId !== null ||
      results.some((result) => result.status === 'error' || result.status === 'not_run')
    ) {
      fail('report_contract_invalid');
    }
  } else {
    if (completion.abortCode === null || completion.abortTaskId === null) {
      fail('report_contract_invalid');
    }
    const errorIndex = results.findIndex((result) => result.taskId === completion.abortTaskId);
    if (
      errorIndex < 0 || results[errorIndex].status !== 'error' ||
      (results[errorIndex] as OfflineCorpusErrorResult).errorCode !==
        completion.abortCode ||
      results.filter((result) => result.status === 'error').length !== 1 ||
      results.slice(0, errorIndex).some((result) =>
        result.status !== 'passed' && result.status !== 'failed'
      ) ||
      results.slice(errorIndex + 1).some((result) => result.status !== 'not_run')
    ) {
      fail('report_contract_invalid');
    }
  }
  return object as unknown as OfflineCorpusEvalReportV2;
};

export const serializeOfflineCorpusEvalReportV2 = (
  report: OfflineCorpusEvalReportV2,
  corpus: ValidatedTaskCorpus,
): string => {
  validateOfflineCorpusEvalReportV2(report, corpus);
  return `${JSON.stringify(report)}\n`;
};
