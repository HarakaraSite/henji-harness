import { cliErrorMessage, cliErrorText } from './cli_error.ts';
import { launcherStateRoot, sessionPaths } from '../session/session_store_paths.ts';
import { isSessionId } from '../session/session_store_contract.ts';
import { SqliteHistoryStore } from '../history/sqlite_history_store.ts';
import { renderCanonicalView, renderConversationTimeline } from '../history/history_view.ts';
import { HenjiApiClient } from '../../api/client.ts';
import { replaySessionConversation } from '../../conversation/history_adapter.ts';

const encoder = new TextEncoder();
/** Full UUID or a hex short-id prefix as shown by the TUI footer / session picker. */
const SESSION_REF = /^[0-9a-f][0-9a-f-]{7,}$/iu;
const isFullSessionId = (value: string): boolean => isSessionId(value);

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

const writeStdout = async (text: string): Promise<void> => {
  await Deno.stdout.write(encoder.encode(text));
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
    try {
      const history = await new HenjiApiClient(command.connect).historyRead(command);
      await writeStderr(
        history.sessionId === null ? '# no history\n' : `# session ${history.sessionId}\n`,
      );
      await writeStdout(history.text);
      return 0;
    } catch (error) {
      return await fail(error);
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
  let sessionId = command.sessionRef;
  if (sessionId === undefined) {
    try {
      sessionId = (await store.listWorker()).sessions[0]?.id;
    } catch (error) {
      return await fail(error);
    }
  } else if (!isFullSessionId(sessionId)) {
    try {
      const prefix = sessionId.toLowerCase();
      const matches = (await store.listWorker()).sessions.filter((entry) =>
        entry.id.startsWith(prefix)
      );
      sessionId = matches.length === 1 ? matches[0].id : undefined;
    } catch (error) {
      return await fail(error);
    }
    if (sessionId === undefined) {
      return await fail(
        `Session prefix '${command.sessionRef}' was not found or is ambiguous; use 'henji sessions list' to choose a full ID`,
      );
    }
  }
  if (sessionId === undefined) {
    await writeStderr('# no history\n');
    return 0;
  }
  await writeStderr(`# session ${sessionId}\n`);
  try {
    if (command.view === 'detail') {
      for (const record of store.streamHumanHistoryExport(sessionId)) {
        await writeStdout(`${JSON.stringify(record)}\n`);
      }
      return 0;
    }
    if (command.view === 'session') {
      const facts = store.readSessionConversationFacts(sessionId);
      const { state } = replaySessionConversation(sessionId, facts);
      await writeStdout(renderConversationTimeline(state));
    } else {
      const record = await store.readWorker(sessionId);
      await writeStdout(renderCanonicalView(record, workspaceRoot));
    }
    return 0;
  } catch (error) {
    return await fail(error);
  }
};
