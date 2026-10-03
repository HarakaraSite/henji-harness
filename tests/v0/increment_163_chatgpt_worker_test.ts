import {
  childDataTest,
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createChatGPTAuthService } from '../../v0/agent/provider/chatgpt_auth.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import type { ChildRunRegistry } from '../../v0/agent/worker/worker_host_children.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { bundledToolDefinitionLoadRequests } from '../../v0/agent/worker/worker_definition_revision.ts';
import { createMockChatGPTIssuer } from './helpers/increment_163_chatgpt_issuer.ts';

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

childDataTest(
  'A real ChatGPT child resolves saved auth, uses a local tool, and returns only its result to another-provider parent',
  async () => {
    const root = await Deno.makeTempDir({ prefix: 'henji-163-real-child-' });
    const configRoot = `${root}/config`;
    const issuer = await createMockChatGPTIssuer();
    const auth = createChatGPTAuthService({ configRoot, fetcher: issuer.fetcher });
    const previous = (await import('../../v0/agent/provider/provider_runtime.ts'))
      .activeProviderDeclarations();
    let server: Deno.HttpServer | undefined;
    let registry: ChildRunRegistry | undefined;
    try {
      await Deno.writeTextFile(`${root}/fixture.txt`, 'CHILD_READ_OK\n');
      const register = async (index: number) => {
        const attempt = await auth.begin();
        const url = new URL(attempt.authorizationUrl);
        const clientId = `worker-test-client-${index}`;
        await issuer.setNextLogin({
          clientId,
          nonce: url.searchParams.get('nonce')!,
          codeChallenge: url.searchParams.get('code_challenge')!,
          subject: `worker-test-subject-${index}`,
          email: `worker-${index}@example.test`,
        });
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        callback.searchParams.set('client_id', clientId);
        callback.searchParams.set('code', 'test-only-code');
        await auth.complete(attempt.attemptId, callback.href);
        return attempt.registrationId;
      };
      const firstRegistration = await register(1);
      const secondRegistration = await register(2);
      await auth.select(firstRegistration);
      const bodies: Record<string, unknown>[] = [];
      const credentialMatches: boolean[] = [];
      server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
        credentialMatches.push(
          request.headers.get('authorization') === 'Bearer increment-163-mock-access-1',
        );
        bodies.push(await request.json());
        const first = bodies.length === 1;
        if (first) await auth.select(secondRegistration);
        const output = first
          ? [
            {
              type: 'reasoning',
              id: 'reasoning-child',
              encrypted_content: 'child-private-replay',
              summary: [],
            },
            {
              type: 'function_call',
              id: 'function-read',
              call_id: 'call-read',
              name: 'read',
              namespace: 'henji',
              arguments: JSON.stringify({ path: 'fixture.txt' }),
              status: 'completed',
            },
          ]
          : [
            {
              type: 'message',
              id: 'message-child',
              role: 'assistant',
              status: 'completed',
              content: [
                { type: 'output_text', text: 'CHILD_TOOL_OK', annotations: [] },
              ],
            },
          ];
        return new Response(
          output.map((item, output_index) =>
            event({
              type: 'response.output_item.done',
              item,
              output_index,
            })
          ).join('') + event({
            type: 'response.completed',
            response: {
              id: `response-child-${bodies.length}`,
              status: 'completed',
              output: [],
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      const endpoint = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/v1/responses`;
      const bootstrap = new URL('../../v0/agent/worker/worker_bootstrap.ts', import.meta.url).href;
      const wrapper = `${root}/mock_worker.ts`;
      // Only the transport is mocked. The actual Worker bootstrap, auth resolver, SDK and tool loop run.
      await Deno.writeTextFile(
        wrapper,
        `
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href !== 'https://api.openai.com/v1/responses') {
    throw new Error('unexpected external Worker request');
  }
  return originalFetch(input instanceof Request ? new Request(${
          JSON.stringify(endpoint)
        }, input) : ${JSON.stringify(endpoint)}, init);
};
await import(${JSON.stringify(bootstrap)});
`,
      );
      const declarations = builtinProviderDeclarations();
      setActiveProviderDeclarations(declarations);
      const otherProvider = selectModelFor('openrouter-chat', 'anthropic/claude-sonnet');
      const ref = await builtinDefinitionRef('generic', buildManifest());
      ({ registry } = await createChildDataTestRegistry({
        workspaceRoot: root,
        options: {
          configRoot,
          physicalIoMode: 'production',
          providerDeclarations: declarations,
          rootMaxSteps: 4,
          providerTimeoutMs: 5_000,
          toolDefinitions: await bundledToolDefinitionLoadRequests(),
          capsuleFactory: () => new WorkerCapsule(new URL(`file://${wrapper}`)),
        },
        currentModelSelection: () => otherProvider,
        catalog: [{ name: 'generic', ref }],
      }));
      const executionId = 'other-provider-parent-turn';
      registry.openParent(executionId);
      const spawned = await registry.handle(
        {
          kind: 'spawn',
          agent: 'generic',
          task: 'Read fixture.txt and reply.',
          tools: ['read'],
          model: { provider: 'openai-chatgpt', modelId: 'gpt-5.6-sol', effort: 'medium' },
        },
        'spawn-real-child',
        executionId,
      );
      ok(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
      if (!spawned.ok || spawned.kind !== 'spawn') throw new Error('Child was not spawned');
      const collected = await registry.handle(
        { kind: 'collect', runId: spawned.runId },
        undefined,
        executionId,
      );
      ok(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
      if (!collected.ok || collected.kind !== 'collect') throw new Error('Child was not collected');
      strictEqual(collected.result.state, 'completed', JSON.stringify(collected));
      strictEqual(collected.result.finalText, 'CHILD_TOOL_OK');
      strictEqual(bodies.length, 2);
      deepStrictEqual(credentialMatches, [true, true]);
      strictEqual(bodies[0].store, false);
      strictEqual(bodies[0].stream, true);
      const tools = bodies[0].tools as { type: string; name: string }[];
      ok(tools.some((tool) => tool.type === 'namespace' && tool.name === 'henji'));
      const replay = JSON.stringify(bodies[1].input);
      ok(
        replay.includes('CHILD_READ_OK'),
        'The local read result must reach the second model request',
      );
      ok(
        replay.includes('child-private-replay'),
        'Private reasoning stays in the child continuation',
      );
      ok(!JSON.stringify(collected).includes('child-private-replay'));
      ok(!JSON.stringify(collected).includes('increment-163-mock-access'));
      strictEqual((await auth.status()).selectedRegistrationId, secondRegistration);
      strictEqual(otherProvider.provider, 'openrouter-chat');
    } finally {
      await registry?.cleanupAll();
      await closeChildDataTests();
      await server?.shutdown();
      await auth.close();
      setActiveProviderDeclarations(previous);
      await Deno.remove(root, { recursive: true });
    }
  },
);
