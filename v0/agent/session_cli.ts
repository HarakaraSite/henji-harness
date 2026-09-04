import { resolveWorkspace } from './work_tools.ts';
import {
  DenoSessionStore,
  isSessionId,
  launcherStateRoot,
  SessionStoreError,
} from './session_store.ts';

const encoder = new TextEncoder();
const errorMessages: Record<string, string> = {
  invalid_invocation: 'invalid invocation',
  session_not_found: 'session not found',
  session_busy: 'session busy',
  session_invalid: 'session invalid',
  session_limit: 'session limit reached',
  session_io_failure: 'session I/O failure',
};

export type SessionCliCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'delete'; readonly id: string };

export class SessionCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'SessionCliInvocationError';
  }
}

export const parseSessionArgs = (
  args: readonly string[],
): SessionCliCommand => {
  if (args.length === 1 && args[0] === 'list') return { kind: 'list' };
  if (
    args.length === 4 && args[0] === 'delete' && args[1] === '--session' &&
    isSessionId(args[2]) && args[3] === '--yes'
  ) return { kind: 'delete', id: args[2] };
  throw new SessionCliInvocationError();
};

const line = (code: string): string =>
  JSON.stringify({
    ok: false,
    error: { code, message: errorMessages[code] ?? 'invalid invocation' },
  }) +
  '\n';

export interface SessionCliDependencies {
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
  readonly workspaceRoot?: string;
  readonly stateRoot?: string;
}

const writeOut = async (
  writer: ((text: string) => void | PromiseLike<void>) | undefined,
  text: string,
) => {
  if (writer !== undefined) return await writer(text);
  await Deno.stdout.write(encoder.encode(text));
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: SessionCliDependencies = {},
): Promise<number> => {
  let command: SessionCliCommand;
  try {
    command = parseSessionArgs(args);
  } catch {
    await writeOut(dependencies.writeStderr, line('invalid_invocation'));
    return 1;
  }
  try {
    const workspace = await resolveWorkspace(dependencies.workspaceRoot);
    const stateRoot = dependencies.stateRoot ?? launcherStateRoot();
    const store = new DenoSessionStore(stateRoot, workspace.root);
    if (command.kind === 'list') {
      const result = await store.listWorker();
      const hasV2 = result.sessions.some((session) => session.definition !== undefined);
      if (!hasV2) {
        const legacy = await store.list();
        const payload = legacy.skippedInvalid === 0
          ? { schemaVersion: 1, sessions: legacy.sessions }
          : {
            schemaVersion: 1,
            sessions: legacy.sessions,
            skippedInvalid: legacy.skippedInvalid,
          };
        await writeOut(
          dependencies.writeStdout,
          `${JSON.stringify(payload)}\n`,
        );
      } else {
        const payload = result.skippedInvalid === 0
          ? { schemaVersion: 2, sessions: result.sessions }
          : {
            schemaVersion: 2,
            sessions: result.sessions,
            skippedInvalid: result.skippedInvalid,
          };
        await writeOut(
          dependencies.writeStdout,
          `${JSON.stringify(payload)}\n`,
        );
      }
    } else {
      await store.delete(command.id);
      await writeOut(
        dependencies.writeStdout,
        `${JSON.stringify({ ok: true, deleted: command.id })}\n`,
      );
    }
    return 0;
  } catch (error) {
    const code = error instanceof SessionStoreError ? error.code : 'session_io_failure';
    await writeOut(dependencies.writeStderr, line(code));
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
