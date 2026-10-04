import {
  cliErrorMessage,
  cliErrorText,
  CliInvocationError,
  commandError,
  parseCliOptions,
} from './cli_error.ts';
import { resolveWorkspace } from '../tools/work_tools.ts';
import { isSessionId, launcherStateRoot, SessionStoreError } from '../session/session_store.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import { HistoryStoreError } from '../history/history_store_contract.ts';

const encoder = new TextEncoder();
const errorMessages: Record<string, string> = {
  invalid_invocation: 'invalid invocation',
  session_not_found: 'session not found',
  session_busy: 'session busy',
  session_invalid: 'session invalid',
  session_limit: 'session limit reached',
  session_io_failure: 'session I/O failure',
};

type SessionCliCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'delete'; readonly id: string };

const parseSessionArgs = (args: readonly string[]): SessionCliCommand => {
  const command = args[0];
  if (command !== 'list' && command !== 'delete') throw commandError(command, 'list or delete');
  const flags = parseCliOptions(
    args.slice(1),
    command === 'delete' ? ['--session'] : [],
    command === 'delete' ? ['--yes'] : [],
  );
  if (command === 'list') return { kind: 'list' };
  const id = flags.get('--session');
  if (id === undefined) throw new CliInvocationError('Missing required --session');
  if (!isSessionId(id)) throw new CliInvocationError('--session must be a full Session UUID');
  if (!flags.has('--yes')) throw new CliInvocationError('Session deletion requires --yes');
  return { kind: 'delete', id };
};

const line = (code: string): string => cliErrorText('sessions', errorMessages[code] ?? code, true);

interface SessionCliDependencies {
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
}

const writeOut = async (
  writer: ((text: string) => void | PromiseLike<void>) | undefined,
  text: string,
  fallback: 'stdout' | 'stderr' = 'stdout',
) => {
  if (writer !== undefined) return await writer(text);
  await (fallback === 'stdout' ? Deno.stdout : Deno.stderr).write(encoder.encode(text));
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: SessionCliDependencies = {},
): Promise<number> => {
  let command: SessionCliCommand;
  try {
    command = parseSessionArgs(args);
  } catch (error) {
    await writeOut(
      dependencies.writeStderr,
      cliErrorText('sessions', cliErrorMessage(error), true),
      'stderr',
    );
    return 1;
  }
  try {
    const workspace = await resolveWorkspace(dependencies.workspaceRoot);
    const stateRoot = dependencies.stateRoot ?? launcherStateRoot();
    const store = new SqliteHistoryStore(stateRoot, workspace.root);
    await store.initialize();
    if (command.kind === 'list') {
      const result = await store.listWorker();
      const payload = result.skippedInvalid === 0
        ? { schemaVersion: 2, sessions: result.sessions }
        : {
          schemaVersion: 2,
          sessions: result.sessions,
          skippedInvalid: result.skippedInvalid,
        };
      await writeOut(dependencies.writeStdout, `${JSON.stringify(payload)}\n`);
    } else {
      await store.delete(command.id);
      await writeOut(
        dependencies.writeStdout,
        `${JSON.stringify({ ok: true, deleted: command.id })}\n`,
      );
    }
    return 0;
  } catch (error) {
    const code = error instanceof SessionStoreError
      ? error.code
      : error instanceof HistoryStoreError
      ? error.code === 'history_busy'
        ? 'session_busy'
        : error.code === 'history_invalid'
        ? 'session_invalid'
        : 'session_io_failure'
      : 'session_io_failure';
    await writeOut(dependencies.writeStderr, line(code), 'stderr');
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
