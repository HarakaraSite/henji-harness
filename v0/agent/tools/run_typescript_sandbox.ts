/**
 * Host-owned sandbox additions and best-effort deny audit for `run_typescript`.
 *
 * `allow` entries extend the code Worker's Deno read/write permission lists. `deny` entries are
 * checked against the code text before execution, because the Deno Worker permission model has no
 * deny list; the audit is best-effort and cannot see dynamically composed paths.
 */

const SANDBOX_CONFIG_FILE = 'run-typescript.json';

export interface RunTypescriptSandbox {
  /** Absolute paths added to both permission lists of the code Worker. */
  readonly allowedPaths: readonly string[];
  /** Strings whose presence in the code rejects the call before execution. */
  readonly deniedPaths: readonly string[];
}

export class RunTypescriptSandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunTypescriptSandboxConfigError';
  }
}

export const emptyRunTypescriptSandbox = (): RunTypescriptSandbox =>
  Object.freeze({ allowedPaths: Object.freeze([]), deniedPaths: Object.freeze([]) });

export const runTypescriptSandboxPath = (configRoot: string): string =>
  `${configRoot}/${SANDBOX_CONFIG_FILE}`;

const invalid: (message: string) => never = (message) => {
  throw new RunTypescriptSandboxConfigError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const trimmed = (value: string): string =>
  value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;

/** Expand one configured path. `~` and `~/…` need a usable HOME; other entries must be absolute. */
const expandEntry = (
  value: unknown,
  home: string | undefined,
): { readonly text: string; readonly absolute: string } => {
  if (typeof value !== 'string') invalid('sandbox path must be a string');
  if (value.length === 0 || value.trim() !== value) {
    invalid('sandbox path must be a non-empty string without surrounding whitespace');
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    invalid('sandbox path must not contain control characters');
  }
  if (value === '~' || value.startsWith('~/')) {
    if (home === undefined || !home.startsWith('/') || home.includes('\0')) {
      invalid('sandbox path uses ~ but HOME is unavailable');
    }
    return {
      text: value,
      absolute: trimmed(value === '~' ? home : `${home}/${value.slice(2)}`),
    };
  }
  if (!value.startsWith('/')) invalid('sandbox path must be absolute or start with ~/');
  return { text: value, absolute: trimmed(value) };
};

const entriesOf = (
  value: unknown,
  label: string,
  home: string | undefined,
): readonly { readonly text: string; readonly absolute: string }[] => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) invalid(`sandbox ${label} must be an array`);
  return Object.freeze(value.map((entry) => expandEntry(entry, home)));
};

export interface LoadRunTypescriptSandboxOptions {
  /** Defaults to HOME; tests and isolated probes can supply their own value. */
  readonly home?: string;
}

/** Read `${configRoot}/run-typescript.json`. An absent file leaves the default roots only. */
export const loadRunTypescriptSandbox = async (
  configRoot: string | undefined,
  options: LoadRunTypescriptSandboxOptions = {},
): Promise<RunTypescriptSandbox> => {
  if (configRoot === undefined) return emptyRunTypescriptSandbox();
  let text: string;
  try {
    text = await Deno.readTextFile(runTypescriptSandboxPath(configRoot));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return emptyRunTypescriptSandbox();
    throw new RunTypescriptSandboxConfigError('sandbox config could not be read');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid('sandbox config must be valid JSON');
  }
  if (!isRecord(value)) invalid('sandbox config must be an object');
  if (value.schemaVersion !== 1) invalid('sandbox config schemaVersion must be 1');
  const home = options.home ?? Deno.env.get('HOME');
  const allow = entriesOf(value.allow, 'allow', home);
  const deny = entriesOf(value.deny, 'deny', home);
  const allowedPaths: string[] = [];
  for (const entry of allow) {
    if (!allowedPaths.includes(entry.absolute)) allowedPaths.push(entry.absolute);
  }
  const deniedPaths: string[] = [];
  for (const entry of deny) {
    for (const text of [entry.text, entry.absolute]) {
      if (!deniedPaths.includes(text)) deniedPaths.push(text);
    }
  }
  return Object.freeze({
    allowedPaths: Object.freeze(allowedPaths),
    deniedPaths: Object.freeze(deniedPaths),
  });
};

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
