import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { TurnCancelledError } from '../../../v0/agent/core/cancellation.ts';
import { createRunTypescriptTool } from '../../../v0/agent/tools/run_typescript.ts';
import { Registry } from '../../../v0/agent/tools/tools.ts';
import {
  LinuxProcessExecutor,
  sourceProcessRunnerLaunch,
} from '../../../v0/agent/runtime/process_executor.ts';
import type { JsonValue } from '../../../v0/agent/core/contracts.ts';

const workspaceRoot = await Deno.makeTempDir({
  dir: '/tmp',
  prefix: 'henji-i191-',
});
const scratchRoot = await Deno.makeTempDir({
  dir: '/tmp',
  prefix: 'henji-i191-tmp-',
});
const scratch = `${scratchRoot}/scratch.txt`;
const processes = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
const registry = new Registry([
  createRunTypescriptTool({ root: workspaceRoot }, processes),
]);
let callOrdinal = 0;

const dispatch = async (
  argumentsValue: JsonValue,
  signal?: AbortSignal,
) =>
  await registry.dispatch({
    callId: `increment-191-${++callOrdinal}`,
    name: 'run_typescript',
    arguments: argumentsValue,
  }, signal === undefined ? undefined : { signal });

const result = async (argumentsValue: JsonValue): Promise<string> => {
  const response = await dispatch(argumentsValue);
  strictEqual(response.content.outcome, 'success', response.content.text);
  return response.content.text;
};

const failed = async (
  argumentsValue: JsonValue,
  expected?: RegExp,
): Promise<void> => {
  const response = await dispatch(argumentsValue);
  strictEqual(response.content.outcome, 'error', response.content.text);
  match(response.content.text, /^tool execution error:/);
  if (expected !== undefined) match(response.content.text, expected);
};

const waitForFile = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      await Deno.stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Worker did not create ${path}`);
};

try {
  const text = await result({
    code: [
      'type Row = { amount: number };',
      'const rows = (input as { rows: Row[] }).rows;',
      'const total = rows.reduce((sum: number, row: Row) => sum + row.amount, 0);',
      'await Deno.writeTextFile(workspace + "/sum.txt", String(total));',
      'await Deno.writeTextFile((input as { scratch: string }).scratch, String(total));',
      'return { root: workspace, total, scratch: await Deno.readTextFile((input as { scratch: string }).scratch) };',
    ].join('\n'),
    input: { rows: [{ amount: 17 }, { amount: 25 }], scratch },
  });
  deepStrictEqual(JSON.parse(text), {
    root: workspaceRoot,
    total: 42,
    scratch: '42',
  });
  strictEqual(await Deno.readTextFile(`${workspaceRoot}/sum.txt`), '42');
  strictEqual(await Deno.readTextFile(scratch), '42');

  strictEqual(
    await result({
      code: 'if (input !== null) throw new Error("input must default to null");',
    }),
    'null',
  );

  let listeningPort = 0;
  let resolvePort!: (port: number) => void;
  const portReady = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });
  const server = Deno.serve(
    {
      hostname: '127.0.0.1',
      port: 0,
      onListen: ({ port }) => {
        listeningPort = port;
        resolvePort(port);
      },
    },
    () => new Response('localhost response', { headers: { connection: 'close' } }),
  );
  try {
    const port = await portReady;
    const fetched = await result({
      code:
        `const response = await fetch("http://127.0.0.1:${port}/probe"); return await response.text();`,
    });
    strictEqual(fetched, '"localhost response"');
  } finally {
    await server.shutdown();
    await server.finished;
    strictEqual(listeningPort > 0, true);
  }

  // Exercise the runtime resolver, including built-ins already loaded by its trusted driver.
  await Deno.writeTextFile(
    `${workspaceRoot}/non-std.ts`,
    'export const value = 42;',
  );
  for (
    const specifier of [
      'jsr:@deno/graph',
      'https://example.com/module.ts',
      'npm:semver',
      'node:module',
      'node:path',
      'path',
      `file://${workspaceRoot}/non-std.ts`,
      'data:text/javascript,export default 42',
    ]
  ) {
    await failed(
      { code: `return await import(${JSON.stringify(specifier)});` },
      /Only Deno std imports/,
    );
  }
  await failed({
    code:
      'const url = URL.createObjectURL(new Blob(["export default 42"])); return await import(url);',
  }, /Only Deno std imports/);
  await failed({
    code:
      'new Worker(URL.createObjectURL(new Blob(["self.postMessage(42)"])), { type: "module" });',
  }, /Worker is not a constructor/);
  strictEqual(
    await result({ code: 'return typeof closeHooks;' }),
    '"undefined"',
  );
  strictEqual(await result({ code: 'return eval("6 * 7");' }), '42');

  await failed({ code: 'const = ;' });
  strictEqual(
    await result({ code: 'return "after syntax error";' }),
    '"after syntax error"',
  );
  await failed({ code: 'throw new Error("execution failure");' });
  strictEqual(
    await result({ code: 'return "after runtime error";' }),
    '"after runtime error"',
  );
  await failed({ code: 'return 1n;' });
  strictEqual(
    await result({ code: 'return "after JSON error";' }),
    '"after JSON error"',
  );

  const running = new AbortController();
  const cancellation = dispatch({
    code: 'await Deno.writeTextFile(workspace + "/running", "started"); while (true) {};',
  }, running.signal);
  await waitForFile(`${workspaceRoot}/running`);
  running.abort();
  await matchCancellation(cancellation);
  strictEqual(processes.activeOperations, 0);
  strictEqual(
    await result({ code: 'return "after cancellation";' }),
    '"after cancellation"',
  );

  const setupCancellation = new AbortController();
  const preparing = dispatch({
    code: 'await Deno.writeTextFile(workspace + "/must-not-run", "unexpected"); return 42;',
  }, setupCancellation.signal);
  // The module cache is prepared asynchronously before the call's Workers start.
  setupCancellation.abort();
  await matchCancellation(preparing);
  try {
    await Deno.stat(`${workspaceRoot}/must-not-run`);
    throw new Error('cancelled preparation still ran code');
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  strictEqual(
    await result({ code: 'return "after setup cancellation";' }),
    '"after setup cancellation"',
  );

  await registry.close();
  console.log('increment-191 executor passed');
} finally {
  await registry.close();
  await processes.close();
  await Deno.remove(workspaceRoot, { recursive: true });
  await Deno.remove(scratchRoot, { recursive: true });
}

async function matchCancellation(promise: Promise<unknown>): Promise<void> {
  let received: unknown;
  try {
    await promise;
  } catch (error) {
    received = error;
  }
  ok(
    received instanceof TurnCancelledError,
    `expected TurnCancelledError, got ${String(received)}`,
  );
}
