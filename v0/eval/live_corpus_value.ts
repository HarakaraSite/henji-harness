import type { JsonValue } from '../agent/core/contracts.ts';
import type { CorpusTask, ValidatedTaskCorpus } from '../corpus/task_corpus.ts';
import {
  CANONICAL_SUITE,
  CANONICAL_TASK_IDS,
  LiveCorpusEvalError,
  type LiveCorpusSuite,
  type LiveReportSuite,
  type LiveRunnerFailureCode,
  SENTINEL_SUITE,
  SENTINEL_TASK_IDS,
} from './live_corpus_contract.ts';

export const runnerCodes: readonly LiveRunnerFailureCode[] = [
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

export const corpusFailureCodes = new Set([
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

export const equalJson = (left: unknown, right: unknown): boolean => {
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

export const fail = (code: LiveRunnerFailureCode): never => {
  throw new LiveCorpusEvalError(code);
};

export const suiteReportName = (suite: LiveCorpusSuite): LiveReportSuite =>
  suite === 'sentinel' ? SENTINEL_SUITE : CANONICAL_SUITE;

export const suiteRequestCeiling = (suite: LiveCorpusSuite): 12 | 48 =>
  suite === 'sentinel' ? 12 : 48;

export const suiteTaskIds = (suite: LiveCorpusSuite): readonly string[] =>
  suite === 'sentinel' ? SENTINEL_TASK_IDS : CANONICAL_TASK_IDS;

export const suiteTasks = (
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
