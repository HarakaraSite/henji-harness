const render = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
type Assert = (value: unknown, message?: string) => asserts value;
export const assert: Assert = (value, message = 'assertion failed') => {
  if (!value) throw new Error(message);
};
export const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${render(expected)}, received ${render(actual)}`);
  }
};
export const assertThrows = (fn: () => unknown, includes?: string): void => {
  try {
    fn();
  } catch (error) {
    if (includes && !String(error).includes(includes)) throw error;
    return;
  }
  throw new Error('expected throw');
};
