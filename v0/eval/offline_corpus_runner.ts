import {
  CORPUS_PATH,
  type CorpusCaseScore,
  type CorpusObservation,
  type CorpusTask,
  type FixtureReader,
  loadTaskCorpus,
  scoreCorpusObservation,
  type ValidatedTaskCorpus,
} from '../corpus/task_corpus.ts';
import {
  type JsonValue,
  type LoopOutcome,
  type Model,
  type ToolCallContent,
  type ToolMessage,
} from '../agent/contracts.ts';
import { runAgent } from '../agent/loop.ts';
import { createRuntimeRegistry } from '../agent/runtime.ts';
import { Registry, type Registry as RegistryType } from '../agent/tools.ts';
import { assertScriptedCorpusTaskSet, createScriptedCorpusModel } from './scripted_corpus_model.ts';

export const MAX_STEPS = 8;
export const REPORT_ID = 'henji-offline-corpus-eval-v1';

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
  readonly score: CorpusCaseScore;
}

export interface OfflineCorpusFailedResult {
  readonly taskId: string;
  readonly status: 'failed';
  readonly finalText: string;
  readonly requestCount: number;
  readonly toolEvents: CorpusObservation['toolEvents'];
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
  readonly reportId: typeof REPORT_ID;
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

const runnerCodes: readonly OfflineRunnerFailureCode[] = [
  'corpus_preflight_failed',
  'dependency_construction_failed',
  'case_execution_failed',
  'loop_contract_failure',
  'loop_max_steps',
  'loop_outcome_invalid',
  'transcript_malformed',
  'score_contract_invalid',
  'report_contract_invalid',
  'run_aborted',
];

const corpusFailureCodes = new Set([
  'invalid_observation',
  'request_ceiling',
  'oracle_text_mismatch',
  'oracle_json_malformed',
  'oracle_json_mismatch',
  'tool_missing',
  'tool_extra',
  'tool_not_allowed',
  'tool_forbidden',
  'tool_error',
  'tool_missing_result',
  'tool_call_result_id_mismatch',
  'tool_call_result_name_mismatch',
  'tool_order',
  'tool_same_round',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const equalJson = (left: unknown, right: unknown): boolean => {
  if (typeof left !== typeof right || left === null || right === null) {
    return left === right;
  }
  if (typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key], right[key]));
};

const fail = (code: OfflineRunnerFailureCode): never => {
  throw new OfflineCorpusEvalError(code);
};

const malformed = (): never => fail('transcript_malformed');

const validateLoopCounters = (outcome: Record<string, unknown>): void => {
  if (
    !isNonnegativeInteger(outcome.steps) || outcome.steps < 1 || outcome.steps > MAX_STEPS ||
    !isNonnegativeInteger(outcome.toolCallCount) ||
    !isNonnegativeInteger(outcome.toolResultCount)
  ) fail('loop_outcome_invalid');
};

const validateLoopOutcome = (task: CorpusTask, outcome: unknown): LoopOutcome => {
  const object = isRecord(outcome) ? outcome : fail('loop_outcome_invalid');
  const allowedKeys = [
    'ok',
    'task',
    'outcome',
    'stopReason',
    'finalText',
    'error',
    'steps',
    'toolCallCount',
    'toolResultCount',
    'transcript',
  ];
  if (Object.keys(object).some((key) => !allowedKeys.includes(key))) fail('loop_outcome_invalid');
  if (typeof object.ok !== 'boolean' || object.task !== task.prompt) fail('loop_outcome_invalid');
  validateLoopCounters(object);
  if (!Array.isArray(object.transcript)) fail('loop_outcome_invalid');
  if (object.ok) {
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
      ])
    ) fail('loop_outcome_invalid');
    if (
      object.outcome !== 'final' || object.stopReason !== 'final' ||
      typeof object.finalText !== 'string' || 'error' in object
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
      ])
    ) fail('loop_outcome_invalid');
    if (object.stopReason !== object.outcome || typeof object.error !== 'string') {
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
      ])
    ) fail('loop_outcome_invalid');
    if (object.stopReason !== object.outcome) fail('loop_outcome_invalid');
  } else {
    fail('loop_outcome_invalid');
  }
  return object as unknown as LoopOutcome;
};

const expectUserMessage = (message: unknown, prompt: string): void => {
  const object = isRecord(message) ? message : malformed();
  if (!exactKeys(object, ['role', 'content']) || object.role !== 'user') {
    malformed();
  }
  const content = object.content;
  if (
    !isRecord(content) || !exactKeys(content, ['kind', 'text']) || content.kind !== 'text' ||
    content.text !== prompt
  ) malformed();
};

const parseToolCall = (
  value: unknown,
  callIds: Set<string>,
): ToolCallContent => {
  const object = isRecord(value) ? value : malformed();
  if (!exactKeys(object, ['kind', 'callId', 'name', 'arguments'])) malformed();
  if (
    object.kind !== 'tool_call' || typeof object.callId !== 'string' ||
    object.callId.trim() === '' ||
    callIds.has(object.callId) || typeof object.name !== 'string' || object.name.trim() === '' ||
    !isJsonValue(object.arguments)
  ) malformed();
  const callId = typeof object.callId === 'string' ? object.callId : malformed();
  callIds.add(callId);
  return object as unknown as ToolCallContent;
};

const parseToolResult = (
  value: unknown,
  call: ToolCallContent,
): ToolMessage['content'][number] => {
  const object = isRecord(value) ? value : malformed();
  if (!exactKeys(object, ['kind', 'callId', 'name', 'text', 'outcome'])) malformed();
  if (
    object.kind !== 'tool_result' || object.callId !== call.callId || object.name !== call.name ||
    typeof object.text !== 'string' || (object.outcome !== 'success' && object.outcome !== 'error')
  ) malformed();
  return object as unknown as ToolMessage['content'][number];
};

export const observationFromLoopOutcome = (
  task: CorpusTask,
  rawOutcome: LoopOutcome,
): CorpusObservation => {
  const outcome = validateLoopOutcome(task, rawOutcome);
  if (!outcome.ok) fail('loop_contract_failure');
  const transcript = outcome.transcript;
  if (transcript.length < 2) malformed();
  expectUserMessage(transcript[0], task.prompt);
  const toolEvents: CorpusObservation['toolEvents'][number][] = [];
  const callIds = new Set<string>();
  let index = 1;
  let requestOrdinal = 0;
  let finalText: string | undefined;
  let assistantCount = 0;
  while (index < transcript.length) {
    const assistant = transcript[index];
    const assistantObject = isRecord(assistant) ? assistant : malformed();
    if (assistantObject.role !== 'assistant' || !exactKeys(assistantObject, ['role', 'content'])) {
      malformed();
    }
    const content = assistantObject.content;
    if (isRecord(content)) {
      const contentObject = content as Record<string, unknown>;
      if (
        !exactKeys(contentObject, ['kind', 'text']) || contentObject.kind !== 'text' ||
        typeof contentObject.text !== 'string'
      ) {
        malformed();
      }
      if (contentObject.text !== outcome.finalText || index + 1 !== transcript.length) malformed();
      finalText = typeof contentObject.text === 'string' ? contentObject.text : malformed();
      assistantCount += 1;
      index += 1;
      break;
    }
    const callsContent = Array.isArray(content) ? content : malformed();
    if (callsContent.length === 0) malformed();
    const calls = callsContent.map((value: unknown) => parseToolCall(value, callIds));
    assistantCount += 1;
    index += 1;
    if (index >= transcript.length) malformed();
    const tool = transcript[index];
    const toolObject = isRecord(tool) ? tool : malformed();
    if (toolObject.role !== 'tool' || !exactKeys(toolObject, ['role', 'content'])) malformed();
    const toolContent =
      (Array.isArray(toolObject.content) ? toolObject.content : malformed()) as unknown[];
    if (toolContent.length !== calls.length) malformed();
    for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
      const result = parseToolResult(toolContent[callIndex], calls[callIndex]);
      toolEvents.push({
        requestOrdinal,
        callId: calls[callIndex].callId,
        resultCallId: result.callId,
        callName: calls[callIndex].name,
        resultName: result.name,
        outcome: result.outcome,
      });
    }
    index += 1;
    requestOrdinal += 1;
  }
  if (finalText === undefined || index !== transcript.length) malformed();
  if (
    assistantCount !== outcome.steps ||
    toolEvents.length !== outcome.toolCallCount ||
    toolEvents.length !== outcome.toolResultCount ||
    assistantCount !== requestOrdinal + 1
  ) fail('loop_outcome_invalid');
  return {
    finalText: typeof finalText === 'string' ? finalText : malformed(),
    requestCount: outcome.steps,
    toolEvents,
  };
};

const validateObservation = (value: unknown): CorpusObservation => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (!exactKeys(object, ['finalText', 'requestCount', 'toolEvents'])) {
    fail('report_contract_invalid');
  }
  if (typeof object.finalText !== 'string' || !isNonnegativeInteger(object.requestCount)) {
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
      typeof eventObject.callId !== 'string' || eventObject.callId.trim() === '' ||
      ids.has(eventObject.callId) ||
      typeof eventObject.resultCallId !== 'string' ||
      eventObject.resultCallId !== eventObject.callId ||
      typeof eventObject.callName !== 'string' || eventObject.callName.trim() === '' ||
      typeof eventObject.resultName !== 'string' ||
      eventObject.resultName !== eventObject.callName ||
      (eventObject.outcome !== 'success' && eventObject.outcome !== 'error')
    ) fail('report_contract_invalid');
    ids.add(typeof eventObject.callId === 'string' ? eventObject.callId : '');
    return eventObject as unknown as CorpusObservation['toolEvents'][number];
  });
  return { finalText, requestCount, toolEvents: events };
};

const validateDimension = (value: unknown): void => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (!exactKeys(object, ['passed', 'failureCodes']) || typeof object.passed !== 'boolean') {
    fail('report_contract_invalid');
  }
  if (!Array.isArray(object.failureCodes)) fail('report_contract_invalid');
  const codes = object.failureCodes as unknown[];
  if (
    codes.some((code: unknown) => typeof code !== 'string' || !corpusFailureCodes.has(code)) ||
    new Set(codes).size !== codes.length || object.passed !== (codes.length === 0)
  ) fail('report_contract_invalid');
};

const validateScore = (value: unknown, taskId: string): CorpusCaseScore => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (!exactKeys(object, ['taskId', 'passed', 'oracle', 'tools', 'requests', 'failureCodes'])) {
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
    new Set(failures).size !== failures.length || object.passed !== (failures.length === 0)
  ) fail('report_contract_invalid');
  const dimensions = [object.oracle, object.tools, object.requests] as Record<string, unknown>[];
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

const countStatuses = (results: readonly OfflineCorpusCaseResult[]) => ({
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
      !exactKeys(object, ['taskId', 'status', 'finalText', 'requestCount', 'toolEvents', 'score'])
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
        return scoreCorpusObservation(task, observation);
      } catch {
        return fail('report_contract_invalid');
      }
    })();
    if (!equalJson(score, recomputed)) fail('report_contract_invalid');
    if ((object.status === 'passed') !== score.passed) fail('report_contract_invalid');
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
    if (!exactKeys(object, ['taskId', 'status', 'errorCode'])) fail('report_contract_invalid');
    if (
      typeof object.errorCode !== 'string' ||
      !runnerCodes.includes(object.errorCode as OfflineRunnerFailureCode) ||
      object.errorCode === 'run_aborted'
    ) fail('report_contract_invalid');
    return object as unknown as OfflineCorpusErrorResult;
  }
  if (object.status === 'not_run') {
    if (
      !exactKeys(object, ['taskId', 'status', 'errorCode']) || object.errorCode !== 'run_aborted'
    ) {
      fail('report_contract_invalid');
    }
    return object as unknown as OfflineCorpusNotRunResult;
  }
  return fail('report_contract_invalid');
};

export const validateOfflineCorpusEvalReport = (
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
    object.schemaVersion !== 1 || object.reportId !== REPORT_ID ||
    object.mode !== 'offline_scripted'
  ) {
    return fail('report_contract_invalid');
  }
  const reportCorpus = isRecord(object.corpus) ? object.corpus : fail('report_contract_invalid');
  if (!exactKeys(reportCorpus, ['schemaVersion', 'corpusId'])) {
    fail('report_contract_invalid');
  }
  if (
    reportCorpus.schemaVersion !== corpus.schemaVersion || reportCorpus.corpusId !== corpus.corpusId
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
  if (completion.abortTaskId !== null && typeof completion.abortTaskId !== 'string') {
    fail('report_contract_invalid');
  }
  const counts = isRecord(object.counts) ? object.counts : fail('report_contract_invalid');
  if (!exactKeys(counts, ['total', 'completed', 'passed', 'failed'])) {
    fail('report_contract_invalid');
  }
  if (
    counts.total !== corpus.tasks.length || counts.total !== 24 ||
    !isNonnegativeInteger(counts.completed) || !isNonnegativeInteger(counts.passed) ||
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
      (results[errorIndex] as OfflineCorpusErrorResult).errorCode !== completion.abortCode ||
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

export const serializeOfflineCorpusEvalReport = (
  report: OfflineCorpusEvalReportV1,
  corpus: ValidatedTaskCorpus,
): string => {
  validateOfflineCorpusEvalReport(report, corpus);
  try {
    return `${JSON.stringify(report)}\n`;
  } catch {
    return fail('report_contract_invalid');
  }
};

const defaultFixtureReader: FixtureReader = async (path) => await Deno.readTextFile(path);

const caseError = (
  taskId: string,
  errorCode: OfflineRunnerFailureCode,
): OfflineCorpusErrorResult => ({
  taskId,
  status: 'error',
  errorCode,
});

const notRun = (taskId: string): OfflineCorpusNotRunResult => ({
  taskId,
  status: 'not_run',
  errorCode: 'run_aborted',
});

const reportFor = (
  corpus: ValidatedTaskCorpus,
  results: readonly OfflineCorpusCaseResult[],
  abortCode: OfflineRunnerFailureCode | null,
  abortTaskId: string | null,
): OfflineCorpusEvalReportV1 => {
  const { passed, failed } = countStatuses(results);
  return {
    schemaVersion: 1,
    reportId: REPORT_ID,
    mode: 'offline_scripted',
    corpus: { schemaVersion: corpus.schemaVersion, corpusId: corpus.corpusId },
    completion: {
      status: abortCode === null ? 'completed' : 'aborted',
      abortCode,
      abortTaskId,
    },
    counts: { total: 24, completed: passed + failed, passed, failed },
    results,
  };
};

export const runOfflineCorpusEval = async (
  seam: OfflineCorpusEvalTestSeam = {},
): Promise<OfflineCorpusEvalReportV1> => {
  let corpus: ValidatedTaskCorpus;
  try {
    corpus = await loadTaskCorpus(CORPUS_PATH, seam.fixtureReader ?? defaultFixtureReader);
    assertScriptedCorpusTaskSet(corpus.tasks.map((task) => task.id));
  } catch {
    throw new OfflineCorpusEvalError('corpus_preflight_failed');
  }
  const results: OfflineCorpusCaseResult[] = [];
  let abortCode: OfflineRunnerFailureCode | null = null;
  let abortTaskId: string | null = null;
  const createDependencies = seam.createCaseDependencies ?? ((task: CorpusTask) => ({
    model: createScriptedCorpusModel(task),
    registry: createRuntimeRegistry(),
  }));
  const runLoop = seam.runLoop ?? runAgent;
  for (const [index, task] of corpus.tasks.entries()) {
    let dependencies: { readonly model: Model; readonly registry: RegistryType };
    try {
      dependencies = createDependencies(task);
      if (
        !isRecord(dependencies) || typeof dependencies.model !== 'object' ||
        dependencies.model === null ||
        typeof (dependencies.model as { generate?: unknown }).generate !== 'function' ||
        !(dependencies.registry instanceof Registry)
      ) fail('dependency_construction_failed');
    } catch {
      abortCode = 'dependency_construction_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(task.prompt, dependencies.model, dependencies.registry, {
        maxSteps: MAX_STEPS,
      });
    } catch {
      abortCode = 'case_execution_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let checkedOutcome: LoopOutcome;
    try {
      checkedOutcome = validateLoopOutcome(task, outcome);
    } catch (error) {
      const code = error instanceof OfflineCorpusEvalError ? error.code : 'loop_outcome_invalid';
      abortCode = code === 'transcript_malformed' ? 'loop_outcome_invalid' : code;
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (!checkedOutcome.ok) {
      abortCode = checkedOutcome.outcome === 'max_steps'
        ? 'loop_max_steps'
        : 'loop_contract_failure';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let observation: CorpusObservation;
    try {
      observation = observationFromLoopOutcome(task, checkedOutcome);
    } catch (error) {
      const code = error instanceof OfflineCorpusEvalError ? error.code : 'transcript_malformed';
      abortCode = code === 'loop_outcome_invalid' || code === 'transcript_malformed'
        ? code
        : 'transcript_malformed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let score: CorpusCaseScore;
    try {
      score = scoreCorpusObservation(task, observation);
      validateScore(score, task.id);
    } catch {
      abortCode = 'score_contract_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode));
      for (const later of corpus.tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    results.push({
      taskId: task.id,
      status: score.passed ? 'passed' : 'failed',
      finalText: observation.finalText,
      requestCount: observation.requestCount,
      toolEvents: observation.toolEvents,
      score,
    });
  }
  const report = reportFor(corpus, results, abortCode, abortTaskId);
  try {
    return validateOfflineCorpusEvalReport(report, corpus);
  } catch {
    throw new OfflineCorpusEvalError('report_contract_invalid');
  }
};
