import { cliErrorMessage, cliErrorText } from './cli_error.ts';
import { launcherStateRoot, sessionPaths } from '../session/session_store_paths.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import { HenjiApiClient } from '../../api/client.ts';

const encoder = new TextEncoder();
/** Full UUID or a hex short-id prefix as shown by the TUI footer / session picker. */
const SESSION_REF = /^[0-9a-f][0-9a-f-]{7,}$/iu;

type HistoryView = 'session' | 'canonical' | 'detail';

interface HistoryCliCommand {
  readonly connect?: string;
  readonly sessionRef?: string;
  readonly latest: boolean;
  readonly view: HistoryView;
}

class HistoryCliInvocationError extends Error {}

export const parseHistoryArgs = (args: readonly string[]): HistoryCliCommand => {
  let connect: string | undefined;
  let sessionRef: string | undefined;
  let latest = false;
  let view: HistoryView = 'session';
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--connect') {
      const value = args[index + 1];
      if (connect !== undefined) throw new HistoryCliInvocationError('Duplicate --connect');
      if (value === undefined || value.startsWith('--')) {
        throw new HistoryCliInvocationError('Missing value for --connect');
      }
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new HistoryCliInvocationError('--connect must be an HTTP or HTTPS URL');
        }
      } catch {
        throw new HistoryCliInvocationError('--connect must be an HTTP or HTTPS URL');
      }
      connect = value;
      index += 1;
      continue;
    }
    if (flag === '--latest') {
      latest = true;
      continue;
    }
    if (flag === '--session') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new HistoryCliInvocationError('Missing value for --session');
      }
      if (!SESSION_REF.test(value)) {
        throw new HistoryCliInvocationError(
          '--session must be a full Session UUID or a hex prefix of at least 8 characters',
        );
      }
      sessionRef = value;
      index += 1;
      continue;
    }
    if (flag === '--view') {
      const value = args[index + 1];
      if (value !== 'session' && value !== 'canonical' && value !== 'detail') {
        throw new HistoryCliInvocationError(
          value === undefined || value.startsWith('--')
            ? 'Missing value for --view'
            : '--view must be session, canonical or detail',
        );
      }
      view = value;
      index += 1;
      continue;
    }
    throw new HistoryCliInvocationError(`Unknown option '${flag}'`);
  }
  if (sessionRef !== undefined && latest) {
    throw new HistoryCliInvocationError('--session and --latest are mutually exclusive');
  }
  return {
    ...(connect === undefined ? {} : { connect }),
    ...(sessionRef === undefined ? {} : { sessionRef }),
    latest,
    view,
  };
};

const writeStdoutBytes = async (bytes: Uint8Array): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await Deno.stdout.write(bytes.subarray(offset));
    if (written <= 0) throw new Error('history output failed');
    offset += written;
  }
};

const writeStderr = async (text: string): Promise<void> => {
  await Deno.stderr.write(encoder.encode(text));
};

const fail = async (error: unknown, usage = false): Promise<number> => {
  await writeStderr(cliErrorText('history', cliErrorMessage(error), usage));
  return 1;
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Read-only history viewer: `henji history [--session <id>|--latest] [--view session|canonical|detail]`. */
export const main = async (args: readonly string[]): Promise<number> => {
  let command: HistoryCliCommand;
  try {
    command = parseHistoryArgs(args);
  } catch (error) {
    return await fail(error, true);
  }
  if (command.connect !== undefined) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const history = await new HenjiApiClient(command.connect).historyStream(command);
      await writeStderr(
        history.sessionId === null ? '# no history\n' : `# session ${history.sessionId}\n`,
      );
      reader = history.stream.getReader();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        await writeStdoutBytes(item.value);
      }
      return 0;
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      return await fail(error);
    } finally {
      reader?.releaseLock();
    }
  }
  const workspaceRoot = Deno.cwd();
  let stateRoot: string;
  try {
    stateRoot = launcherStateRoot();
  } catch (error) {
    return await fail(error);
  }
  let databasePath: string;
  try {
    databasePath = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history.sqlite3`;
  } catch (error) {
    return await fail(error);
  }
  if (!(await fileExists(databasePath))) {
    await writeStderr('# no history\n');
    return 0;
  }
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot, { readOnly: true });
  try {
    await store.initialize();
  } catch (error) {
    return await fail(error);
  }
  const input = {
    ...(command.sessionRef === undefined ? {} : { sessionRef: command.sessionRef }),
    ...(command.latest ? { latest: true } : {}),
    view: command.view,
  } as const;
  let cursor: ReturnType<SqliteHistoryStore['openHistoryText']>;
  try {
    cursor = store.openHistoryText(input, workspaceRoot);
  } catch (error) {
    store.close();
    return await fail(error);
  }
  try {
    await writeStderr(
      cursor.sessionId === null ? '# no history\n' : `# session ${cursor.sessionId}\n`,
    );
    for (;;) {
      const chunk = cursor.read();
      await writeStdoutBytes(chunk.bytes);
      if (chunk.done) break;
    }
    return 0;
  } catch (error) {
    return await fail(error);
  } finally {
    cursor.close();
    store.close();
  }
};
