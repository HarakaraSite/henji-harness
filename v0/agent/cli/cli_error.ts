/** Shared presentation for human CLI failures; machine run records stay in runtime_cli. */
export const cliErrorText = (command: string, message: string, usage = false): string => {
  const invocation = command.length === 0 ? 'hjh' : `hjh ${command}`;
  return `${invocation}: ${message}\n${usage ? `Try '${invocation} --help' for usage.\n` : ''}`;
};

export const cliErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class CliInvocationError extends Error {}

export const commandError = (command: string | undefined, expected: string): CliInvocationError =>
  new CliInvocationError(
    command === undefined
      ? `Missing command; expected ${expected}`
      : `${
        command.startsWith('--') ? 'Unknown option' : 'Unknown command'
      } '${command}'; expected ${expected}`,
  );

/** Parse the named values and switches of one command, retaining actionable failure reasons. */
export const parseCliOptions = (
  args: readonly string[],
  values: readonly string[],
  switches: readonly string[] = [],
): Map<string, string> => {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!values.includes(flag) && !switches.includes(flag)) {
      throw new CliInvocationError(
        `Unknown ${flag.startsWith('--') ? 'option' : 'argument'} '${flag}'`,
      );
    }
    if (result.has(flag)) throw new CliInvocationError(`Duplicate option '${flag}'`);
    if (switches.includes(flag)) {
      result.set(flag, '');
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.length === 0) {
      throw new CliInvocationError(`Missing value for ${flag}`);
    }
    result.set(flag, value);
  }
  return result;
};
