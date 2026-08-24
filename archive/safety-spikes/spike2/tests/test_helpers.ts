export function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new Error(message);
}

export const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
};

export const assertThrows = (
  action: () => unknown,
  expected?: string,
): Error => {
  try {
    action();
  } catch (error) {
    assert(error instanceof Error, 'non-Error thrown');
    if (expected !== undefined) assertEquals(error.message, expected);
    return error;
  }
  throw new Error('expected function to throw');
};

export const assertRejects = async (
  action: () => Promise<unknown>,
  expected?: string,
): Promise<Error> => {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error, 'non-Error thrown');
    if (expected !== undefined) assertEquals(error.message, expected);
    return error;
  }
  throw new Error('expected promise to reject');
};
