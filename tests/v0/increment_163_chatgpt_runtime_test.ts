import {
  foundationProposal,
  Increment170FoundationDataPortAgent,
} from './helpers/increment_170_foundation_data.ts';
import {
  childDataTest,
  closeChildDataTests,
  createChildDataTestRegistry,
} from './helpers/increment_170_child_data.ts';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { ChatGPTResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import { createCredentialResolver } from '../../v0/agent/provider/credential_resolver.ts';
import { LiveModelCatalog } from '../../v0/agent/provider/live_model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { type ChatGPTModelSelection } from '../../v0/agent/provider/model_selection.ts';
import { selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import type { ChatGPTAuthService } from '../../v0/agent/provider/chatgpt_auth.ts';
import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import type {
  WorkerHostCommand,
  WorkerReadyMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { setActiveProviderDeclarations } from '../../v0/agent/provider/provider_runtime.ts';
import { createChatGPTAuthService } from '../../v0/agent/provider/chatgpt_auth.ts';
import { createMockChatGPTIssuer } from './helpers/increment_163_chatgpt_issuer.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const mockAuth = (
  selected = 'account-selected',
): ChatGPTAuthService => ({
  status: () => Promise.resolve({ accounts: [], selectedRegistrationId: selected }),
  begin: () => Promise.reject(new Error('unused')),
  complete: () => Promise.reject(new Error('unused')),
  cancel: () => Promise.resolve(),
  select: () => Promise.reject(new Error('unused')),
  selectedRegistrationId: () => Promise.resolve(selected),
  resolve: (registrationId) => {
    const resolved = registrationId ?? selected;
    return Promise.resolve({ accessToken: `token-${resolved}`, registrationId: resolved });
  },
  presence: (registrationId) =>
    Promise.resolve(
      registrationId === undefined || registrationId !== 'missing' ? 'present' : 'missing',
    ),
  close: () => Promise.resolve(),
});

childDataTest('Increment 163 resolver uses the frozen ChatGPT registration', async () => {
  const resolved: (string | undefined)[] = [];
  const auth = {
    ...mockAuth(),
    resolve: (registrationId?: string) => {
      resolved.push(registrationId);
      return Promise.resolve({
        accessToken: `token-${registrationId ?? 'selected'}`,
        registrationId: registrationId ?? 'account-selected',
      });
    },
  } as ChatGPTAuthService;
  const resolver = createCredentialResolver({
    configRoot: '/tmp/increment-163-config',
    chatgptAuth: auth,
  });

  strictEqual(
    await resolver.resolve('openai-chatgpt', 'account-a'),
    'token-account-a',
  );
  strictEqual(await resolver.resolve('openai-chatgpt', null), undefined);
  strictEqual(await resolver.presence('openai-chatgpt', null), 'missing');
  strictEqual(
    await resolver.presence('openai-chatgpt', 'account-a'),
    'present',
  );
  deepStrictEqual(resolved, ['account-a']);
});

childDataTest('Increment 163 resolver records contextual OAuth refresh request facts', async () => {
  const temporaryRoot = await Deno.makeTempDir({
    prefix: 'henji-increment-163-refresh-facts-',
  });
  const configRoot = `${temporaryRoot}/config/henji-harness`;
  const issuer = await createMockChatGPTIssuer();
  const auth = createChatGPTAuthService({
    configRoot,
    fetcher: issuer.fetcher,
  });
  try {
    const attempt = await auth.begin();
    const authorization = new URL(attempt.authorizationUrl);
    const redirectUri = new URL(
      authorization.searchParams.get('redirect_uri')!,
    );
    const callback = new URL(redirectUri);
    callback.search = new URLSearchParams({
      code: 'increment-163-mock-code',
      state: authorization.searchParams.get('state')!,
      client_id: 'oaiapp_increment_163',
    }).toString();
    await issuer.setNextLogin({
      clientId: 'oaiapp_increment_163',
      nonce: authorization.searchParams.get('nonce')!,
      codeChallenge: authorization.searchParams.get('code_challenge')!,
      subject: 'increment-163-refresh-subject',
      email: 'increment-163-refresh@example.test',
    });
    const state = await auth.complete(attempt.attemptId, callback.toString());
    const registrationId = state.accounts[0].registrationId;
    const accountPath = `${configRoot}/chatgpt/accounts/${encodeURIComponent(registrationId)}.json`;
    const account = JSON.parse(await Deno.readTextFile(accountPath));
    account.expiresAt = Date.now() - 1;
    await Deno.writeTextFile(accountPath, `${JSON.stringify(account)}\n`);

    const resolver = createCredentialResolver({
      configRoot,
      chatgptFetcher: issuer.fetcher,
    });
    strictEqual(
      await resolver.resolve('openai-chatgpt', registrationId, {
        sessionId: 'increment-163-session',
        modelId: 'gpt-5.6-sol',
        modelStep: 4,
      }),
      'increment-163-mock-access-2',
    );
    const factsPath = `${configRoot}/chatgpt/requests.jsonl`;
    const facts = (await Deno.readTextFile(factsPath)).trim().split('\n').map((
      line,
    ) => JSON.parse(line));
    const refreshRequest = facts.find((fact) =>
      fact.kind === 'request' && fact.api === 'oauth.token'
    );
    ok(refreshRequest);
    strictEqual(refreshRequest.provider, 'openai-chatgpt');
    strictEqual(refreshRequest.registrationId, registrationId);
    strictEqual(refreshRequest.sessionId, 'increment-163-session');
    strictEqual(refreshRequest.modelId, 'gpt-5.6-sol');
    strictEqual(refreshRequest.modelStep, 4);
    strictEqual(refreshRequest.method, 'POST');
    ok(facts.some((fact) => fact.httpStatus === 200));
    const factText = JSON.stringify(facts);
    for (
      const secret of [
        'increment-163-mock-code',
        'increment-163-mock-access-1',
        'increment-163-mock-access-2',
        'increment-163-mock-refresh-1',
      ]
    ) {
      ok(!factText.includes(secret));
    }
    const factsInfo = await Deno.lstat(factsPath);
    strictEqual(
      factsInfo.mode !== null && (factsInfo.mode & 0o7777) === 0o600,
      true,
    );
  } finally {
    await auth.close();
    await Deno.remove(temporaryRoot, { recursive: true });
  }
});

childDataTest(
  'Increment 163 ChatGPT route groups local tools and replays empty-completion items by account',
  async () => {
    const selection = {
      ...selectModelFor('openai-chatgpt', 'gpt-5.6-sol', 'high'),
      registrationId: 'account-a',
    } as ChatGPTModelSelection;
    const doneItems = [
      {
        type: 'reasoning',
        id: 'reasoning-a',
        encrypted_content: 'mock-encrypted-thinking',
        summary: [{ type: 'summary_text', text: 'Check the echoed value.' }],
      },
      {
        type: 'function_call',
        id: 'function-a',
        status: 'completed',
        call_id: 'call-a',
        name: 'echo',
        arguments: '{"value":"ok"}',
      },
      {
        type: 'message',
        id: 'message-a',
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: 'Echo complete.',
          annotations: [],
        }],
      },
    ];
    let requestedUrl = '';
    let requestedAuthorization: string | null = null;
    let requestBody: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requestedUrl = request.url;
      requestedAuthorization = request.headers.get('authorization');
      requestBody = JSON.parse(await request.clone().text());
      const events = [
        {
          type: 'response.output_item.done',
          output_index: 2,
          item: doneItems[2],
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: doneItems[1],
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: doneItems[0],
        },
        {
          type: 'response.completed',
          response: {
            id: 'response-a',
            status: 'completed',
            output: [],
            output_text: '',
          },
        },
      ];
      const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join('');
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    const model = new ChatGPTResponsesModel({
      selection,
      credentialSource: () => 'mock-access-token',
      fetcher,
    });
    const request: ModelRequest = {
      systemInstruction: 'Use Henji tools when needed.',
      transcript: [
        { role: 'user', content: { kind: 'text', text: 'Echo the value.' } },
        {
          role: 'assistant',
          content: { kind: 'text', text: 'Private item from account A.' },
          providerState: {
            provider: 'openai-chatgpt@account-a',
            replayItems: [{ type: 'reasoning', id: 'prior-account-a' }],
            model: selection.modelId,
          },
        },
        {
          role: 'assistant',
          content: { kind: 'text', text: 'Visible history from account B.' },
          providerState: {
            provider: 'openai-chatgpt@account-b',
            replayItems: [{ type: 'reasoning', id: 'must-not-replay-account-b' }],
            model: selection.modelId,
          },
        },
      ],
      tools: [{
        name: 'echo',
        description: 'Return the supplied value.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      }],
    };

    const thinking: unknown[] = [];
    const result = await model.generate(request, {
      reportThinkingDelta: (delta) => thinking.push(delta),
    });
    deepStrictEqual(requestBody.reasoning, { summary: 'auto', effort: 'high' });
    deepStrictEqual(thinking, [{ kind: 'summary', text: 'Check the echoed value.' }]);
    strictEqual(result.kind, 'tool_calls');
    if (result.kind !== 'tool_calls') {
      throw new Error('tool call result expected');
    }
    strictEqual(result.text, 'Echo complete.');
    deepStrictEqual(result.calls, [{
      callId: 'call-a',
      name: 'echo',
      arguments: { value: 'ok' },
    }]);
    deepStrictEqual(result.providerState, {
      provider: 'openai-chatgpt@account-a',
      replayItems: doneItems,
      model: selection.modelId,
    });
    strictEqual(requestedUrl, 'https://api.openai.com/v1/responses');
    strictEqual(requestedAuthorization, 'Bearer mock-access-token');
    strictEqual(requestBody.store, false);
    strictEqual(requestBody.stream, true);
    const tools = requestBody.tools as Record<string, unknown>[];
    strictEqual(tools[0].type, 'namespace');
    strictEqual(tools[0].name, 'henji');
    deepStrictEqual(tools[0].tools, [{
      type: 'function',
      name: 'echo',
      description: 'Return the supplied value.',
      parameters: { type: 'object', properties: { value: { type: 'string' } } },
      strict: false,
    }]);
    deepStrictEqual(requestBody.input, [
      { role: 'user', content: 'Echo the value.' },
      { type: 'reasoning', id: 'prior-account-a' },
      { role: 'assistant', content: 'Visible history from account B.' },
    ]);
    ok(!JSON.stringify(requestBody).includes('mock-access-token'));
  },
);

childDataTest(
  'Increment 163 ChatGPT catalogs preserve account order and account-scoped favorites',
  async () => {
    const root = await Deno.makeTempDir({
      prefix: 'henji-increment-163-catalog-',
    });
    const authorization: (string | null)[] = [];
    const auth = mockAuth('account-a');
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://models.dev') return Promise.resolve(Response.json({}));
      authorization.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(Response.json({
        models: [
          {
            slug: 'model-second',
            display_name: 'Second model',
            visibility: 'list',
          },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
          {
            slug: 'model-first',
            display_name: 'First model',
            visibility: 'list',
          },
        ],
      }));
    };
    const declarations = builtinProviderDeclarations();
    const catalog = new LiveModelCatalog({
      configRoot: root,
      declarations,
      chatgptAuth: auth,
      fetcher,
    });
    try {
      const accountA = await catalog.models(
        'openai-chatgpt',
        undefined,
        'account-a',
      );
      const accountB = await catalog.models(
        'openai-chatgpt',
        undefined,
        'account-b',
      );
      deepStrictEqual(accountA.models.map((model) => model.modelId), [
        'model-second',
        'model-first',
        'gpt-6.1-sol',
        'gpt-6-luna',
      ]);
      deepStrictEqual(accountB.models.map((model) => model.modelId), [
        'model-second',
        'model-first',
        'gpt-6.1-sol',
        'gpt-6-luna',
      ]);
      deepStrictEqual(authorization, [
        'Bearer token-account-a',
        'Bearer token-account-b',
      ]);

      const favorited = await catalog.favorite(
        'openai-chatgpt',
        'model-second',
        true,
        'account-a',
      );
      strictEqual(favorited.models[0].favorite, true);
      const accountBReadback = await catalog.models(
        'openai-chatgpt',
        undefined,
        'account-b',
      );
      strictEqual(accountBReadback.models[0].favorite, false);
      const accountAReadback = await catalog.models(
        'openai-chatgpt',
        undefined,
        'account-a',
      );
      strictEqual(accountAReadback.models[0].favorite, true);
      await catalog.remember('openai-chatgpt', 'model-second', 'high', 'account-a');
      strictEqual(
        await catalog.defaultEffort('openai-chatgpt', 'model-second', 'account-a'),
        'high',
      );
      strictEqual(await catalog.defaultEffort('openai-chatgpt', 'model-second'), 'high');
      strictEqual(
        await catalog.defaultEffort('openai-chatgpt', 'model-second', 'account-b'),
        'auto',
      );
      const paths = [...Deno.readDirSync(`${root}/model-catalogs`)].map((entry) => entry.name)
        .sort();
      deepStrictEqual(paths, [
        'openai-chatgpt-account-a.json',
        'openai-chatgpt-account-b.json',
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

const genericWorkerConfiguration = () => {
  const configuration = workerConfigurationFixture();
  return {
    ...configuration,
    agent: { ...configuration.agent, name: 'generic' },
  };
};

class CapturingChildCapsule extends Increment170FoundationDataPortAgent {
  readonly commands: WorkerHostCommand[] = [];
  readonly readyMessages: WorkerReadyMessage[] = [];
  constructor() {
    super(({ command, turnNumber }) => {
      const transcript = [
        { role: 'user' as const, content: { kind: 'text' as const, text: command.task } },
        {
          role: 'assistant' as const,
          content: { kind: 'text' as const, text: 'ChatGPT child completed.' },
        },
      ];
      return foundationProposal({
        correlation: command.correlation,
        task: command.task,
        turn: turnNumber,
        transcript,
        outcome: {
          ok: true,
          outcome: 'final',
          stopReason: 'final',
          finalText: 'ChatGPT child completed.',
          steps: 1,
          toolCallCount: 0,
          toolResultCount: 0,
        },
      });
    }, genericWorkerConfiguration());
    this.subscribe((message) => {
      if (message.kind === 'ready') this.readyMessages.push(message);
    });
  }
  override send(command: WorkerHostCommand): void {
    this.commands.push(command);
    super.send(command);
  }
}

childDataTest('Increment 163 ChatGPT children freeze account selection at spawn', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-163-child-' });
  const capsules: CapturingChildCapsule[] = [];
  const declarations = builtinProviderDeclarations();
  setActiveProviderDeclarations(declarations);
  const otherProvider = selectModelFor(
    'openrouter-chat',
    'anthropic/claude-sonnet',
  );
  const chatgptModel = selectModelFor('openai-chatgpt', 'gpt-5.6-sol');
  let selectedRegistrationId = 'account-a';
  let currentModel = otherProvider;
  const auth = {
    ...mockAuth(),
    selectedRegistrationId: () => Promise.resolve(selectedRegistrationId),
  } as ChatGPTAuthService;
  const { registry, seedParentExecution } = await createChildDataTestRegistry({
    options: {
      configRoot: root,
      physicalIoMode: 'provider-free',
      providerDeclarations: declarations,
      capsuleFactory: () => {
        const capsule = new CapturingChildCapsule();
        capsules.push(capsule);
        return capsule;
      },
    },
    currentModelSelection: () => currentModel,
    chatgptAuth: auth,
    currentCatalog: () => ['generic'],
  });
  const parentExecutionId = 'increment-163-parent-turn';
  await seedParentExecution(parentExecutionId);
  registry.openParent(parentExecutionId, null);
  try {
    // An explicit ChatGPT child reads the selected account when this child is spawned.
    selectedRegistrationId = 'account-b';
    const spawning = registry.handle(
      {
        kind: 'spawn',
        agent: 'generic',
        task: 'Reply using the ChatGPT route.',
        model: {
          provider: chatgptModel.provider,
          modelId: chatgptModel.modelId,
          effort: chatgptModel.effort,
        },
      },
      'spawn-chatgpt',
      parentExecutionId,
    );
    // A later selection change while admission is in flight cannot retarget this child.
    selectedRegistrationId = 'account-c';
    const spawned = await spawning;
    strictEqual(selectedRegistrationId, 'account-c');
    ok(spawned.ok && spawned.kind === 'spawn', JSON.stringify(spawned));
    const capsule = capsules[0];
    ok(capsule);
    const start = capsule.commands.find((command) => command.kind === 'start');
    const turn = capsule.commands.find((command) => command.kind === 'turn');
    ok(start?.kind === 'start');
    ok(turn?.kind === 'turn');
    strictEqual(start.configRoot, root);
    const frozenModel = capsule.readyMessages[0]?.manifest?.rootModel;
    ok(frozenModel);
    strictEqual(frozenModel?.provider, 'openai-chatgpt');
    if (frozenModel?.provider !== 'openai-chatgpt') {
      throw new Error('ChatGPT child model was not selected');
    }
    strictEqual(
      'registrationId' in frozenModel ? frozenModel.registrationId : undefined,
      'account-b',
    );
    strictEqual(turn.chatgptRegistrationId, 'account-b');
    deepStrictEqual(
      otherProvider,
      selectModelFor('openrouter-chat', 'anthropic/claude-sonnet'),
    );

    const collected = await registry.handle(
      { kind: 'collect', runId: spawned.runId },
      undefined,
      parentExecutionId,
    );
    ok(collected.ok && collected.kind === 'collect', JSON.stringify(collected));
    strictEqual(collected.result.finalText, 'ChatGPT child completed.');

    // A ChatGPT parent with an omitted child model inherits the account frozen for its turn.
    const chatgptParentExecutionId = 'increment-163-chatgpt-parent-turn';
    currentModel = chatgptModel;
    selectedRegistrationId = 'account-c';
    await seedParentExecution(chatgptParentExecutionId);
    registry.openParent(chatgptParentExecutionId, 'account-parent-turn');
    const inheritedSpawn = await registry.handle(
      {
        kind: 'spawn',
        agent: 'generic',
        task: 'Inherit the ChatGPT parent route.',
      },
      'spawn-inherited',
      chatgptParentExecutionId,
    );
    ok(
      inheritedSpawn.ok && inheritedSpawn.kind === 'spawn',
      JSON.stringify(inheritedSpawn),
    );
    const inheritedStart = capsules[1]?.commands.find((command) => command.kind === 'start');
    const inheritedTurn = capsules[1]?.commands.find((command) => command.kind === 'turn');
    ok(inheritedStart?.kind === 'start');
    ok(inheritedTurn?.kind === 'turn');
    const inheritedModel = capsules[1]?.readyMessages[0]?.manifest?.rootModel;
    ok(inheritedModel);
    strictEqual(inheritedModel?.provider, 'openai-chatgpt');
    if (inheritedModel?.provider !== 'openai-chatgpt') {
      throw new Error('ChatGPT parent child route was not inherited');
    }
    strictEqual(
      (inheritedModel as ChatGPTModelSelection).registrationId,
      'account-parent-turn',
    );
    strictEqual(inheritedTurn.chatgptRegistrationId, 'account-parent-turn');
  } finally {
    await registry.cleanupAll();
    await closeChildDataTests();
    setActiveProviderDeclarations([]);
    await Deno.remove(root, { recursive: true });
  }
});
