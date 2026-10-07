import type { Workspace } from './work_tool_contract.ts';
import type { ToolContext } from './tools.ts';
import { TurnCancelledError } from '../core/cancellation.ts';
import { assertRunTypescriptCodeAllowed } from './run_typescript_sandbox.ts';

/** Host-owned additions to the code Worker's permission lists, plus the deny audit entries. */
export interface TypescriptSandboxPaths {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly deny: readonly string[];
  /** Exposed to code as the `henjiConfigRoot` variable; omitted when no config root exists. */
  readonly configRoot?: string;
}

interface WorkerReply {
  readonly ok: boolean;
  readonly result?: string;
  readonly error?: string;
}

const workerSource = (code: string): string => `
import { stripTypeScriptTypes } from 'node:module';
import { installModuleHooks } from ${
  JSON.stringify(new URL('./run_typescript_hooks.ts', import.meta.url).href)
};
const maximumResultBytes = 1024 * 1024;
const resultTruncationMarker = '\\n[truncated: result exceeded 1 MiB]';
const resultTruncationMarkerBytes = resultTruncationMarker.length;
const limitResult = (json) => {
  const prefixLimit = maximumResultBytes - resultTruncationMarkerBytes;
  let byteLength = 0;
  let prefixEnd = 0;
  for (let index = 0; index < json.length;) {
    const codePoint = json.codePointAt(index) ?? 0;
    index += codePoint > 0xffff ? 2 : 1;
    byteLength += codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
      ? 2
      : codePoint <= 0xffff
      ? 3
      : 4;
    if (byteLength <= prefixLimit) prefixEnd = index;
    if (byteLength > maximumResultBytes) {
      return json.slice(0, prefixEnd) + resultTruncationMarker;
    }
  }
  return json;
};
self.onmessage = async (event) => {
  const { workspace, input, cache, fetchPort, henjiConfigRoot } = event.data;
  const closeHooks = installModuleHooks(cache, fetchPort);
  // Loader hooks are thread-local. Keep all user imports on this thread rather than
  // admitting a new Worker without the std import policy.
  Object.defineProperty(globalThis, 'Worker', { value: undefined, writable: false, configurable: false });
  try {
    // Keep user imports out of source Deno's eager Blob graph, which otherwise mutates its
    // enclosing project's vendor/lock before the call's acquisition hooks are installed.
    const execute = (0, eval)(stripTypeScriptTypes(${
  JSON.stringify(`(async (workspace, input, henjiConfigRoot) => {\n${code}\n})`)
}, { mode: 'transform' }));
    const result = await execute(workspace, input, henjiConfigRoot);
    const json = JSON.stringify(result ?? null);
    if (json === undefined) throw new TypeError('result is not JSON serializable');
    self.postMessage({ ok: true, result: limitResult(json) });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.name + ': ' + error.message : String(error),
    });
  } finally {
    closeHooks();
  }
};
`;

export const executeTypescriptBody = async (
  code: string,
  workspace: Workspace,
  input: unknown,
  sandbox: TypescriptSandboxPaths,
  context?: ToolContext,
): Promise<string> => {
  assertRunTypescriptCodeAllowed(code, sandbox.deny);
  const readPaths = [...sandbox.read];
  const writePaths = [...sandbox.write];
  const cache = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-typescript-',
  });
  if (context?.signal?.aborted) throw new TurnCancelledError();
  const source = workerSource(code);
  const url = URL.createObjectURL(
    new Blob([source], { type: 'application/javascript' }),
  );
  const signal = context?.signal;
  let worker: Worker | undefined;
  let fetcher: Worker | undefined;
  let fetchTerminated = false;
  let channel: MessageChannel | undefined;
  let terminated = false;
  let onAbort: (() => void) | undefined;
  const terminate = (): void => {
    if (fetcher !== undefined && !fetchTerminated) {
      fetchTerminated = true;
      fetcher.terminate();
    }
    if (worker !== undefined && !terminated) {
      terminated = true;
      worker.terminate();
    }
  };

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (settlement: () => void): void => {
      if (settled) return;
      settled = true;
      settlement();
    };
    const cancel = (): void => {
      terminate();
      settle(() => reject(new TurnCancelledError()));
    };
    onAbort = cancel;

    try {
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }

      channel = new MessageChannel();
      fetcher = new Worker(
        new URL('./run_typescript_fetch_worker.ts', import.meta.url),
        {
          type: 'module',
          deno: {
            permissions: {
              read: ['/tmp'],
              write: ['/tmp'],
              net: true,
              env: false,
              run: false,
              sys: false,
              ffi: false,
            },
          },
        },
      );
      fetcher.onerror = (event) => {
        event.preventDefault();
        settle(() =>
          reject(
            new Error(event.message || 'TypeScript module acquisition failed'),
          )
        );
      };
      fetcher.onmessageerror = () => {
        settle(() =>
          reject(
            new Error(
              'TypeScript module acquisition message could not be transferred',
            ),
          )
        );
      };
      if (signal?.aborted) {
        cancel();
        return;
      }
      fetcher.postMessage({ port: channel.port1 }, [channel.port1]);

      worker = new Worker(url, {
        type: 'module',
        deno: {
          permissions: {
            // Module replies and std sources are internal IO for this call, not user-file roots.
            read: [...new Set([...readPaths, cache])],
            write: writePaths,
            net: true,
            env: false,
            run: false,
            sys: false,
            ffi: false,
          },
        },
      });
      worker.onerror = (event) => {
        event.preventDefault();
        settle(() => reject(new Error(event.message || 'TypeScript Worker failed')));
      };
      worker.onmessageerror = () => {
        settle(() => reject(new Error('TypeScript Worker result could not be transferred')));
      };
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const reply = event.data;
        if (reply?.ok === true && typeof reply.result === 'string') {
          settle(() => resolve(reply.result!));
        } else {
          settle(() =>
            reject(
              new Error(
                reply?.error ?? 'TypeScript Worker returned an invalid result',
              ),
            )
          );
        }
      };

      // A signal can be aborted while Worker construction is in progress. Re-check after the
      // listener and Worker exist so that startup cancellation both settles and terminates it.
      if (signal?.aborted) {
        cancel();
        return;
      }
      worker.postMessage({
        workspace: workspace.root,
        input,
        cache,
        fetchPort: channel.port2,
        ...(sandbox.configRoot === undefined ? {} : { henjiConfigRoot: sandbox.configRoot }),
      }, [
        channel.port2,
      ]);
    } catch (error) {
      settle(() => reject(error));
    }
  }).finally(() => {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    try {
      terminate();
    } finally {
      URL.revokeObjectURL(url);
    }
  });
};
