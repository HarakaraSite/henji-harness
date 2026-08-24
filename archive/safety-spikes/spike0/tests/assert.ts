const format = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => equal(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!equal(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) =>
    equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
  );
};

export const assert = (condition: unknown, message = 'assertion failed'): asserts condition => {
  if (!condition) throw new Error(message);
};

export const assertEquals = (actual: unknown, expected: unknown, message?: string): void => {
  if (!equal(actual, expected)) {
    throw new Error(message ?? `expected ${format(expected)}, received ${format(actual)}`);
  }
};

export const assertNotEquals = (actual: unknown, expected: unknown, message?: string): void => {
  if (equal(actual, expected)) {
    throw new Error(message ?? `values unexpectedly equal ${format(actual)}`);
  }
};

export const assertThrows = (fn: () => unknown, includes?: string): void => {
  try {
    fn();
  } catch (caught) {
    if (includes !== undefined && !String(caught).includes(includes)) {
      throw new Error(`error ${String(caught)} did not include ${includes}`);
    }
    return;
  }
  throw new Error('expected function to throw');
};

export const assertRejects = async (
  fn: () => Promise<unknown>,
  includes?: string,
): Promise<void> => {
  try {
    await fn();
  } catch (caught) {
    if (includes !== undefined && !String(caught).includes(includes)) {
      throw new Error(`error ${String(caught)} did not include ${includes}`);
    }
    return;
  }
  throw new Error('expected promise to reject');
};
