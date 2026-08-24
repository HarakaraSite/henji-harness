export const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};
export const assertEquals = <T>(actual: T, expected: T, message = 'values are not equal'): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};
export const assertRejects = async (fn: () => Promise<unknown>): Promise<void> => {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(rejected, 'expected rejection');
};
