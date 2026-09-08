import type { JsonValue } from '../agent/core/contracts.ts';
import {
  OfflineCorpusEvalError,
  type OfflineRunnerFailureCode,
} from './offline_corpus_contract.ts';

export const runnerCodes: readonly OfflineRunnerFailureCode[] = [
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

export const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
};

export const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null || typeof value === 'string' || typeof value === 'boolean'
  ) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

export const equalJson = (left: unknown, right: unknown): boolean => {
  if (typeof left !== typeof right || left === null || right === null) {
    return left === right;
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && equalJson(left[key], right[key]));
};

export const fail = (code: OfflineRunnerFailureCode): never => {
  throw new OfflineCorpusEvalError(code);
};

export const malformed = (): never => fail('transcript_malformed');

export const validateDimension = (value: unknown): void => {
  const object = isRecord(value) ? value : fail('report_contract_invalid');
  if (
    !exactKeys(object, ['passed', 'failureCodes']) ||
    typeof object.passed !== 'boolean'
  ) {
    fail('report_contract_invalid');
  }
  if (!Array.isArray(object.failureCodes)) fail('report_contract_invalid');
  const codes = object.failureCodes as unknown[];
  if (
    codes.some((code: unknown) => typeof code !== 'string' || !corpusFailureCodes.has(code)) ||
    new Set(codes).size !== codes.length ||
    object.passed !== (codes.length === 0)
  ) fail('report_contract_invalid');
};
