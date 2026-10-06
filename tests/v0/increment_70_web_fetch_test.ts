import { createWebFetchTool, MAX_WEB_FETCH_BYTES } from './helpers/external_web_tools.ts';
import { Registry, type Tool, ToolInputError } from '../../v0/agent/tools/tools.ts';
import type { Model, ModelResult } from '../../v0/agent/core/contracts.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import { DataSessionOwner } from '../../v0/agent/data/session_data_owner.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message ?? 'assertion failed');
};

const run = async (tool: Tool, url: string): Promise<string> => {
  const result = await tool.execute({ url });
  if (typeof result === 'string') return result;
  return result.kind === 'continue' ? result.text : '';
};

const failure = async (tool: Tool, url: string): Promise<unknown> => {
  try {
    await tool.execute({ url });
    return undefined;
  } catch (error) {
    return error;
  }
};

const fetched = (
  body: string,
  init: { status?: number; contentType?: string; url?: string } = {},
): typeof fetch =>
() =>
  Promise.resolve(
    Object.defineProperty(
      new Response(body, {
        status: init.status ?? 200,
        headers: { 'content-type': init.contentType ?? 'text/plain; charset=utf-8' },
      }),
      'url',
      { value: init.url ?? 'https://example.com/final' },
    ),
  );

Deno.test('Increment 70 web_fetch returns metadata and extracted HTML text', async () => {
  const tool = createWebFetchTool(fetched(
    '<html><head><style>p{color:red}</style><script>alert(1)</script></head>' +
      '<body><h1>Title</h1><p>Hello <b>world</b> &amp; friends</p></body></html>',
    { contentType: 'text/html; charset=utf-8', url: 'https://example.com/page' },
  ));
  const output = await run(tool, 'https://example.com');
  assert(output.includes('URL: https://example.com/page'));
  assert(output.includes('Status: 200'));
  assert(output.includes('Content-Type: text/html; charset=utf-8'));
  assert(output.includes('truncated: false'));
  assert(output.includes('Title'));
  assert(output.includes('Hello world & friends'));
  assert(!output.includes('<h1>'));
  assert(!output.includes('alert(1)'));
  assert(!output.includes('color:red'));
});

Deno.test('Increment 70 web_fetch returns metadata only for non-textual content', async () => {
  const tool = createWebFetchTool(fetched('binarydata', {
    contentType: 'application/octet-stream',
  }));
  const output = await run(tool, 'https://example.com/blob');
  assert(output.includes('Content-Type: application/octet-stream'));
  assert(!output.includes('binarydata'));
});

Deno.test('Increment 70 web_fetch truncates an oversized body', async () => {
  const big = 'x'.repeat(MAX_WEB_FETCH_BYTES + 10_000);
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode(big)),
      cancel: () => {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'text/plain' } },
  );
  const tool = createWebFetchTool(() => Promise.resolve(response));
  const output = await run(tool, 'https://example.com/big');
  assert(output.includes('truncated: true'));
  assert(output.includes('[body truncated]'));
  assert(cancelled, 'truncated body was retained after result');
  assert(response.body?.locked === false);
});

Deno.test('Increment 70 web_fetch marks an exact 1 MiB body as complete', async () => {
  const body = 'x'.repeat(MAX_WEB_FETCH_BYTES);
  const output = await run(createWebFetchTool(fetched(body)), 'https://example.com/exact');
  assert(output.includes('truncated: false'));
  assert(!output.includes('[body truncated]'));
  assert(output.endsWith(body));
});

Deno.test('Increment 70 complete and truncated 1 MiB web_fetch results survive canonical record readback', async () => {
  const configuration = workerConfigurationFixture();
  for (const extraBytes of [0, 10_000]) {
    const root = await Deno.makeTempDir({ prefix: 'henji-i70-web-fetch-' });
    const workspaceRoot = `${root}/workspace`;
    const stateRoot = `${root}/state`;
    await Deno.mkdir(workspaceRoot);
    const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
    const writer = new ConversationWriter(store);
    let owner: DataSessionOwner | undefined;
    let generation: WorkerGeneration | undefined;
    try {
      await store.initialize();
      owner = await DataSessionOwner.open({
        store,
        writer,
        workspaceRoot,
        persistence: 'new',
        agent: 'default',
        agentChoice: {},
      });
      const sessionId = owner.sessionId;
      const executionId = crypto.randomUUID().toLowerCase();
      const correlation = {
        session: sessionId,
        instanceCorrelation: 'web-fetch-instance',
        workerGeneration: 'web-fetch-generation',
        baseStateRevision: 1,
        command: 'turn-1',
      };
      await owner.admit({
        executionId,
        taskId: crypto.randomUUID().toLowerCase(),
        task: 'fetch source',
        correlation,
        configuration,
        maxSteps: 2,
      });
      const body = 'x'.repeat(MAX_WEB_FETCH_BYTES + extraBytes);
      const tool = createWebFetchTool(fetched(body));
      let modelCalls = 0;
      const model: Model = {
        generate(): ModelResult {
          modelCalls += 1;
          return modelCalls === 1
            ? {
              kind: 'tool_calls',
              calls: [{
                callId: 'web-fetch-1',
                name: 'web_fetch',
                arguments: { url: 'https://example.com/source' },
              }],
            }
            : { kind: 'final', text: 'fetched source' };
        },
      };
      const composition = {
        role: 'parent',
        model,
        registry: new Registry([tool]),
        maxSteps: 2,
        manifest: {
          role: 'parent',
          maxSteps: 2,
          profileId: 'provider-free-web-fetch',
          resources: ['tool:web_fetch'],
        },
      } as unknown as WorkerAgentComposition;
      const port: WorkerGenerationPort = {
        runtimeEvent: () => undefined,
        effectObservation: () => undefined,
        checkpointProposal: () => Promise.resolve(false),
        commitProposal: async (_correlation, proposal) => {
          const token = await owner!.prepareProposal({
            proposalId: `web-fetch-${extraBytes}-proposal`,
            executionId,
            finalDataSequence: 0,
            message: proposal,
          });
          return owner!.authorizeCommit(token, { accepted: true }).accepted;
        },
        turnFailed: (_correlation, outcome) => {
          throw new Error(`unexpected turn failure: ${outcome.stopReason}`);
        },
      };
      generation = new WorkerGeneration(composition, sessionId, port);
      await generation.runTurn(
        correlation,
        'fetch source',
        undefined,
        undefined,
        undefined,
        false,
        executionId,
      );
      const committed = await store.readWorker(sessionId);
      assert(committed.nextTurn === 2, 'normal web_fetch turn was not accepted');
      assert(modelCalls === 2);
      const toolMessage = committed.transcript.find((message) => message.role === 'tool');
      assert(toolMessage?.role === 'tool');
      const result = toolMessage.content[0];
      assert(result?.kind === 'tool_result');
      assert(result.text.includes('URL: https://example.com/final'));
      assert(result.text.includes(`truncated: ${extraBytes > 0}`));
      assert(result.text.includes('Content-Type: text/plain; charset=utf-8'));
      assert(result.text.length > MAX_WEB_FETCH_BYTES);
      assert(result.text.includes('x'.repeat(MAX_WEB_FETCH_BYTES)));
      assert(result.text.endsWith('[body truncated]') === (extraBytes > 0));
    } finally {
      await generation?.close();
      await owner?.close();
      writer.close();
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('Increment 70 web_fetch fails on http errors and invalid input', async () => {
  const failing = createWebFetchTool(fetched('nope', { status: 404 }));
  const httpError = await failure(failing, 'https://example.com/missing');
  assert(httpError instanceof Error);
  assert((httpError as Error).message.includes('404'));

  const tool = createWebFetchTool(fetched('ok'));
  for (const bad of ['not a url', 'ftp://example.com/file', '']) {
    const error = await failure(tool, bad);
    assert(error instanceof ToolInputError);
  }
});
