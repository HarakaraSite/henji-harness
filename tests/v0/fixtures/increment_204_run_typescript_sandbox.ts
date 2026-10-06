import { match, strictEqual } from 'node:assert';
import { createRunTypescriptTool } from '../../../v0/agent/tools/run_typescript.ts';
import { Registry } from '../../../v0/agent/tools/tools.ts';
import {
  LinuxProcessExecutor,
  sourceProcessRunnerLaunch,
} from '../../../v0/agent/runtime/process_executor.ts';
import type { JsonValue } from '../../../v0/agent/core/contracts.ts';

// The fixture root stays outside /tmp: /tmp is always readable and writable for run_typescript, so a
// /tmp-based root could not prove that the config root and the configured allow path are admitted.
const root = await Deno.makeTempDir({ dir: '/var/tmp', prefix: 'henji-i204-' });
const workspaceRoot = `${root}/workspace`;
const configRoot = `${root}/config/henji-harness`;
const extraRoot = `${root}/extra`;
const credentialRoot = Deno.args[0];
if (credentialRoot === undefined || !credentialRoot.startsWith('/')) {
  throw new Error('the credential root argument is required');
}
await Deno.mkdir(`${configRoot}/agents`, { recursive: true });
await Deno.mkdir(workspaceRoot, { recursive: true });
await Deno.mkdir(extraRoot, { recursive: true });
await Deno.writeTextFile(`${configRoot}/instruction.md`, 'i204 config instruction\n');
await Deno.writeTextFile(`${configRoot}/agents/reviewer.json`, '{"name":"reviewer"}\n');
await Deno.writeTextFile(`${configRoot}/denied-by-config.txt`, 'i204 denied content\n');
await Deno.writeTextFile(`${extraRoot}/data.txt`, 'i204 extra data\n');
await Deno.writeTextFile(`${workspaceRoot}/workspace.txt`, 'i204 workspace data\n');

const processes = new LinuxProcessExecutor(sourceProcessRunnerLaunch());
const registry = new Registry([
  createRunTypescriptTool({ root: workspaceRoot }, processes, {
    configRoot,
    allowedPaths: [extraRoot],
    deniedPaths: [
      `${configRoot}/denied-by-config.txt`,
      '~/.config/henji-harness/denied-by-config.txt',
    ],
  }),
]);
let callOrdinal = 0;

const dispatch = async (argumentsValue: JsonValue) =>
  await registry.dispatch({
    callId: `increment-204-${++callOrdinal}`,
    name: 'run_typescript',
    arguments: argumentsValue,
  });

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

try {
  strictEqual(
    await result({
      code:
        'return { root: henjiConfigRoot, instruction: await Deno.readTextFile(henjiConfigRoot + "/instruction.md") };',
    }),
    JSON.stringify({
      root: configRoot,
      instruction: 'i204 config instruction\n',
    }),
  );

  await result({
    code:
      'await Deno.writeTextFile(henjiConfigRoot + "/written.txt", "i204 written"); return "written";',
  });
  strictEqual(await Deno.readTextFile(`${configRoot}/written.txt`), 'i204 written');

  strictEqual(
    await result({
      code: 'return await Deno.readTextFile(workspace + "/workspace.txt");',
    }),
    '"i204 workspace data\\n"',
  );

  strictEqual(
    await result({
      code:
        'return await Deno.readTextFile(henjiConfigRoot.replace("/config/henji-harness", "/extra") + "/data.txt");',
    }),
    '"i204 extra data\\n"',
  );

  // The credential root stays outside every permission list, so Deno denies both directions even
  // when the code composes the path instead of naming it.
  await failed({
    code: `return await Deno.readTextFile(${JSON.stringify(`${credentialRoot}/openai-api-key`)});`,
  }, /NotCapable/);
  await failed({
    code: `await Deno.writeTextFile(${
      JSON.stringify(`${credentialRoot}/written-key`)
    }, "x"); return "written";`,
  }, /NotCapable/);
  await failed({
    code: `return await Deno.readTextFile(${
      JSON.stringify(`${credentialRoot}/chatgpt-account.json`)
    });`,
  }, /NotCapable/);

  // A denied path named in the code is rejected before the call spawns code. The first entry sits
  // inside the allowed config root, so the audit is the only boundary that blocks it.
  await failed({
    code: `return await Deno.readTextFile(${
      JSON.stringify(`${configRoot}/denied-by-config.txt`)
    });`,
  }, /references denied path/);
  await failed({
    code: `await Deno.writeTextFile(${
      JSON.stringify(`${configRoot}/denied-by-config.txt`)
    }, "x"); return "written";`,
  }, /references denied path/);
  await failed({
    code: 'return await Deno.readTextFile("~/.config/henji-harness/denied-by-config.txt");',
  }, /references denied path "~\/\.config\/henji-harness\/denied-by-config\.txt"/);

  strictEqual(
    await Deno.readTextFile(`${configRoot}/denied-by-config.txt`),
    'i204 denied content\n',
    'denied code must not run',
  );

  await registry.close();
  console.log('increment-204 sandbox passed');
} finally {
  await registry.close();
  await processes.close();
  await Deno.remove(root, { recursive: true });
}
