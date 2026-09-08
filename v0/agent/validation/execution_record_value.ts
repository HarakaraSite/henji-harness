import type { AgentReplayEnvelopeV1 } from '../session/replay_envelope.ts';
import {
  AgentExecutionRecordError,
  type AgentExecutionRoleCounts,
  type ExecutionRole,
} from './execution_record_contract.ts';

export const invalid = (): never => {
  throw new AgentExecutionRecordError();
};

export const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

export const ownDataKeys = (value: Record<string, unknown>, names: readonly string[]): boolean => {
  const keys = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || keys.length !== names.length) {
    return false;
  }
  if (keys.some((key, index) => key !== names[index])) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

export const arrayData = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.getOwnPropertyNames(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  return length !== undefined && 'value' in length && !length.enumerable &&
    length.value === value.length &&
    keys.length === value.length + 1 && keys[keys.length - 1] === 'length' &&
    keys.slice(0, -1).every((key, index) => key === String(index)) &&
    (() => {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          return false;
        }
      }
      return true;
    })();
};

export const safeInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

export const equalJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const envelopeIdentities = (
  envelope: AgentReplayEnvelopeV1,
): {
  envelope: string;
  manifest: string;
  maxSteps: number;
  maxExternal: number;
  maxWall: number;
} => {
  if (
    !plain(envelope) || typeof envelope.identity !== 'string' ||
    typeof envelope.manifest?.identity !== 'string'
  ) return invalid();
  return {
    envelope: envelope.identity,
    manifest: envelope.manifest.identity,
    maxSteps: envelope.budget.maxSteps,
    maxExternal: envelope.budget.maxExternalRequests,
    maxWall: envelope.budget.maxWallTimeMicros,
  };
};

export const roleCounts = (
  items: readonly { readonly role: ExecutionRole }[],
): AgentExecutionRoleCounts => {
  const parent = items.filter((item) => item.role === 'parent').length;
  const planner = items.filter((item) => item.role === 'planner').length;
  return { parent, planner, aggregate: parent + planner };
};
