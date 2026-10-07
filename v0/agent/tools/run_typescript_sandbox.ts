export class RunTypescriptSandboxDeniedError extends Error {
  constructor(entry: string) {
    super(`run_typescript code references denied path "${entry}"`);
    this.name = 'RunTypescriptSandboxDeniedError';
  }
}

/** Best-effort audit: reject a call whose code text names a denied path. */
export const assertRunTypescriptCodeAllowed = (
  code: string,
  deniedPaths: readonly string[],
): void => {
  for (const denied of deniedPaths) {
    if (code.includes(denied)) throw new RunTypescriptSandboxDeniedError(denied);
  }
};
