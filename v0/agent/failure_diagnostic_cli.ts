import {
  DenoFailureDiagnosticStore,
  FailureDiagnosticStoreError,
} from './failure_diagnostic_store.ts';
import { isFailureDiagnostic } from './failure_diagnostic.ts';

const encoder = new TextEncoder();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_invocation: 'invalid invocation',
  diagnostic_not_found: 'diagnostic not found',
  diagnostic_busy: 'diagnostic busy',
  diagnostic_invalid: 'diagnostic invalid',
  diagnostic_capacity: 'diagnostic capacity reached',
  diagnostic_io_failure: 'diagnostic I/O failure',
};

export type FailureDiagnosticCliCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'latest' }
  | { readonly kind: 'show'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string };

export class FailureDiagnosticCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'FailureDiagnosticCliInvocationError';
  }
}

export const parseFailureDiagnosticArgs = (
  args: readonly string[],
): FailureDiagnosticCliCommand => {
  if (args.length === 1 && args[0] === 'list') return { kind: 'list' };
  if (args.length === 1 && args[0] === 'latest') return { kind: 'latest' };
  if (
    args.length === 3 && args[0] === 'show' && args[1] === '--id' &&
    UUID_V4.test(args[2])
  ) return { kind: 'show', id: args[2] };
  if (
    args.length === 4 && args[0] === 'delete' && args[1] === '--id' &&
    UUID_V4.test(args[2]) && args[3] === '--yes'
  ) return { kind: 'delete', id: args[2] };
  throw new FailureDiagnosticCliInvocationError();
};

const errorLine = (code: string): string =>
  JSON.stringify({
    ok: false,
    error: {
      code,
      message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.invalid_invocation,
    },
  }) + '\n';

const absolutePath = (value: string): boolean =>
  value.startsWith('/') && value.trim() === value && !value.includes('\0') &&
  !value.includes('\r') && !value.includes('\n');

const resolvePhysicalWorkspace = async (root = Deno.cwd()): Promise<string> => {
  const workspace = await Deno.realPath(root);
  const info = await Deno.lstat(workspace);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error('workspace is not a directory');
  }
  return workspace;
};

const resolveStateRoot = (): string => {
  const supplied = Deno.env.get('HENJI_SESSION_STATE_ROOT');
  if (supplied !== undefined) {
    if (!absolutePath(supplied)) throw new Error('invalid state root');
    return supplied;
  }
  const xdg = Deno.env.get('XDG_STATE_HOME');
  const home = Deno.env.get('HOME');
  const base = xdg !== undefined && xdg.trim() !== ''
    ? xdg
    : home === undefined || home.trim() === ''
    ? ''
    : `${home}/.local/state`;
  if (!absolutePath(base)) throw new Error('invalid state root');
  return `${base}/henji-harness`;
};

export interface FailureDiagnosticCliDependencies {
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
}

const writeOutput = async (
  writer: ((text: string) => void | PromiseLike<void>) | undefined,
  text: string,
  fallback: 'stdout' | 'stderr',
): Promise<void> => {
  if (writer !== undefined) {
    await writer(text);
    return;
  }
  const stream = fallback === 'stdout' ? Deno.stdout : Deno.stderr;
  await stream.write(encoder.encode(text));
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: FailureDiagnosticCliDependencies = {},
): Promise<number> => {
  let command: FailureDiagnosticCliCommand;
  try {
    command = parseFailureDiagnosticArgs(args);
  } catch {
    await writeOutput(
      dependencies.writeStderr,
      errorLine('invalid_invocation'),
      'stderr',
    );
    return 1;
  }
  try {
    const workspace = await resolvePhysicalWorkspace(
      dependencies.workspaceRoot,
    );
    const stateRoot = dependencies.stateRoot ?? resolveStateRoot();
    const store = new DenoFailureDiagnosticStore(stateRoot, workspace);
    if (command.kind === 'list') {
      const diagnostics = await store.list();
      if (!diagnostics.every(isFailureDiagnostic)) {
        throw new FailureDiagnosticStoreError('diagnostic_invalid');
      }
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify({ schemaVersion: 1, diagnostics })}\n`,
        'stdout',
      );
    } else if (command.kind === 'latest') {
      const diagnostics = await store.list();
      const latest = diagnostics.at(-1);
      if (latest === undefined) {
        throw new FailureDiagnosticStoreError('diagnostic_not_found');
      }
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify(latest)}\n`,
        'stdout',
      );
    } else if (command.kind === 'show') {
      const diagnostic = await store.read(command.id);
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify(diagnostic)}\n`,
        'stdout',
      );
    } else {
      await store.delete(command.id);
      await writeOutput(
        dependencies.writeStdout,
        `${JSON.stringify({ ok: true, deleted: command.id })}\n`,
        'stdout',
      );
    }
    return 0;
  } catch (error) {
    const code = error instanceof FailureDiagnosticStoreError
      ? error.code
      : 'diagnostic_io_failure';
    await writeOutput(dependencies.writeStderr, errorLine(code), 'stderr');
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
