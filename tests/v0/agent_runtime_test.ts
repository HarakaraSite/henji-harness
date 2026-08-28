import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  createRuntimeComposition,
  createRuntimeSession,
  MAX_STEPS,
  runRuntime,
  type RuntimeRun,
} from '../../v0/agent/runtime.ts';
import { runAgent } from '../../v0/agent/loop.ts';
import { main, MAX_TASK_BYTES } from '../../v0/agent/runtime_cli.ts';
import {
  type AgentDefinition,
  defaultAgentDefinition,
  plannerAgentDefinition,
} from '../../v0/agent/agent_definition.ts';
import { type BuiltinAgentSelection, resolveBuiltinAgent } from '../../v0/agent/agent_catalog.ts';
import { type OpenRouterAgentProfile } from '../../v0/agent/openrouter_model.ts';
import {
  type SkillCatalog,
  type SkillFileHandle,
  type SkillFileSystem,
  type SkillPathInfo,
} from '../../v0/agent/skills.ts';
import {
  type InstructionFileHandle,
  type InstructionFileInfo,
  type InstructionFileSystem,
} from '../../v0/agent/agent_instructions.ts';
import { type AgentEvent } from '../../v0/agent/events.ts';

const DUMMY_CREDENTIAL = 'offline-dummy-credential';
const encoder = new TextEncoder();

const ALTERNATE_PROFILE: OpenRouterAgentProfile = {
  id: 'offline-runtime-alternate-profile',
  model: 'offline/runtime-alternate-model',
  origin: 'https://runtime-alternate.invalid',
  path: '/custom/chat/completions',
  method: 'POST',
  secretEnv: 'OFFLINE_RUNTIME_ALTERNATE_KEY',
  maxCompletionTokens: 23,
  stream: false,
};

const response = (payload: unknown, status = 200): Response => {
  if (status !== 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const id = 'offline-runtime-response';
  const choices = (payload as { choices?: unknown })?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : undefined;
  const message = typeof choice === 'object' && choice !== null
    ? (choice as { message?: unknown }).message
    : undefined;
  let chunk: unknown = { id, choices };
  let terminalReason: 'stop' | 'tool_calls' = 'stop';
  if (typeof message === 'object' && message !== null) {
    const content = (message as { content?: unknown }).content;
    const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
    if (typeof content === 'string') {
      chunk = {
        id,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
      };
    } else if (Array.isArray(toolCalls)) {
      terminalReason = 'tool_calls';
      chunk = {
        id,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: toolCalls.map((tool, index) => ({
              ...(tool as Record<string, unknown>),
              index,
            })),
          },
          finish_reason: 'tool_calls',
        }],
      };
    }
  }
  const body = `data: ${JSON.stringify(chunk)}\n\n` +
    `data: ${
      JSON.stringify({
        id,
        choices: [{ index: 0, delta: {}, finish_reason: terminalReason }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }\n\n` +
    'data: [DONE]\n\n';
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
};
const finalPayload = (text: string) => ({
  choices: [{ message: { role: 'assistant', content: text } }],
});
const toolPayload = (
  calls: readonly { id: string; name: string; arguments: unknown }[],
) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    },
  }],
});
type FetchCall = { input: RequestInfo | URL; init?: RequestInit };
const fetchSequence = (
  responses: readonly Response[],
  calls: FetchCall[] = [],
): typeof fetch => {
  let index = 0;
  return (input, init) => {
    calls.push({ input, init });
    const next = responses[index++];
    if (!next) throw new Error('unexpected extra request');
    return Promise.resolve(next);
  };
};
const withWorkspace = async <T>(
  fn: (root: string) => Promise<T>,
): Promise<T> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-runtime-' });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};
const run = (
  root: string,
  responses: readonly Response[],
  extra: Record<string, unknown> = {},
) =>
  runRuntime('offline task', {
    workspaceRoot: root,
    fetcher: fetchSequence(responses),
    credential: DUMMY_CREDENTIAL,
    ...extra,
  });
const selectionFor = (
  definition: AgentDefinition,
  id: 'default' | 'planner' = 'default',
): BuiltinAgentSelection => ({
  id,
  definition,
});
const requestBody = (call: FetchCall): Record<string, unknown> => {
  assert(typeof call.init?.body === 'string');
  return JSON.parse(call.init.body) as Record<string, unknown>;
};
const streamFor = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
const runWithOutput = async (
  args: readonly string[],
  options: {
    readonly terminal?: boolean;
    readonly stdin?: Uint8Array;
    readonly run?: (task: string) => Promise<RuntimeRun>;
  } = {},
) => {
  let stdout = '';
  let stderr = '';
  const exit = await main(args, {
    stdinIsTerminal: () => options.terminal ?? false,
    stdin: options.stdin === undefined ? undefined : streamFor(options.stdin),
    run: options.run ?? ((task) =>
      Promise.resolve({
        outcome: {
          ok: true,
          task,
          outcome: 'final',
          stopReason: 'final',
          finalText: 'answer',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
          transcript: [],
        },
        requestCount: 1,
      })),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { exit, stdout, stderr };
};

interface DiscoveryCounts {
  instructionLstat: number;
  instructionOpen: number;
  instructionClose: number;
  skillLstat: number;
  skillReadDirectory: number;
  skillOpen: number;
  skillClose: number;
}

const countingInstructionFileSystem = (
  counts: DiscoveryCounts,
): InstructionFileSystem => ({
  async lstat(path) {
    counts.instructionLstat += 1;
    const info = await Deno.lstat(path);
    return { isFile: info.isFile, isSymlink: info.isSymlink };
  },
  async open(path): Promise<InstructionFileHandle> {
    counts.instructionOpen += 1;
    const file = await Deno.open(path, { read: true });
    return {
      read: (buffer) => file.read(buffer),
      stat: async (): Promise<InstructionFileInfo> => {
        const info = await file.stat();
        return { isFile: info.isFile, isSymlink: info.isSymlink };
      },
      close: () => {
        counts.instructionClose += 1;
        file.close();
      },
    };
  },
});

const countingSkillFileSystem = (counts: DiscoveryCounts): SkillFileSystem => ({
  async lstat(path) {
    counts.skillLstat += 1;
    const info = await Deno.lstat(path);
    return {
      isFile: info.isFile,
      isDirectory: info.isDirectory,
      isSymlink: info.isSymlink,
    };
  },
  async *readDirectory(path) {
    counts.skillReadDirectory += 1;
    for await (const entry of Deno.readDir(path)) yield entry.name;
  },
  async open(path): Promise<SkillFileHandle> {
    counts.skillOpen += 1;
    const file = await Deno.open(path, { read: true });
    return {
      read: (buffer) => file.read(buffer),
      stat: async (): Promise<SkillPathInfo> => {
        const info = await file.stat();
        return {
          isFile: info.isFile,
          isDirectory: info.isDirectory,
          isSymlink: info.isSymlink,
        };
      },
      close: () => {
        counts.skillClose += 1;
        file.close();
      },
    };
  },
});

const delegationPayload = (id: string, task: string) =>
  toolPayload([{ id, name: 'delegate_to_planner', arguments: { task } }]);
const readPayload = (id: string, path: string) =>
  toolPayload([{ id, name: 'read', arguments: { path } }]);
const jsonSubmissionPayload = (id: string, json: string) =>
  toolPayload([{ id, name: 'submit_json_result', arguments: { json } }]);

Deno.test('normal runtime exposes exactly the production six-tool registry', async () => {
  await withWorkspace(async (root) => {
    const calls: FetchCall[] = [];
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('answer'))], calls),
      credential: DUMMY_CREDENTIAL,
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'answer');
    assertEquals(result.requestCount, 1);
    assertEquals(
      (requestBody(calls[0]).tools as Array<Record<string, unknown>>).map((
        tool,
      ) => (tool.function as Record<string, unknown>).name),
      [
        'bash',
        'delegate_to_planner',
        'edit',
        'read',
        'submit_json_result',
        'write',
      ],
    );
    assertEquals(MAX_STEPS, 8);
  });
});

Deno.test('runtime child read then final reports exact lanes and one-time discovery', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/AGENTS.md`, 'runtime instructions');
    await Deno.writeTextFile(`${root}/child.txt`, 'child context');
    await Deno.mkdir(`${root}/.zot/skills/review`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/.zot/skills/review/SKILL.md`,
      '---\ndescription: Review the plan.\n---\nReview body.',
    );
    const counts: DiscoveryCounts = {
      instructionLstat: 0,
      instructionOpen: 0,
      instructionClose: 0,
      skillLstat: 0,
      skillReadDirectory: 0,
      skillOpen: 0,
      skillClose: 0,
    };
    const calls: FetchCall[] = [];
    let credentialCalls = 0;
    const materializedModels: string[] = [];
    const materializedRegistries: string[] = [];
    const result = await runRuntime('parent task', {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(delegationPayload('parent-delegate', 'child read task')),
        response(readPayload('child-read', 'child.txt')),
        response(finalPayload('child read final')),
        response(finalPayload('parent final')),
      ], calls),
      credentialSource: () => {
        credentialCalls += 1;
        return DUMMY_CREDENTIAL;
      },
      instructionFileSystem: countingInstructionFileSystem(counts),
      skillFileSystem: countingSkillFileSystem(counts),
      onModelMaterialized: (definition) => materializedModels.push(definition.registry.kind),
      onRegistryMaterialized: (definition) => materializedRegistries.push(definition.registry.kind),
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'parent final');
    assertEquals(result.outcome.steps, 2);
    assertEquals(result.requestCount, 4);
    assertEquals(calls.length, 4);
    assertEquals(credentialCalls, 4);
    assertEquals(materializedModels, ['production', 'planner']);
    assertEquals(materializedRegistries, ['production', 'planner']);
    assertEquals(counts, {
      instructionLstat: 1,
      instructionOpen: 1,
      instructionClose: 1,
      skillLstat: 5,
      skillReadDirectory: 1,
      skillOpen: 1,
      skillClose: 1,
    });
    const toolMessage = result.outcome.transcript.find((message) => message.role === 'tool');
    assert(toolMessage?.role === 'tool');
    const envelope = JSON.parse(toolMessage.content[0].text) as Record<
      string,
      unknown
    >;
    assertEquals(envelope, {
      ok: true,
      agent: 'planner',
      output: { kind: 'text', text: 'child read final' },
      usage: { modelRequests: 2, externalRequests: 2 },
    });
    const childWire = JSON.stringify(requestBody(calls[1]));
    assert(childWire.includes('child read task'));
    assert(!childWire.includes('parent task'));
  });
});

Deno.test('runtime child terminal JSON stays continuing with exact request counters', async () => {
  await withWorkspace(async (root) => {
    const calls: FetchCall[] = [];
    let credentialCalls = 0;
    const result = await runRuntime('parent JSON task', {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(delegationPayload('parent-delegate', 'child JSON task')),
        response(jsonSubmissionPayload('child-json', '{"key":"value"}')),
        response(finalPayload('parent after JSON')),
      ], calls),
      credentialSource: () => {
        credentialCalls += 1;
        return DUMMY_CREDENTIAL;
      },
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'parent after JSON');
    assertEquals(result.outcome.steps, 2);
    assertEquals(result.requestCount, 3);
    assertEquals(calls.length, 3);
    assertEquals(credentialCalls, 3);
    const toolMessage = result.outcome.transcript.find((message) => message.role === 'tool');
    assert(toolMessage?.role === 'tool');
    assertEquals(JSON.parse(toolMessage.content[0].text), {
      ok: true,
      agent: 'planner',
      output: { kind: 'json', json: '{"key":"value"}' },
      usage: { modelRequests: 1, externalRequests: 1 },
    });
  });
});

Deno.test('runtime child max steps is one bounded failure with no retry', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/child.txt`, 'child context');
    const calls: FetchCall[] = [];
    let credentialCalls = 0;
    const responses: Response[] = [
      response(delegationPayload('parent-delegate', 'long child task')),
    ];
    for (let index = 0; index < 8; index += 1) {
      responses.push(response(readPayload(`child-read-${index}`, 'child.txt')));
    }
    responses.push(response(finalPayload('parent after max steps')));
    const result = await runRuntime('parent task', {
      workspaceRoot: root,
      fetcher: fetchSequence(responses, calls),
      credentialSource: () => {
        credentialCalls += 1;
        return DUMMY_CREDENTIAL;
      },
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'parent after max steps');
    assertEquals(result.outcome.steps, 2);
    assertEquals(result.requestCount, 10);
    assertEquals(calls.length, 10);
    assertEquals(credentialCalls, 10);
    const toolMessage = result.outcome.transcript.find((message) => message.role === 'tool');
    assert(toolMessage?.role === 'tool');
    assertEquals(JSON.parse(toolMessage.content[0].text), {
      ok: false,
      agent: 'planner',
      error: { code: 'planner_failed', message: 'planner delegation failed' },
      usage: { modelRequests: 8, externalRequests: 8 },
    });
  });
});

Deno.test('runtime child missing credential consumes one child claim and no child fetch', async () => {
  await withWorkspace(async (root) => {
    const calls: FetchCall[] = [];
    let credentialCalls = 0;
    const result = await runRuntime('parent task', {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(
          delegationPayload('parent-delegate', 'missing child credential'),
        ),
        response(finalPayload('parent after missing credential')),
      ], calls),
      credentialSource: () => {
        credentialCalls += 1;
        return credentialCalls === 2 ? undefined : DUMMY_CREDENTIAL;
      },
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'parent after missing credential');
    assertEquals(result.outcome.steps, 2);
    assertEquals(result.requestCount, 2);
    assertEquals(calls.length, 2);
    assertEquals(credentialCalls, 3);
    const toolMessage = result.outcome.transcript.find((message) => message.role === 'tool');
    assert(toolMessage?.role === 'tool');
    assertEquals(JSON.parse(toolMessage.content[0].text), {
      ok: false,
      agent: 'planner',
      error: { code: 'planner_failed', message: 'planner delegation failed' },
      usage: { modelRequests: 1, externalRequests: 0 },
    });
  });
});

Deno.test('runtime aggregate seventeenth request fails before credential and fetch', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(`${root}/item.txt`, 'item');
    const calls: FetchCall[] = [];
    let credentialCalls = 0;
    const responses: Response[] = [
      response(delegationPayload('delegate', 'fill child lane')),
    ];
    for (let index = 0; index < 8; index += 1) {
      responses.push(response(readPayload(`child-${index}`, 'item.txt')));
    }
    for (let index = 0; index < 7; index += 1) {
      responses.push(response(readPayload(`parent-${index}`, 'item.txt')));
    }
    const nineStepSelection = selectionFor((input) => ({
      ...defaultAgentDefinition(input),
      maxSteps: 9,
    }));
    const composition = await createRuntimeComposition({
      workspaceRoot: root,
      fetcher: fetchSequence(responses, calls),
      credentialSource: () => {
        credentialCalls += 1;
        return DUMMY_CREDENTIAL;
      },
    }, nineStepSelection);
    const outcome = await runAgent(
      'aggregate limit task',
      composition.model,
      composition.registry,
      {
        maxSteps: composition.maxSteps,
        systemInstruction: composition.systemInstruction,
        executionContext: composition.createTurnExecutionContext(1),
      },
    );
    assert(!outcome.ok);
    assertEquals(outcome.stopReason, 'contract_failure');
    assertEquals(outcome.steps, 8);
    assertEquals(composition.requestCount(), 16);
    assertEquals(calls.length, 16);
    assertEquals(credentialCalls, 16);
  });
});

Deno.test('runtime no-delegation path evaluates one Definition and makes no child request', async () => {
  await withWorkspace(async (root) => {
    let evaluations = 0;
    let credentialCalls = 0;
    const materializedModels: string[] = [];
    const materializedRegistries: string[] = [];
    const calls: FetchCall[] = [];
    const selection = selectionFor((input) => {
      evaluations += 1;
      return defaultAgentDefinition(input);
    });
    const result = await runRuntime('no delegation task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('done'))], calls),
      credentialSource: () => {
        credentialCalls += 1;
        return DUMMY_CREDENTIAL;
      },
      onModelMaterialized: (definition) => materializedModels.push(definition.registry.kind),
      onRegistryMaterialized: (definition) => materializedRegistries.push(definition.registry.kind),
    }, selection);
    assert(result.outcome.ok);
    assertEquals(evaluations, 1);
    assertEquals(result.requestCount, 1);
    assertEquals(calls.length, 1);
    assertEquals(credentialCalls, 1);
    assertEquals(materializedModels, ['production']);
    assertEquals(materializedRegistries, ['production']);
  });
});

Deno.test('planner runtime exposes only read and JSON submission without skills', async () => {
  await withWorkspace(async (root) => {
    const calls: FetchCall[] = [];
    const result = await runRuntime('planner task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('plan'))], calls),
      credential: DUMMY_CREDENTIAL,
    }, resolveBuiltinAgent('planner'));
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'plan');
    const body = requestBody(calls[0]);
    assertEquals(
      (body.tools as Array<Record<string, unknown>>).map((tool) =>
        (tool.function as Record<string, unknown>).name
      ),
      ['read', 'submit_json_result'],
    );
    const system = (body.messages as Array<Record<string, unknown>>)[0];
    assertEquals(system.role, 'system');
    assert((system.content as string).endsWith(
      'You are the built-in planner agent. Inspect the available workspace context needed for the task and produce a clear implementation plan. Do not mutate the workspace.',
    ));
  });
});

Deno.test('planner runtime conditionally exposes saved skill without mutation tools', async () => {
  await withWorkspace(async (root) => {
    await Deno.mkdir(`${root}/.zot/skills/plan`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/.zot/skills/plan/SKILL.md`,
      '---\ndescription: Planning helper.\n---\nPRIVATE-PLANNER-BODY',
    );
    const calls: FetchCall[] = [];
    const result = await runRuntime('planner skill task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('plan'))], calls),
      credential: DUMMY_CREDENTIAL,
    }, resolveBuiltinAgent('planner'));
    assert(result.outcome.ok);
    const body = requestBody(calls[0]);
    assertEquals(
      (body.tools as Array<Record<string, unknown>>).map((tool) =>
        (tool.function as Record<string, unknown>).name
      ),
      ['read', 'skill', 'submit_json_result'],
    );
    const serialized = JSON.stringify(body);
    assert(serialized.includes('Available project skills.'));
    assert(!serialized.includes('PRIVATE-PLANNER-BODY'));
    assert(!serialized.includes('"name":"bash"'));
    assert(!serialized.includes('"name":"edit"'));
    assert(!serialized.includes('"name":"write"'));
  });
});

Deno.test('omitted and explicit default selections produce equivalent normal output wire', async () => {
  await withWorkspace(async (root) => {
    const omittedCalls: FetchCall[] = [];
    const explicitCalls: FetchCall[] = [];
    const omitted = await runRuntime('same task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('same'))], omittedCalls),
      credential: DUMMY_CREDENTIAL,
    });
    const explicit = await runRuntime('same task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('same'))], explicitCalls),
      credential: DUMMY_CREDENTIAL,
    }, resolveBuiltinAgent('default'));
    assert(omitted.outcome.ok && explicit.outcome.ok);
    assertEquals(omitted.outcome, explicit.outcome);
    assertEquals(omittedCalls[0].input, explicitCalls[0].input);
    assertEquals(omittedCalls[0].init?.method, explicitCalls[0].init?.method);
    assertEquals(omittedCalls[0].init?.headers, explicitCalls[0].init?.headers);
    assertEquals(omittedCalls[0].init?.body, explicitCalls[0].init?.body);
  });
});

Deno.test('runtime evaluates an injected Definition once and uses its system instruction', async () => {
  await withWorkspace(async (root) => {
    let evaluations = 0;
    const definition: AgentDefinition = (input) => {
      evaluations += 1;
      return {
        ...defaultAgentDefinition(input),
        systemInstruction: 'injected composition instruction',
        maxSteps: 1,
      };
    };
    const calls: FetchCall[] = [];
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('answer'))], calls),
      credential: DUMMY_CREDENTIAL,
    }, selectionFor(definition));
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'answer');
    assertEquals(result.outcome.steps, 1);
    assertEquals(evaluations, 1);
    assertEquals(
      (requestBody(calls[0]).messages as Array<Record<string, unknown>>)[0],
      {
        role: 'system',
        content: 'injected composition instruction',
      },
    );
  });
});

Deno.test('runtime materializes injected profile and registry declarations', async () => {
  await withWorkspace(async (root) => {
    const customSkillCatalog: SkillCatalog = Object.freeze({
      skills: Object.freeze([{
        name: 'custom-skill',
        description: 'Custom runtime skill.',
        sourceDirectory: '/custom/.zot/skills/custom-skill',
        body: 'custom skill body',
        toolResult: 'custom skill result',
      }]),
      manifest: 'Custom skill manifest',
    });
    let evaluations = 0;
    const definition: AgentDefinition = (input) => {
      evaluations += 1;
      const resolved = defaultAgentDefinition(input);
      return {
        ...resolved,
        model: { provider: 'openrouter', profile: ALTERNATE_PROFILE },
        registry: {
          kind: 'production',
          workspace: input.workspace,
          skillCatalog: customSkillCatalog,
          plannerDelegation: true,
        },
        skillCatalog: customSkillCatalog,
        systemInstruction: 'custom runtime instruction',
        maxSteps: 1,
      };
    };
    const calls: FetchCall[] = [];
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('answer'))], calls),
      credential: DUMMY_CREDENTIAL,
    }, selectionFor(definition));
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'answer');
    assertEquals(evaluations, 1);
    assertEquals(
      calls[0].input,
      'https://runtime-alternate.invalid/custom/chat/completions',
    );
    const body = requestBody(calls[0]);
    assertEquals(body.model, 'offline/runtime-alternate-model');
    assertEquals(body.stream, true);
    assertEquals(body.max_completion_tokens, 23);
    assertEquals(
      (body.messages as Array<Record<string, unknown>>)[0],
      { role: 'system', content: 'custom runtime instruction' },
    );
    assertEquals(
      (body.tools as Array<Record<string, unknown>>).map((tool) =>
        (tool.function as Record<string, unknown>).name
      ),
      [
        'bash',
        'delegate_to_planner',
        'edit',
        'read',
        'skill',
        'submit_json_result',
        'write',
      ],
    );
  });
});

Deno.test('runtime passes Definition maxSteps to the one-shot loop', async () => {
  await withWorkspace(async (root) => {
    const definition: AgentDefinition = (input) => ({
      ...defaultAgentDefinition(input),
      maxSteps: 1,
    });
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(
          toolPayload([{
            id: 'round-1',
            name: 'bash',
            arguments: { command: 'true' },
          }]),
        ),
      ]),
      credential: DUMMY_CREDENTIAL,
    }, selectionFor(definition));
    assert(!result.outcome.ok);
    assertEquals(result.outcome.stopReason, 'max_steps');
    assertEquals(result.outcome.steps, 1);
    assertEquals(result.requestCount, 1);
  });
});

Deno.test('runtime session evaluates its Definition once across two turns', async () => {
  await withWorkspace(async (root) => {
    let evaluations = 0;
    const definition: AgentDefinition = (input) => {
      evaluations += 1;
      return defaultAgentDefinition(input);
    };
    const sessionResult = await createRuntimeSession(() => {}, {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(finalPayload('first answer')),
        response(finalPayload('second answer')),
      ]),
      credential: DUMMY_CREDENTIAL,
    }, selectionFor(definition));
    const first = await sessionResult.session.submit('first task');
    const second = await sessionResult.session.submit('second task');
    assert(first.ok && second.ok);
    assertEquals(first.finalText, 'first answer');
    assertEquals(second.finalText, 'second answer');
    assertEquals(evaluations, 1);
    assertEquals(sessionResult.requestCount(), 2);
  });
});

Deno.test('runtime session admits one planner child independently on each accepted turn', async () => {
  await withWorkspace(async (root) => {
    const responses = [
      response(
        toolPayload([{
          id: 'delegate-1',
          name: 'delegate_to_planner',
          arguments: { task: 'child one' },
        }]),
      ),
      response(finalPayload('plan one')),
      response(finalPayload('parent one')),
      response(
        toolPayload([{
          id: 'delegate-2',
          name: 'delegate_to_planner',
          arguments: { task: 'child two' },
        }]),
      ),
      response(finalPayload('plan two')),
      response(finalPayload('parent two')),
    ];
    const sessionResult = await createRuntimeSession(() => {}, {
      workspaceRoot: root,
      fetcher: fetchSequence(responses),
      credential: DUMMY_CREDENTIAL,
    });
    const first = await sessionResult.session.submit('parent task one');
    const second = await sessionResult.session.submit('parent task two');
    assert(first.ok && second.ok);
    assertEquals(first.finalText, 'parent one');
    assertEquals(second.finalText, 'parent two');
    assertEquals(sessionResult.requestCount(), 6);
  });
});

Deno.test('runtime session busy rejection consumes no context, child, or request', async () => {
  await withWorkspace(async (root) => {
    const sessionResult = await createRuntimeSession(() => {}, {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(delegationPayload('first-delegate', 'first child')),
        response(finalPayload('first child plan')),
        response(finalPayload('first parent')),
        response(finalPayload('second parent')),
      ]),
      credential: DUMMY_CREDENTIAL,
    });
    const firstPromise = sessionResult.session.submit('first task');
    await assertRejects(() => sessionResult.session.submit('busy task'));
    const first = await firstPromise;
    assert(first.ok);
    assertEquals(first.finalText, 'first parent');
    assertEquals(sessionResult.requestCount(), 3);
    const second = await sessionResult.session.submit('second task');
    assert(second.ok);
    assertEquals(second.finalText, 'second parent');
    assertEquals(sessionResult.requestCount(), 4);
  });
});

Deno.test('runtime session failed first turn gets fresh delegation admission and budget', async () => {
  await withWorkspace(async (root) => {
    let credentialCalls = 0;
    const sessionResult = await createRuntimeSession(() => {}, {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(delegationPayload('first-delegate', 'first child')),
        response({ choices: [] }),
        response(delegationPayload('second-delegate', 'second child')),
        response(finalPayload('second child plan')),
        response(finalPayload('second parent')),
      ]),
      credentialSource: () => {
        credentialCalls += 1;
        return credentialCalls === 2 ? undefined : DUMMY_CREDENTIAL;
      },
    });
    const first = await sessionResult.session.submit('first task');
    assert(!first.ok);
    assertEquals(first.stopReason, 'contract_failure');
    assertEquals(sessionResult.session.transcriptSnapshot(), []);
    const second = await sessionResult.session.submit('second task');
    assert(second.ok);
    assertEquals(second.finalText, 'second parent');
    assertEquals(sessionResult.requestCount(), 5);
    assertEquals(credentialCalls, 6);
    assert(JSON.stringify(second.transcript).includes('second child plan'));
    assert(!JSON.stringify(second.transcript).includes('first task'));
  });
});

Deno.test('runtime event failure before parent tool_call starts no child and next turn is fresh', async () => {
  await withWorkspace(async (root) => {
    let failed = false;
    const events: AgentEvent[] = [];
    const sessionResult = await createRuntimeSession((event) => {
      events.push(event);
      if (!failed && event.kind === 'tool_call') {
        failed = true;
        throw new Error('reject before child');
      }
    }, {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(delegationPayload('first-delegate', 'never starts')),
        response(finalPayload('second parent')),
      ]),
      credential: DUMMY_CREDENTIAL,
    });
    await assertRejects(() => sessionResult.session.submit('first task'));
    assertEquals(sessionResult.requestCount(), 1);
    const second = await sessionResult.session.submit('second task');
    assert(second.ok);
    assertEquals(second.finalText, 'second parent');
    assertEquals(sessionResult.requestCount(), 2);
    assertEquals(
      events.filter((event) => event.kind === 'tool_call').length,
      1,
    );
  });
});

Deno.test('runtime event failure after child result rolls back parent and next turn is fresh', async () => {
  await withWorkspace(async (root) => {
    let failed = false;
    const sessionResult = await createRuntimeSession((event) => {
      if (!failed && event.kind === 'tool_result') {
        failed = true;
        throw new Error('reject after child');
      }
    }, {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(delegationPayload('first-delegate', 'first child')),
        response(finalPayload('first child plan')),
        response(delegationPayload('second-delegate', 'second child')),
        response(finalPayload('second child plan')),
        response(finalPayload('second parent')),
      ]),
      credential: DUMMY_CREDENTIAL,
    });
    await assertRejects(() => sessionResult.session.submit('first task'));
    assertEquals(sessionResult.requestCount(), 2);
    assertEquals(sessionResult.session.transcriptSnapshot(), []);
    const second = await sessionResult.session.submit('second task');
    assert(second.ok);
    assertEquals(second.finalText, 'second parent');
    assertEquals(sessionResult.requestCount(), 5);
    assert(JSON.stringify(second.transcript).includes('second child plan'));
    assert(!JSON.stringify(second.transcript).includes('first task'));
  });
});

Deno.test('planner runtime session captures one planner Definition across two turns', async () => {
  await withWorkspace(async (root) => {
    let evaluations = 0;
    const definition: AgentDefinition = (input) => {
      evaluations += 1;
      return plannerAgentDefinition(input);
    };
    const sessionResult = await createRuntimeSession(() => {}, {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(finalPayload('first plan')),
        response(finalPayload('second plan')),
      ]),
      credential: DUMMY_CREDENTIAL,
    }, selectionFor(definition, 'planner'));
    const first = await sessionResult.session.submit('first planning task');
    const second = await sessionResult.session.submit('second planning task');
    assert(first.ok && second.ok);
    assertEquals(first.finalText, 'first plan');
    assertEquals(second.finalText, 'second plan');
    assertEquals(evaluations, 1);
  });
});

Deno.test('runtime session passes Definition maxSteps and stops after one nonterminal request', async () => {
  await withWorkspace(async (root) => {
    const definition: AgentDefinition = (input) => ({
      ...defaultAgentDefinition(input),
      maxSteps: 1,
    });
    let fetches = 0;
    const sessionResult = await createRuntimeSession(() => {}, {
      workspaceRoot: root,
      fetcher: () => {
        fetches += 1;
        return Promise.resolve(
          response(
            toolPayload([{
              id: 'round-1',
              name: 'bash',
              arguments: { command: 'true' },
            }]),
          ),
        );
      },
      credential: DUMMY_CREDENTIAL,
    }, selectionFor(definition));
    const outcome = await sessionResult.session.submit('bounded session task');
    assert(!outcome.ok);
    assertEquals(outcome.stopReason, 'max_steps');
    assertEquals(outcome.steps, 1);
    assertEquals(fetches, 1);
    assertEquals(sessionResult.requestCount(), 1);
  });
});

Deno.test('runtime startup keeps credential reads and fetch starts at zero', async () => {
  await withWorkspace(async (root) => {
    let credentialReads = 0;
    let fetches = 0;
    const composition = await createRuntimeComposition({
      workspaceRoot: root,
      fetcher: () => {
        fetches += 1;
        return Promise.reject(new Error('startup must not fetch'));
      },
      credentialSource: () => {
        credentialReads += 1;
        return DUMMY_CREDENTIAL;
      },
    });
    assertEquals(composition.requestCount(), 0);
    assertEquals(fetches, 0);
    assertEquals(credentialReads, 0);
  });
});

Deno.test('normal runtime discovers workspace instructions once as a system message', async () => {
  await withWorkspace(async (root) => {
    await Deno.writeTextFile(
      `${root}/AGENTS.md`,
      '  local runtime instructions\n',
    );
    const calls: FetchCall[] = [];
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([response(finalPayload('answer'))], calls),
      credential: DUMMY_CREDENTIAL,
    });
    assert(result.outcome.ok);
    assertEquals(calls.length, 1);
    const messages = requestBody(calls[0]).messages as Array<
      Record<string, unknown>
    >;
    assertEquals(messages, [
      {
        role: 'system',
        content:
          'Project context instructions loaded from AGENTS.md. Follow them when working in this workspace.\n\n## ./AGENTS.md\n\nlocal runtime instructions',
      },
      { role: 'user', content: 'offline task' },
    ]);
    assert(
      !JSON.stringify(result.outcome.transcript).includes(
        'local runtime instructions',
      ),
    );
  });
});

Deno.test('normal runtime exposes a skill manifest then a nonterminal saved body', async () => {
  await withWorkspace(async (root) => {
    await Deno.mkdir(`${root}/.zot/skills/review`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/.zot/skills/review/SKILL.md`,
      '---\ndescription: Review code.\n---\nPRIVATE-SKILL-BODY',
    );
    const calls: FetchCall[] = [];
    const result = await runRuntime('offline task', {
      workspaceRoot: root,
      fetcher: fetchSequence([
        response(
          toolPayload([{
            id: 'skill-1',
            name: 'skill',
            arguments: { name: 'review' },
          }]),
        ),
        response(finalPayload('done')),
      ], calls),
      credential: DUMMY_CREDENTIAL,
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'done');
    const first = requestBody(calls[0]);
    const firstSerialized = JSON.stringify(first);
    assert(firstSerialized.includes('Available project skills.'));
    assert(!firstSerialized.includes('PRIVATE-SKILL-BODY'));
    assertEquals(
      (first.tools as Array<Record<string, unknown>>).map((tool) =>
        (tool.function as Record<string, unknown>).name
      ),
      [
        'bash',
        'delegate_to_planner',
        'edit',
        'read',
        'skill',
        'submit_json_result',
        'write',
      ],
    );
    const secondSerialized = JSON.stringify(requestBody(calls[1]));
    assert(secondSerialized.includes('PRIVATE-SKILL-BODY'));
    assert(secondSerialized.includes('./.zot/skills/review'));
    assert(!secondSerialized.includes(root));
    assertEquals(result.outcome.toolCallCount, 1);
    assertEquals(result.outcome.toolResultCount, 1);
  });
});

Deno.test('runtime executes causal write/read/edit/bash work rounds', async () => {
  await withWorkspace(async (root) => {
    const result = await run(root, [
      response(
        toolPayload([{
          id: 'w',
          name: 'write',
          arguments: { path: 'note.txt', content: 'one' },
        }]),
      ),
      response(
        toolPayload([{
          id: 'r',
          name: 'read',
          arguments: { path: './note.txt' },
        }]),
      ),
      response(
        toolPayload([{
          id: 'e',
          name: 'edit',
          arguments: {
            path: 'note.txt',
            edits: [{ oldText: 'one', newText: 'two' }],
          },
        }]),
      ),
      response(
        toolPayload([{
          id: 'b',
          name: 'bash',
          arguments: { command: 'cat note.txt' },
        }]),
      ),
      response(finalPayload('done')),
    ]);
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'done');
    assertEquals(await Deno.readTextFile(`${root}/note.txt`), 'two');
    assertEquals(result.outcome.toolCallCount, 4);
    assert(result.outcome.transcript[2].role === 'tool');
    assert(result.outcome.transcript[2].content[0].text.includes('"bytes":3'));
  });
});

Deno.test('multiple local work calls remain ordered and errors are recoverable', async () => {
  await withWorkspace(async (root) => {
    const result = await run(root, [
      response(toolPayload([
        { id: 'bad', name: 'read', arguments: { path: '../outside' } },
        {
          id: 'bash',
          name: 'bash',
          arguments: { command: 'printf out; printf err >&2; exit 7' },
        },
      ])),
      response(finalPayload('recovered')),
    ]);
    assert(result.outcome.ok);
    assertEquals(result.outcome.finalText, 'recovered');
    assert(result.outcome.transcript[2].role === 'tool');
    assertEquals(
      result.outcome.transcript[2].content.map((item) => item.name),
      ['read', 'bash'],
    );
    assert(
      result.outcome.transcript[2].content[0].text.includes(
        'path must stay within workspace',
      ),
    );
    assert(
      result.outcome.transcript[2].content[1].text.includes('"exitCode":7'),
    );
  });
});

Deno.test('terminal submission on request eight makes no ninth request', async () => {
  await withWorkspace(async (root) => {
    const responses = Array.from(
      { length: 7 },
      (_, index) =>
        response(
          toolPayload([{
            id: `r${index}`,
            name: 'bash',
            arguments: { command: 'true' },
          }]),
        ),
    );
    responses.push(
      response(
        toolPayload([{
          id: 'terminal',
          name: 'submit_json_result',
          arguments: { json: '{"ok":true}' },
        }]),
      ),
    );
    let requests = 0;
    const sequence = fetchSequence(responses);
    const result = await runRuntime('loop', {
      workspaceRoot: root,
      fetcher: (input, init) => {
        requests += 1;
        return sequence(input, init);
      },
      credential: DUMMY_CREDENTIAL,
    });
    assert(result.outcome.ok);
    assertEquals(result.outcome.stopReason, 'tool_terminal');
    assertEquals(result.outcome.finalText, '{"ok":true}');
    assertEquals(requests, 8);
  });
});

Deno.test('eight nonterminal rounds end at max_steps with eight fetches', async () => {
  await withWorkspace(async (root) => {
    const responses = Array.from(
      { length: 8 },
      (_, index) =>
        response(
          toolPayload([{
            id: `${index}`,
            name: 'bash',
            arguments: { command: 'true' },
          }]),
        ),
    );
    let fetches = 0;
    const sequence = fetchSequence(responses);
    const result = await runRuntime('loop', {
      workspaceRoot: root,
      fetcher: (input, init) => {
        fetches += 1;
        return sequence(input, init);
      },
      credential: DUMMY_CREDENTIAL,
    });
    assert(!result.outcome.ok);
    assertEquals(result.outcome.stopReason, 'max_steps');
    assertEquals(result.requestCount, 8);
    assertEquals(fetches, 8);
  });
});

Deno.test('missing credential and transport failure retain retry zero', async () => {
  await withWorkspace(async (root) => {
    let fetches = 0;
    const missing = await runRuntime('task', {
      workspaceRoot: root,
      credentialSource: () => undefined,
      fetcher: () => {
        fetches += 1;
        return Promise.resolve(response(finalPayload('never')));
      },
    });
    assert(!missing.outcome.ok);
    assertEquals(missing.requestCount, 0);
    assertEquals(fetches, 0);
    const transport = await runRuntime('task', {
      workspaceRoot: root,
      credential: DUMMY_CREDENTIAL,
      fetcher: () => {
        fetches += 1;
        return Promise.reject(new Error('provider marker'));
      },
    });
    assert(!transport.outcome.ok);
    assertEquals(transport.requestCount, 1);
    assertEquals(fetches, 1);
  });
});

Deno.test('CLI keeps final-only channels and input contract', async () => {
  const argv = await runWithOutput(['--task', '  hello  '], { terminal: true });
  assertEquals(argv.exit, 0);
  assertEquals(argv.stdout, 'answer\n');
  assertEquals(argv.stderr, '');
  const invalid = await runWithOutput(['--unknown'], { terminal: true });
  assertEquals(invalid.exit, 1);
  assertEquals(invalid.stdout, '');
  assertEquals(JSON.parse(invalid.stderr).error.code, 'invalid_input');
  const oversized = await runWithOutput([], {
    stdin: encoder.encode('x'.repeat(MAX_TASK_BYTES + 1)),
  });
  assertEquals(oversized.exit, 1);
  assertEquals(oversized.stdout, '');
  assertEquals(JSON.parse(oversized.stderr).error.code, 'invalid_input');
});

Deno.test('CLI supports both selector option orders and explicit default without output changes', async () => {
  const seen: string[] = [];
  const run = (
    task: string,
    selection: BuiltinAgentSelection,
  ): Promise<RuntimeRun> => {
    seen.push(`${selection.id}:${task}`);
    return Promise.resolve({
      outcome: {
        ok: true,
        task,
        outcome: 'final',
        stopReason: 'final',
        finalText: 'answer',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript: [],
      },
      requestCount: 1,
    });
  };
  const first = await main(['--agent', 'planner', '--task', '  first  '], {
    stdinIsTerminal: () => true,
    run,
    writeStdout: () => {},
    writeStderr: () => {},
  });
  const second = await main(['--task', '  second  ', '--agent', 'default'], {
    stdinIsTerminal: () => true,
    run,
    writeStdout: () => {},
    writeStderr: () => {},
  });
  assertEquals(first, 0);
  assertEquals(second, 0);
  assertEquals(seen, ['planner:first', 'default:second']);
});

Deno.test('CLI selector grammar rejects before host effects and consumes option-looking values', async () => {
  const cases: readonly {
    readonly name: string;
    readonly args: readonly string[];
    readonly expected: 'invalid' | 'option-looking-task';
  }[] = [
    {
      name: 'duplicate --agent',
      args: ['--agent', 'default', '--agent', 'planner', '--task', 'task'],
      expected: 'invalid',
    },
    { name: 'missing --agent value', args: ['--agent'], expected: 'invalid' },
    {
      name: 'equals-form --agent=planner',
      args: ['--agent=planner', '--task', 'task'],
      expected: 'invalid',
    },
    {
      name: 'malformed selector value',
      args: ['--agent', 'planner!', '--task', 'task'],
      expected: 'invalid',
    },
    {
      name: 'option-looking --agent value is consumed verbatim',
      args: ['--agent', '--task', '--task', 'task'],
      expected: 'invalid',
    },
    {
      name: 'option-looking --task value is consumed verbatim',
      args: ['--task', '--agent', '--agent', 'default'],
      expected: 'option-looking-task',
    },
  ];

  for (const testCase of cases) {
    let terminalProbes = 0;
    let stdinReads = 0;
    let runs = 0;
    let seenTask: string | undefined;
    let seenSelection: string | undefined;
    let stdout = '';
    let stderr = '';
    const result = await main(testCase.args, {
      stdinIsTerminal: () => {
        terminalProbes += 1;
        return true;
      },
      readStdin: () => {
        stdinReads += 1;
        return Promise.resolve(encoder.encode('ignored'));
      },
      run: (task, selection) => {
        runs += 1;
        seenTask = task;
        seenSelection = selection.id;
        return Promise.resolve({
          outcome: {
            ok: true,
            task,
            outcome: 'final',
            stopReason: 'final',
            finalText: 'answer',
            steps: 1,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          },
          requestCount: 1,
        });
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });

    if (testCase.expected === 'invalid') {
      assertEquals(result, 1, testCase.name);
      assertEquals(stdout, '', testCase.name);
      assertEquals(
        JSON.parse(stderr).error.code,
        'invalid_input',
        testCase.name,
      );
      assertEquals(terminalProbes, 0, testCase.name);
      assertEquals(stdinReads, 0, testCase.name);
      assertEquals(runs, 0, testCase.name);
    } else {
      assertEquals(result, 0, testCase.name);
      assertEquals(stdout, 'answer\n', testCase.name);
      assertEquals(stderr, '', testCase.name);
      assertEquals(terminalProbes, 1, testCase.name);
      assertEquals(stdinReads, 0, testCase.name);
      assertEquals(runs, 1, testCase.name);
      assertEquals(seenTask, '--agent', testCase.name);
      assertEquals(seenSelection, 'default', testCase.name);
    }
  }
});

Deno.test('CLI rejects duplicate, missing, positional, and ambiguous task sources', async () => {
  for (
    const args of [
      ['--task', 'one', '--task', 'two'],
      ['--task'],
      ['positional'],
    ]
  ) {
    const result = await runWithOutput(args, { terminal: true });
    assertEquals(result.exit, 1);
    assertEquals(result.stdout, '');
    assertEquals(JSON.parse(result.stderr).error.code, 'invalid_input');
  }
  const ambiguous = await runWithOutput(['--task', 'hello'], {
    stdin: encoder.encode('ignored'),
    terminal: false,
  });
  assertEquals(ambiguous.exit, 1);
  assertEquals(ambiguous.stdout, '');
  assertEquals(JSON.parse(ambiguous.stderr).error.code, 'invalid_input');
});

Deno.test('CLI rejects blank and malformed UTF-8 piped tasks before the runner', async () => {
  for (
    const input of [encoder.encode(' \n\t '), new Uint8Array([0xc3, 0x28])]
  ) {
    const result = await runWithOutput([], { stdin: input });
    assertEquals(result.exit, 1);
    assertEquals(result.stdout, '');
    assertEquals(JSON.parse(result.stderr).error.code, 'invalid_input');
  }
});

Deno.test('CLI maps later runtime failures to one generic sanitized line', async () => {
  const result = await runWithOutput(['--task', 'hello'], {
    terminal: true,
    run: (task) =>
      Promise.resolve({
        outcome: {
          ok: false,
          task,
          outcome: 'contract_failure',
          stopReason: 'contract_failure',
          error: 'provider-sensitive-marker',
          steps: 2,
          toolCallCount: 1,
          toolResultCount: 1,
          transcript: [],
        },
        requestCount: 2,
      }),
  });
  assertEquals(result.exit, 1);
  assertEquals(result.stdout, '');
  assertEquals(JSON.parse(result.stderr), {
    ok: false,
    outcome: 'contract_failure',
    stopReason: 'contract_failure',
    steps: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    requestCount: 2,
    error: { code: 'agent_failure', message: 'agent run failed' },
  });
  assert(!result.stderr.includes('provider-sensitive-marker'));
});
