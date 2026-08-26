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
import { type JsonValue, type LoopOutcome, type Model } from '../agent/contracts.ts';
import {
  type CredentialSource,
  OpenRouterAgentError,
  OpenRouterAgentModel,
  type OpenRouterAgentModelOptions,
} from '../agent/openrouter_model.ts';
import { runAgent } from '../agent/loop.ts';
import { createCorpusRegistry } from '../agent/registries.ts';
import { Registry, type Registry as RegistryType } from '../agent/tools.ts';
import { PROFILE } from '../model.ts';
import {
  observationFromLoopOutcome,
  OfflineCorpusEvalError,
  validateCorpusObservationV2,
  validateCorpusScoreV2,
} from './offline_corpus_runner.ts';

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
    readonly id: typeof PROFILE.id;
    readonly model: typeof PROFILE.model;
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

const runnerCodes: readonly LiveRunnerFailureCode[] = [
  'corpus_preflight_failed',
  'suite_contract_invalid',
  'dependency_construction_failed',
  'provider_invalid_input',
  'provider_missing_credential',
  'provider_transport_error',
  'provider_http_error',
  'provider_response_error',
  'provider_limit_exceeded',
  'external_request_ceiling',
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
  'submission_missing',
  'submission_unexpected',
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
  if (typeof left !== typeof right || left === null || right === null) return left === right;
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

const fail = (code: LiveRunnerFailureCode): never => {
  throw new LiveCorpusEvalError(code);
};

const suiteReportName = (suite: LiveCorpusSuite): LiveReportSuite =>
  suite === 'sentinel' ? SENTINEL_SUITE : CANONICAL_SUITE;

const suiteRequestCeiling = (suite: LiveCorpusSuite): 12 | 48 => suite === 'sentinel' ? 12 : 48;

const suiteTaskIds = (suite: LiveCorpusSuite): readonly string[] =>
  suite === 'sentinel' ? SENTINEL_TASK_IDS : CANONICAL_TASK_IDS;

const suiteTasks = (
  corpus: ValidatedTaskCorpus,
  suite: LiveCorpusSuite,
): readonly CorpusTask[] => {
  if (suite !== 'sentinel' && suite !== 'canonical') fail('suite_contract_invalid');
  const expectedIds = suiteTaskIds(suite);
  const byId = new Map(corpus.tasks.map((task) => [task.id, task]));
  const selected = expectedIds.map((id) => byId.get(id));
  if (selected.some((task) => task === undefined)) fail('suite_contract_invalid');
  const tasks = selected as CorpusTask[];
  if (tasks.length !== (suite === 'sentinel' ? 6 : 24)) fail('suite_contract_invalid');
  if (tasks.some((task, index) => task.id !== expectedIds[index])) fail('suite_contract_invalid');
  if (
    suite === 'canonical' &&
    (corpus.tasks.length !== CANONICAL_TASK_IDS.length ||
      corpus.tasks.some((task, index) => task.id !== CANONICAL_TASK_IDS[index]))
  ) {
    fail('suite_contract_invalid');
  }
  const categories = new Map<string, number>();
  for (const task of tasks) categories.set(task.category, (categories.get(task.category) ?? 0) + 1);
  const expectedCategories = suite === 'sentinel' ? 1 : 4;
  for (
    const category of [
      'character_count',
      'count_json_array_items',
      'final_only',
      'list_json_object_keys',
      'multi_tool',
      'uppercase_text',
    ]
  ) {
    if (categories.get(category) !== expectedCategories) fail('suite_contract_invalid');
  }
  if (tasks.reduce((sum, task) => sum + task.maxRequests, 0) !== suiteRequestCeiling(suite)) {
    fail('suite_contract_invalid');
  }
  return tasks;
};

export const validateLiveSuite = (
  corpus: ValidatedTaskCorpus,
  suite: LiveCorpusSuite,
): readonly CorpusTask[] => suiteTasks(corpus, suite);

const validateLoopCounters = (outcome: Record<string, unknown>, maxSteps: number): void => {
  if (
    !isNonnegativeInteger(outcome.steps) || outcome.steps < 1 || outcome.steps > maxSteps ||
    !isNonnegativeInteger(outcome.toolCallCount) || !isNonnegativeInteger(outcome.toolResultCount)
  ) fail('loop_outcome_invalid');
};

const validateLoopOutcome = (task: CorpusTask, value: unknown): LoopOutcome => {
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

const validateScore = (value: unknown, taskId: string): LegacyCorpusCaseScore => {
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

const reportStatusCounts = (results: readonly LiveCorpusCaseResult[]) => ({
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
    !exactKeys(profile, ['id', 'model']) || profile.id !== PROFILE.id ||
    profile.model !== PROFILE.model
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
    !exactKeys(profile, ['id', 'model']) || profile.id !== PROFILE.id ||
    profile.model !== PROFILE.model
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

interface FetchState {
  externalRequests: number;
  ceilingExceeded: boolean;
}

const makeBoundedFetcher = (
  delegate: typeof fetch,
  ceiling: number,
  state: FetchState,
): typeof fetch =>
(input, init) => {
  if (state.externalRequests >= ceiling) {
    state.ceilingExceeded = true;
    throw new Error('external request ceiling reached');
  }
  state.externalRequests += 1;
  return delegate(input, init);
};

const providerFailureCode = (
  error: OpenRouterAgentError,
  ceilingExceeded: boolean,
): LiveRunnerFailureCode => {
  if (ceilingExceeded) return 'external_request_ceiling';
  switch (error.code) {
    case 'invalid_input':
      return 'provider_invalid_input';
    case 'missing_credential':
      return 'provider_missing_credential';
    case 'transport_error':
      return 'provider_transport_error';
    case 'http_error':
      return 'provider_http_error';
    case 'response_error':
      return 'provider_response_error';
    case 'limit_exceeded':
      return 'provider_limit_exceeded';
  }
};

const isModel = (value: unknown): value is Model =>
  isRecord(value) && typeof value.generate === 'function';

const caseError = (
  taskId: string,
  errorCode: LiveRunnerFailureCode,
  externalRequests: number,
): LiveCorpusErrorResult => ({ taskId, status: 'error', errorCode, externalRequests });

const notRun = (taskId: string): LiveCorpusNotRunResult => ({
  taskId,
  status: 'not_run',
  errorCode: 'run_aborted',
});

const reportFor = (
  corpus: ValidatedTaskCorpus,
  suite: LiveCorpusSuite,
  state: FetchState,
  results: readonly LiveCorpusCaseResult[],
  abortCode: LiveRunnerFailureCode | null,
  abortTaskId: string | null,
): LiveCorpusEvalReportV1 => {
  const counts = reportStatusCounts(results);
  return {
    schemaVersion: 1,
    reportId: REPORT_ID_V1,
    mode: 'live_openrouter',
    suite: suiteReportName(suite),
    profile: { id: PROFILE.id, model: PROFILE.model },
    corpus: { schemaVersion: corpus.schemaVersion, corpusId: corpus.corpusId },
    requestCeiling: suiteRequestCeiling(suite),
    externalRequests: state.externalRequests,
    completion: {
      status: abortCode === null ? 'completed' : 'aborted',
      abortCode,
      abortTaskId,
    },
    counts: {
      total: suite === 'sentinel' ? 6 : 24,
      completed: counts.passed + counts.failed,
      passed: counts.passed,
      failed: counts.failed,
      errors: counts.errors,
      notRun: counts.notRun,
    },
    results,
  };
};

export const runLiveCorpusEvalV1 = async (
  suite: LiveCorpusSuite,
  seam: LiveCorpusEvalTestSeam = {},
): Promise<LiveCorpusEvalReportV1> => {
  if (suite !== 'sentinel' && suite !== 'canonical') fail('suite_contract_invalid');
  let corpus: ValidatedTaskCorpus;
  try {
    corpus = await loadTaskCorpus(
      CORPUS_PATH,
      seam.fixtureReader ?? (async (path) => {
        return await Deno.readTextFile(path);
      }),
    );
  } catch {
    throw new LiveCorpusEvalError('corpus_preflight_failed');
  }
  let tasks: readonly CorpusTask[];
  try {
    tasks = suiteTasks(corpus, suite);
  } catch {
    throw new LiveCorpusEvalError('suite_contract_invalid');
  }

  const state: FetchState = { externalRequests: 0, ceilingExceeded: false };
  const boundedFetcher = makeBoundedFetcher(
    seam.fetcher ?? fetch,
    suiteRequestCeiling(suite),
    state,
  );
  const results: LiveCorpusCaseResult[] = [];
  let abortCode: LiveRunnerFailureCode | null = null;
  let abortTaskId: string | null = null;
  const createRegistry = seam.createRegistry ?? (() => createCorpusRegistry());
  const createModel = seam.createModel ?? ((options) => new OpenRouterAgentModel(options));
  const runLoop = seam.runLoop ?? runAgent;
  const scoreObservation = seam.scoreObservation ?? scoreCorpusObservation;

  for (const [index, task] of tasks.entries()) {
    const caseStart = state.externalRequests;
    let registry: RegistryType;
    let baseModel: Model;
    try {
      registry = createRegistry();
      if (!(registry instanceof Registry)) fail('dependency_construction_failed');
      baseModel = createModel({
        fetcher: boundedFetcher,
        credential: seam.credential,
        credentialSource: seam.credentialSource,
      });
      if (!isModel(baseModel)) fail('dependency_construction_failed');
    } catch {
      abortCode = 'dependency_construction_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }

    let providerError: OpenRouterAgentError | undefined;
    const trackedModel: Model = {
      generate: async (request) => {
        try {
          return await baseModel.generate(request);
        } catch (error) {
          if (error instanceof OpenRouterAgentError) providerError = error;
          throw error;
        }
      },
    };
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(task.prompt, trackedModel, registry, { maxSteps: task.maxRequests });
    } catch (error) {
      if (error instanceof OpenRouterAgentError) providerError = error;
      const code = providerError
        ? providerFailureCode(providerError, state.ceilingExceeded)
        : 'case_execution_failed';
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (providerError) {
      const code = providerFailureCode(providerError, state.ceilingExceeded);
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }

    let checkedOutcome: LoopOutcome;
    try {
      checkedOutcome = validateLoopOutcome(task, outcome);
    } catch (error) {
      const code = error instanceof LiveCorpusEvalError ? error.code : 'loop_outcome_invalid';
      abortCode = code === 'transcript_malformed' ? 'loop_outcome_invalid' : code;
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (!checkedOutcome.ok) {
      abortCode = checkedOutcome.outcome === 'max_steps'
        ? 'loop_max_steps'
        : 'loop_contract_failure';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }

    let observation: CorpusObservation;
    try {
      observation = observationFromLoopOutcome(task, checkedOutcome);
    } catch (error) {
      const observedCode = error instanceof OfflineCorpusEvalError
        ? error.code
        : 'transcript_malformed';
      const code: LiveRunnerFailureCode = observedCode === 'loop_outcome_invalid'
        ? 'loop_outcome_invalid'
        : 'transcript_malformed';
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let score: CorpusCaseScore;
    try {
      score = scoreObservation(task, observation);
      validateScore(score, task.id);
    } catch {
      abortCode = 'score_contract_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
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
  const report = reportFor(corpus, suite, state, results, abortCode, abortTaskId);
  try {
    return validateLiveCorpusEvalReportV1(report, corpus);
  } catch {
    throw new LiveCorpusEvalError('report_contract_invalid');
  }
};

const reportForV2 = (
  corpus: ValidatedTaskCorpus,
  suite: LiveCorpusSuite,
  state: FetchState,
  results: readonly LiveCorpusCaseResultV2[],
  abortCode: LiveRunnerFailureCode | null,
  abortTaskId: string | null,
): LiveCorpusEvalReportV2 => {
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const errors = results.filter((result) => result.status === 'error').length;
  const notRun = results.filter((result) => result.status === 'not_run').length;
  return {
    schemaVersion: 2,
    reportId: REPORT_ID,
    mode: 'live_openrouter',
    suite: suiteReportName(suite),
    profile: { id: PROFILE.id, model: PROFILE.model },
    corpus: { schemaVersion: corpus.schemaVersion, corpusId: corpus.corpusId },
    requestCeiling: suiteRequestCeiling(suite),
    externalRequests: state.externalRequests,
    completion: { status: abortCode === null ? 'completed' : 'aborted', abortCode, abortTaskId },
    counts: {
      total: suite === 'sentinel' ? 6 : 24,
      completed: passed + failed,
      passed,
      failed,
      errors,
      notRun,
    },
    results,
  };
};

export const runLiveCorpusEval = async (
  suite: LiveCorpusSuite,
  seam: LiveCorpusEvalTestSeam = {},
): Promise<LiveCorpusEvalReportV2> => {
  if (suite !== 'sentinel' && suite !== 'canonical') fail('suite_contract_invalid');
  let corpus: ValidatedTaskCorpus;
  try {
    corpus = await loadTaskCorpus(
      CORPUS_PATH,
      seam.fixtureReader ?? (async (path) => await Deno.readTextFile(path)),
    );
  } catch {
    throw new LiveCorpusEvalError('corpus_preflight_failed');
  }
  let tasks: readonly CorpusTask[];
  try {
    tasks = suiteTasks(corpus, suite);
  } catch {
    throw new LiveCorpusEvalError('suite_contract_invalid');
  }
  const state: FetchState = { externalRequests: 0, ceilingExceeded: false };
  const boundedFetcher = makeBoundedFetcher(
    seam.fetcher ?? fetch,
    suiteRequestCeiling(suite),
    state,
  );
  const results: LiveCorpusCaseResultV2[] = [];
  let abortCode: LiveRunnerFailureCode | null = null;
  let abortTaskId: string | null = null;
  const createRegistry = seam.createRegistry ?? (() => createCorpusRegistry());
  const createModel = seam.createModel ?? ((options) => new OpenRouterAgentModel(options));
  const runLoop = seam.runLoop ?? runAgent;
  const scoreObservation = seam.scoreObservation ?? scoreCorpusObservation;
  for (const [index, task] of tasks.entries()) {
    const caseStart = state.externalRequests;
    let registry: RegistryType;
    let baseModel: Model;
    try {
      registry = createRegistry();
      if (!(registry instanceof Registry)) fail('dependency_construction_failed');
      baseModel = createModel({
        fetcher: boundedFetcher,
        credential: seam.credential,
        credentialSource: seam.credentialSource,
      });
      if (!isModel(baseModel)) fail('dependency_construction_failed');
    } catch {
      abortCode = 'dependency_construction_failed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let providerError: OpenRouterAgentError | undefined;
    const trackedModel: Model = {
      generate: async (request) => {
        try {
          return await baseModel.generate(request);
        } catch (error) {
          if (error instanceof OpenRouterAgentError) providerError = error;
          throw error;
        }
      },
    };
    let outcome: LoopOutcome;
    try {
      outcome = await runLoop(task.prompt, trackedModel, registry, { maxSteps: task.maxRequests });
    } catch (error) {
      if (error instanceof OpenRouterAgentError) providerError = error;
      const code = providerError
        ? providerFailureCode(providerError, state.ceilingExceeded)
        : 'case_execution_failed';
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (providerError) {
      const code = providerFailureCode(providerError, state.ceilingExceeded);
      abortCode = code;
      abortTaskId = task.id;
      results.push(caseError(task.id, code, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let checkedOutcome: LoopOutcome;
    try {
      checkedOutcome = validateLoopOutcome(task, outcome);
    } catch {
      abortCode = 'loop_outcome_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    if (!checkedOutcome.ok) {
      abortCode = checkedOutcome.outcome === 'max_steps'
        ? 'loop_max_steps'
        : 'loop_contract_failure';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let observation: CorpusObservation;
    try {
      observation = observationFromLoopOutcome(task, checkedOutcome);
    } catch (error) {
      const observedCode = error instanceof OfflineCorpusEvalError
        ? error.code
        : 'transcript_malformed';
      abortCode = observedCode === 'loop_outcome_invalid'
        ? 'loop_outcome_invalid'
        : 'transcript_malformed';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    let score: CorpusCaseScore;
    try {
      score = scoreObservation(task, observation);
      validateCorpusScoreV2(score, task.id);
    } catch {
      abortCode = 'score_contract_invalid';
      abortTaskId = task.id;
      results.push(caseError(task.id, abortCode, state.externalRequests - caseStart));
      for (const later of tasks.slice(index + 1)) results.push(notRun(later.id));
      break;
    }
    results.push({
      taskId: task.id,
      status: score.passed ? 'passed' : 'failed',
      finalText: observation.finalText,
      requestCount: observation.requestCount,
      toolEvents: observation.toolEvents,
      submission: observation.submission,
      score,
    });
  }
  const report = reportForV2(corpus, suite, state, results, abortCode, abortTaskId);
  try {
    return validateLiveCorpusEvalReportV2(report, corpus);
  } catch {
    throw new LiveCorpusEvalError('report_contract_invalid');
  }
};

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
