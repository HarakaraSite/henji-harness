import {
  type CorpusCaseScore,
  type CorpusDimensionScore,
  type CorpusFailureCode,
  type CorpusObservation,
  type CorpusTask,
  type CorpusToolName,
  MAX_REQUESTS,
  TOOL_NAMES,
} from './task_corpus_contract.ts';
import { deepEqualJson, isJsonValue, isRecord } from './task_corpus_value.ts';

const dimension = (
  failureCodes: readonly CorpusFailureCode[],
): CorpusDimensionScore => ({
  passed: failureCodes.length === 0,
  failureCodes,
});

export const scoreCorpusObservation = (
  task: CorpusTask,
  observation: CorpusObservation,
): CorpusCaseScore => {
  const requestFailures: CorpusFailureCode[] = [];
  const oracleFailures: CorpusFailureCode[] = [];
  const toolFailures: CorpusFailureCode[] = [];
  const submissionFailures: CorpusFailureCode[] = [];
  if (
    typeof observation.finalText !== 'string' ||
    !Number.isInteger(observation.requestCount) ||
    !Array.isArray(observation.toolEvents) ||
    (observation.submission !== undefined && observation.submission !== null &&
      (!isRecord(observation.submission) ||
        Object.keys(observation.submission).sort().join('\u0000') !==
          ['callId', 'kind', 'outcome', 'requestOrdinal', 'resultCallId'].join('\u0000') ||
        observation.submission.kind !== 'json_result' ||
        !Number.isSafeInteger(observation.submission.requestOrdinal) ||
        observation.submission.requestOrdinal < 0 ||
        observation.submission.requestOrdinal >= observation.requestCount ||
        typeof observation.submission.callId !== 'string' ||
        observation.submission.callId.trim() === '' ||
        typeof observation.submission.resultCallId !== 'string' ||
        observation.submission.resultCallId !== observation.submission.callId ||
        observation.submission.outcome !== 'success'))
  ) {
    return {
      taskId: task.id,
      passed: false,
      oracle: dimension(['invalid_observation']),
      tools: dimension(['invalid_observation']),
      submission: dimension(['invalid_observation']),
      requests: dimension(['invalid_observation']),
      failureCodes: ['invalid_observation'],
    };
  }
  const submission = observation.submission ?? null;
  if (
    observation.requestCount < 0 ||
    observation.requestCount > task.maxRequests ||
    observation.requestCount > MAX_REQUESTS
  ) {
    requestFailures.push('request_ceiling');
  }
  if (task.oracle.kind === 'exact_text') {
    if (observation.finalText !== task.oracle.expected) {
      oracleFailures.push('oracle_text_mismatch');
    }
  } else {
    let actual: unknown;
    try {
      actual = JSON.parse(observation.finalText);
    } catch {
      oracleFailures.push('oracle_json_malformed');
      actual = undefined;
    }
    if (
      actual !== undefined &&
      (!isJsonValue(actual) || !deepEqualJson(actual, task.oracle.expected))
    ) {
      oracleFailures.push('oracle_json_mismatch');
    }
  }
  if (task.oracle.kind === 'json_value') {
    if (submission === null) submissionFailures.push('submission_missing');
  } else if (submission !== null) {
    submissionFailures.push('submission_unexpected');
  }
  const successfulNames: CorpusToolName[] = [];
  let previousOrdinal = -1;
  for (const event of observation.toolEvents) {
    if (
      !isRecord(event) || typeof event.requestOrdinal !== 'number' ||
      !Number.isInteger(event.requestOrdinal)
    ) {
      toolFailures.push('invalid_observation');
      continue;
    }
    if (
      event.requestOrdinal < 0 ||
      event.requestOrdinal >= observation.requestCount
    ) toolFailures.push('invalid_observation');
    if (
      typeof event.callId !== 'string' || event.callId.length === 0 ||
      typeof event.resultCallId !== 'string' || event.resultCallId.length === 0
    ) {
      toolFailures.push('tool_missing_result');
    } else if (event.callId !== event.resultCallId) {
      toolFailures.push('tool_call_result_id_mismatch');
    }
    if (
      typeof event.callName !== 'string' ||
      typeof event.resultName !== 'string' ||
      event.callName !== event.resultName
    ) {
      toolFailures.push('tool_call_result_name_mismatch');
    }
    if (!TOOL_NAMES.includes(event.callName as CorpusToolName)) {
      toolFailures.push('tool_not_allowed');
    } else {
      const name = event.callName as CorpusToolName;
      if (task.toolExpectation.forbiddenTools.includes(name)) {
        toolFailures.push('tool_forbidden');
      } else if (!task.toolExpectation.allowedTools.includes(name)) {
        toolFailures.push('tool_not_allowed');
      }
      if (event.outcome === 'error') toolFailures.push('tool_error');
      else if (event.outcome === 'success') successfulNames.push(name);
      else toolFailures.push('invalid_observation');
      if (
        task.toolExpectation.requireSeparateRounds &&
        previousOrdinal >= event.requestOrdinal
      ) {
        toolFailures.push('tool_same_round');
      }
      previousOrdinal = event.requestOrdinal;
    }
  }
  const required = task.toolExpectation.requiredSequence;
  if (successfulNames.length < required.length) {
    toolFailures.push('tool_missing');
  }
  if (
    successfulNames.length > required.length ||
    observation.toolEvents.length > task.toolExpectation.maxCalls
  ) {
    toolFailures.push('tool_extra');
  }
  if (
    successfulNames.length === required.length &&
    successfulNames.some((name, index) => name !== required[index])
  ) {
    toolFailures.push('tool_order');
  }
  const dedupe = (
    codes: readonly CorpusFailureCode[],
  ): readonly CorpusFailureCode[] => [...new Set(codes)];
  const oracle = dimension(dedupe(oracleFailures));
  const tools = dimension(dedupe(toolFailures));
  const submissionScore = dimension(dedupe(submissionFailures));
  const requests = dimension(dedupe(requestFailures));
  const failureCodes = dedupe([
    ...oracle.failureCodes,
    ...tools.failureCodes,
    ...submissionScore.failureCodes,
    ...requests.failureCodes,
  ]);
  return {
    taskId: task.id,
    passed: failureCodes.length === 0,
    oracle,
    tools,
    submission: submissionScore,
    requests,
    failureCodes,
  };
};
