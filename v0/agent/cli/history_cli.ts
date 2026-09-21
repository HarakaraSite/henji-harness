import { launcherStateRoot, sessionPaths } from '../session/session_store_paths.ts';
import { isSessionId } from '../session/session_store_contract.ts';
import { SqliteHistoryV7ProductionStore } from '../history/sqlite_history_v7_production_store.ts';
import { renderCanonicalView, renderSessionView } from '../history/history_view.ts';

const encoder = new TextEncoder();
/** Full UUID or a hex short-id prefix as shown by the TUI footer / session picker. */
const SESSION_REF = /^[0-9a-f][0-9a-f-]{7,}$/iu;
const isFullSessionId = (value: string): boolean => isSessionId(value);

type HistoryView = 'session' | 'canonical' | 'detail';

interface HistoryCliCommand {
  readonly sessionRef?: string;
  readonly latest: boolean;
  readonly view: HistoryView;
}

class HistoryCliInvocationError extends Error {}

export const parseHistoryArgs = (args: readonly string[]): HistoryCliCommand => {
  let sessionRef: string | undefined;
  let latest = false;
  let view: HistoryView = 'session';
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--latest') {
      latest = true;
      continue;
    }
    if (flag === '--session') {
      const value = args[index + 1];
      if (value === undefined || !SESSION_REF.test(value)) throw new HistoryCliInvocationError();
      sessionRef = value;
      index += 1;
      continue;
    }
    if (flag === '--view') {
      const value = args[index + 1];
      if (value !== 'session' && value !== 'canonical' && value !== 'detail') {
        throw new HistoryCliInvocationError();
      }
      view = value;
      index += 1;
      continue;
    }
    throw new HistoryCliInvocationError();
  }
  if (sessionRef !== undefined && latest) throw new HistoryCliInvocationError();
  return { ...(sessionRef === undefined ? {} : { sessionRef }), latest, view };
};

const writeStdout = async (text: string): Promise<void> => {
  await Deno.stdout.write(encoder.encode(text));
};

const writeStderr = async (text: string): Promise<void> => {
  await Deno.stderr.write(encoder.encode(text));
};

const invalidInvocation = async (): Promise<number> => {
  await writeStderr(
    `${
      JSON.stringify({
        ok: false,
        error: { code: 'invalid_invocation', message: 'invalid invocation' },
      })
    }\n`,
  );
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
  } catch {
    return await invalidInvocation();
  }
  const workspaceRoot = Deno.cwd();
  let stateRoot: string;
  try {
    stateRoot = launcherStateRoot();
  } catch {
    return await invalidInvocation();
  }
  let databasePath: string;
  try {
    databasePath = `${(await sessionPaths(stateRoot, workspaceRoot)).root}/history-v7.sqlite3`;
  } catch {
    return await invalidInvocation();
  }
  if (!(await fileExists(databasePath))) {
    await writeStderr('# no history\n');
    return 0;
  }
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, { readOnly: true });
  try {
    await store.initialize();
  } catch {
    await writeStderr('history read failed\n');
    return 1;
  }
  let sessionId = command.sessionRef;
  if (sessionId === undefined) {
    try {
      sessionId = (await store.listWorker()).sessions[0]?.id;
    } catch {
      await writeStderr('history read failed\n');
      return 1;
    }
  } else if (!isFullSessionId(sessionId)) {
    try {
      const prefix = sessionId.toLowerCase();
      const matches = (await store.listWorker()).sessions.filter((entry) =>
        entry.id.startsWith(prefix)
      );
      sessionId = matches.length === 1 ? matches[0].id : undefined;
    } catch {
      await writeStderr('history read failed\n');
      return 1;
    }
    if (sessionId === undefined) {
      await writeStderr('history session not found or ambiguous\n');
      return 1;
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
    const record = await store.readWorker(sessionId);
    await writeStdout(
      command.view === 'canonical'
        ? renderCanonicalView(record, workspaceRoot)
        : renderSessionView(record),
    );
    return 0;
  } catch {
    await writeStderr('history read failed\n');
    return 1;
  }
};
