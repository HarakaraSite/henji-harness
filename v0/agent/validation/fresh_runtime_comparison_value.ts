import {
  AgentFreshRuntimeComparisonError,
  type FreshRuntimeComparisonExecutionPosition,
  type FreshRuntimeComparisonFailurePhase,
  type FreshRuntimeComparisonTestHooks,
} from './fresh_runtime_comparison_contract.ts';

export const invalid = (): never => {
  throw new AgentFreshRuntimeComparisonError();
};

export const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

export const exactDataProperties = (
  value: Record<string, unknown>,
  names: readonly string[],
): boolean => {
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0 || ownNames.length !== names.length ||
    ownNames.some((name, index) => name !== names[index])
  ) return false;
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
  });
};

export const exactArray = (value: unknown): value is readonly unknown[] => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  return length !== undefined && 'value' in length && !length.enumerable &&
    length.value === value.length &&
    names.length === value.length + 1 &&
    names.slice(0, -1).every((name, index) => name === String(index)) &&
    names.at(-1) === 'length' && Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable;
    }).every(Boolean);
};

export const normalizeTestHooks = (value: unknown): FreshRuntimeComparisonTestHooks => {
  if (value === undefined) return Object.freeze({});
  if (!plain(value)) return invalid();
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length > 4) return invalid();
  if (
    names.some((name) =>
      name !== 'failure' && name !== 'onConstruct' && name !== 'onRunComplete' &&
      name !== 'onProgress'
    )
  ) return invalid();
  const failure = value.failure;
  if (failure !== undefined) {
    if (
      !plain(failure) || !exactDataProperties(failure, ['phase', 'position']) ||
      ![
        'setup',
        'model',
        'tool',
        'observer',
        'recorder',
        'clock',
        'correlation',
        'partial-second-run',
      ].includes(failure.phase as string) ||
      (failure.position !== 'first' && failure.position !== 'second' && failure.position !== 'any')
    ) return invalid();
  }
  if (value.onConstruct !== undefined && typeof value.onConstruct !== 'function') return invalid();
  if (value.onRunComplete !== undefined && typeof value.onRunComplete !== 'function') {
    return invalid();
  }
  if (value.onProgress !== undefined && typeof value.onProgress !== 'function') return invalid();
  const normalizedFailure = failure === undefined ? undefined : {
    phase: failure.phase as FreshRuntimeComparisonFailurePhase,
    position: failure.position as FreshRuntimeComparisonExecutionPosition | 'any',
  };
  const normalizedOnConstruct = value.onConstruct === undefined
    ? undefined
    : value.onConstruct as FreshRuntimeComparisonTestHooks['onConstruct'];
  const normalizedOnRunComplete = value.onRunComplete === undefined
    ? undefined
    : value.onRunComplete as FreshRuntimeComparisonTestHooks['onRunComplete'];
  const normalizedOnProgress = value.onProgress === undefined
    ? undefined
    : value.onProgress as FreshRuntimeComparisonTestHooks['onProgress'];
  return Object.freeze({
    ...(normalizedFailure === undefined ? {} : { failure: normalizedFailure }),
    ...(normalizedOnConstruct === undefined ? {} : { onConstruct: normalizedOnConstruct }),
    ...(normalizedOnRunComplete === undefined ? {} : { onRunComplete: normalizedOnRunComplete }),
    ...(normalizedOnProgress === undefined ? {} : { onProgress: normalizedOnProgress }),
  });
};

export const failureFor = (
  hooks: FreshRuntimeComparisonTestHooks | undefined,
  phase: FreshRuntimeComparisonFailurePhase,
  position: FreshRuntimeComparisonExecutionPosition | undefined,
): void => {
  const failure = hooks?.failure;
  if (
    failure !== undefined && failure.phase === phase &&
    (failure.position === 'any' || failure.position === position)
  ) throw new AgentFreshRuntimeComparisonError();
};

export const clonePlain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const equalJson = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && equalJson(leftObject[key], rightObject[key])
    );
};
