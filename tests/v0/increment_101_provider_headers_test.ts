import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import {
  ProviderDeclarationError,
  validateProviderDeclaration,
} from '../../v0/agent/provider/provider_declaration.ts';
import {
  type DeclaredChatModelSelection,
  type DeclaredProviderModelSelection,
  isAuthProfileId,
  isStoredModelSelection,
} from '../../v0/agent/provider/model_selection.ts';
import { credentialFileFor } from '../../v0/agent/provider/credential_file.ts';
import { createProductionPhysicalIo } from '../../v0/agent/worker/worker_physical_io.ts';
import {
  ProviderEvidenceRecorder,
  validateProviderEvidenceObservation,
} from '../../v0/agent/provider/provider_evidence.ts';
import { OpenRouterAgentError } from '../../v0/agent/provider/openrouter_contract.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const request: ModelRequest = {
  systemInstruction: 'Answer briefly.',
  transcript: [{ role: 'user', content: { kind: 'text', text: 'Say hello.' } }],
  tools: [],
};

const chatStream = (text: string): string =>
  `data: ${
    JSON.stringify({
      id: 'gen_increment_101',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: 'stop',
        native_finish_reason: 'stop',
      }],
    })
  }\n\ndata: ${
    JSON.stringify({
      id: 'gen_increment_101',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: 'stop',
        native_finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
        cost: 0,
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    })
  }\n\ndata: [DONE]\n\n`;

const responsesStream = (text: string): string => {
  const response = {
    id: 'resp_increment_101',
    object: 'response',
    created_at: 1_788_800_000,
    status: 'completed',
    model: 'grok-4.6',
    output: [{
      id: 'msg_increment_101',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    }],
    output_text: text,
  };
  return [
    `data: ${
      JSON.stringify({ type: 'response.created', response: { ...response, status: 'in_progress' } })
    }\n\n`,
    `data: ${
      JSON.stringify({
        type: 'response.output_text.delta',
        delta: text,
        item_id: 'msg_increment_101',
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        logprobs: [],
      })
    }\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response, sequence_number: 2 })}\n\n`,
  ].join('');
};

const chatDeclaration = (
  headers?: Record<string, string>,
): ReturnType<typeof validateProviderDeclaration> =>
  validateProviderDeclaration({
    schemaVersion: 1,
    providerId: 'opencode-go-chat',
    protocol: 'openai-chat-completions',
    endpoint: 'https://opencode.ai/zen/go/v1',
    authProfile: 'opencode-go-api-key',
    ...(headers === undefined ? {} : { headers }),
    modelCatalog: {
      kind: 'fixed',
      entries: [{ modelId: 'glm-5.3-flash', defaultEffort: 'auto', efforts: ['auto'] }],
    },
    defaults: { modelId: 'glm-5.3-flash', effort: 'auto' },
  });

const responsesDeclaration = (
  headers?: Record<string, string>,
): ReturnType<typeof validateProviderDeclaration> =>
  validateProviderDeclaration({
    schemaVersion: 1,
    providerId: 'opencode-go-responses',
    protocol: 'openai-responses',
    endpoint: 'https://opencode.ai/zen/go/v1',
    authProfile: 'opencode-go-api-key',
    ...(headers === undefined ? {} : { headers }),
    modelCatalog: {
      kind: 'fixed',
      entries: [{ modelId: 'grok-4.6', defaultEffort: 'auto', efforts: ['auto'] }],
    },
    defaults: { modelId: 'grok-4.6', effort: 'auto' },
  });

const declarationCodeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ProviderDeclarationError) return error.code;
    throw error;
  }
  return 'no_error';
};

Deno.test('Increment 101 auth profile identity is pattern validated and reserved names rejected', () => {
  assert(isAuthProfileId('opencode-go-api-key'));
  assert(isAuthProfileId('openrouter-api-key'));
  assert(!isAuthProfileId('Upper'));
  assert(!isAuthProfileId('/etc/passwd'));
  assert(!isAuthProfileId('providers'));
  assert(!isAuthProfileId('instruction'));
  assert(!isAuthProfileId(''));
  assert(!isAuthProfileId(42));
});

Deno.test('Increment 101 stored selection keeps built-in literals and accepts declared profiles', () => {
  assert(isStoredModelSelection({
    provider: 'opencode-go-chat',
    api: 'openai-chat-completions',
    authProfile: 'opencode-go-api-key',
    modelId: 'glm-5.3-flash',
    effort: 'auto',
  }));
  assert(
    !isStoredModelSelection({
      provider: 'openrouter-chat',
      api: 'openrouter-chat-completions',
      authProfile: 'opencode-go-api-key',
      modelId: 'x',
      effort: 'auto',
    }),
  );
  assert(
    !isStoredModelSelection({
      provider: 'opencode-go-chat',
      api: 'openai-chat-completions',
      authProfile: 'providers',
      modelId: 'x',
      effort: 'auto',
    }),
  );
});

Deno.test('Increment 101 declaration accepts new provider headers and rejects invalid ones', () => {
  const declaration = chatDeclaration({
    'user-agent': 'Henji-Harness',
    'x-opencode-session': '{sessionId}',
  });
  assertEquals(declaration.headers, {
    'user-agent': 'Henji-Harness',
    'x-opencode-session': '{sessionId}',
  });

  assertEquals(
    declarationCodeOf(() =>
      validateProviderDeclaration({
        ...chatDeclaration(),
        providerId: 'openrouter-chat',
        headers: { 'x-test': '1' },
      })
    ),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => chatDeclaration({ 'content-type': 'text/plain' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => chatDeclaration({ 'X-Test': 'a', 'x-test': 'b' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => chatDeclaration({ 'x-empty': '' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => chatDeclaration({ 'x-bad': 'value{unknown}' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => chatDeclaration({ 'x-bad': 'value{' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => chatDeclaration({ 'x-bad': '{ credential }' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => chatDeclaration({ authorization: '{credential}' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() =>
      chatDeclaration({ authorization: 'Bearer {credential}', 'x-api-key': '{credential}' })
    ),
    'provider_declaration_invalid',
  );
});

Deno.test('Increment 101 Responses protocol rejects credential placement', () => {
  assertEquals(
    declarationCodeOf(() => responsesDeclaration({ authorization: 'Bearer {credential}' })),
    'provider_declaration_invalid',
  );
  assertEquals(
    declarationCodeOf(() => responsesDeclaration({ 'x-api-key': '{credential}' })),
    'provider_declaration_invalid',
  );
  const allowed = responsesDeclaration({ 'x-opencode-session': '{sessionId}' });
  assertEquals(allowed.headers, { 'x-opencode-session': '{sessionId}' });
});

Deno.test('Increment 101 chat sends declared headers and keeps the standard Bearer', async () => {
  const seen: { authorization?: string; userAgent?: string; session?: string } = {};
  const fetcher: typeof fetch = (input, init) => {
    const requested = input instanceof Request ? input : new Request(input, init);
    seen.authorization = requested.headers.get('authorization') ?? undefined;
    seen.userAgent = requested.headers.get('user-agent') ?? undefined;
    seen.session = requested.headers.get('x-opencode-session') ?? undefined;
    return Promise.resolve(
      new Response(chatStream('hello'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  const declaration = chatDeclaration({
    'user-agent': 'Henji-Harness',
    'x-opencode-session': '{sessionId}',
  });
  const selection: DeclaredChatModelSelection = {
    provider: 'opencode-go-chat',
    api: 'openai-chat-completions',
    authProfile: 'opencode-go-api-key',
    modelId: 'glm-5.3-flash',
    effort: 'auto',
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSources: { 'opencode-go-api-key': () => Promise.resolve('opencode-secret') },
    sessionId: 'session-101',
    fetcher,
    providerDeclarations: [declaration],
  });
  const evidence = new ProviderEvidenceRecorder();
  const result = await physical.createModel('parent', selection).generate(request, {
    providerEvidence: evidence,
    providerEvidenceLane: 'parent',
    modelStep: 1,
  });
  assertEquals(result.kind, 'final');
  assertEquals(seen.authorization, 'Bearer opencode-secret');
  assertEquals(seen.userAgent, 'Henji-Harness');
  assertEquals(seen.session, 'session-101');
  const snapshot = evidence.snapshot();
  assertEquals(snapshot.requests[0].request.requestMetadata.authProfile, 'opencode-go-api-key');
  assert(validateProviderEvidenceObservation({
    kind: 'request_start',
    request: snapshot.requests[0].request,
  }));
  assert(!JSON.stringify(snapshot).includes('opencode-secret'));
});

Deno.test('Increment 101 chat declared credential header replaces the default Bearer', async () => {
  const seen: { authorization?: string; apiKey?: string } = {};
  const fetcher: typeof fetch = (input, init) => {
    const requested = input instanceof Request ? input : new Request(input, init);
    seen.authorization = requested.headers.get('authorization') ?? undefined;
    seen.apiKey = requested.headers.get('x-api-key') ?? undefined;
    return Promise.resolve(
      new Response(chatStream('hello'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  const declaration = chatDeclaration({ 'x-api-key': '{credential}' });
  const selection: DeclaredChatModelSelection = {
    provider: 'opencode-go-chat',
    api: 'openai-chat-completions',
    authProfile: 'opencode-go-api-key',
    modelId: 'glm-5.3-flash',
    effort: 'auto',
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSources: { 'opencode-go-api-key': () => Promise.resolve('opencode-secret') },
    fetcher,
    providerDeclarations: [declaration],
  });
  await physical.createModel('parent', selection).generate(request, {});
  assertEquals(seen.authorization, undefined);
  assertEquals(seen.apiKey, 'opencode-secret');
});

Deno.test('Increment 101 missing session id fails with invalid_input', async () => {
  const declaration = chatDeclaration({ 'x-opencode-session': '{sessionId}' });
  const selection: DeclaredChatModelSelection = {
    provider: 'opencode-go-chat',
    api: 'openai-chat-completions',
    authProfile: 'opencode-go-api-key',
    modelId: 'glm-5.3-flash',
    effort: 'auto',
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSources: { 'opencode-go-api-key': () => Promise.resolve('opencode-secret') },
    fetcher: () => Promise.resolve(new Response(chatStream('hello'), { status: 200 })),
    providerDeclarations: [declaration],
  });
  let code: string | undefined;
  try {
    await physical.createModel('parent', selection).generate(request, {});
  } catch (error) {
    code = error instanceof OpenRouterAgentError ? error.code : 'unexpected';
  }
  assertEquals(code, 'invalid_input');
});

Deno.test('Increment 101 Responses sends declared session header with a single Bearer', async () => {
  const seen: { authorization?: string; session?: string; userAgent?: string } = {};
  const fetcher: typeof fetch = (input, init) => {
    const requested = input instanceof Request ? input : new Request(input, init);
    seen.authorization = requested.headers.get('authorization') ?? undefined;
    seen.session = requested.headers.get('x-opencode-session') ?? undefined;
    seen.userAgent = requested.headers.get('user-agent') ?? undefined;
    return Promise.resolve(
      new Response(responsesStream('hello'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  const declaration = responsesDeclaration({
    'user-agent': 'Henji-Harness',
    'x-opencode-session': '{sessionId}',
  });
  const selection: DeclaredProviderModelSelection = {
    provider: 'opencode-go-responses',
    api: 'openai-responses',
    authProfile: 'opencode-go-api-key',
    modelId: 'grok-4.6',
    effort: 'auto',
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSources: { 'opencode-go-api-key': () => Promise.resolve('opencode-secret') },
    sessionId: 'session-101',
    fetcher,
    providerDeclarations: [declaration],
  });
  const result = await physical.createModel('parent', selection).generate(request, {});
  assertEquals(result.kind, 'final');
  assertEquals(seen.authorization, 'Bearer opencode-secret');
  assertEquals(seen.session, 'session-101');
  assertEquals(seen.userAgent, 'Henji-Harness');
});

Deno.test('Increment 101 credential availability generalizes to declared profiles', async () => {
  const injected = createProductionPhysicalIo(undefined, {
    credentialSources: { 'opencode-go-api-key': () => Promise.resolve('x') },
  });
  assertEquals(await injected.credentialAvailability!('opencode-go-api-key'), 'unknown');

  const seam = createProductionPhysicalIo(undefined, {
    credentialPresence: (profile) =>
      Promise.resolve(profile === 'opencode-go-api-key' ? 'present' : 'missing'),
  });
  assertEquals(await seam.credentialAvailability!('opencode-go-api-key'), 'present');
  assertEquals(await seam.credentialAvailability!('other-profile'), 'missing');
});

Deno.test('Increment 101 credential file path derives from the profile identity', () => {
  assert(credentialFileFor('opencode-go-api-key').endsWith('/henji-harness/opencode-go-api-key'));
  let rejected = false;
  try {
    credentialFileFor('providers');
  } catch {
    rejected = true;
  }
  assert(rejected);
});

const openCodeGoChatStream = (options: { usageFirst?: boolean } = {}): string => {
  const id = 'chatcmpl_increment_101';
  const chunk = (choices: unknown[], usage: unknown) =>
    `data: ${
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'glm-5.3-flash',
        choices,
        usage,
      })
    }\n\n`;
  const usageFrame = chunk([], {
    prompt_tokens: 31,
    completion_tokens: 58,
    total_tokens: 89,
    prompt_tokens_details: { cached_tokens: 0 },
  });
  return [
    ...(options.usageFirst ? [usageFrame] : []),
    chunk([{
      index: 0,
      finish_reason: null,
      delta: { role: 'assistant', content: '', refusal: null },
    }], null),
    chunk([{ index: 0, finish_reason: null, delta: { reasoning_content: 'thinking' } }], null),
    chunk([{ index: 0, finish_reason: null, delta: { content: 'PROBE_CHAT_OK' } }], null),
    chunk([{ index: 0, finish_reason: 'stop', delta: {} }], null),
    ...(options.usageFirst ? [] : [usageFrame]),
    'data: [DONE]\n\n',
  ].join('');
};

const chatModel = (stream: string) => {
  const declaration = chatDeclaration();
  const selection: DeclaredChatModelSelection = {
    provider: 'opencode-go-chat',
    api: 'openai-chat-completions',
    authProfile: 'opencode-go-api-key',
    modelId: 'glm-5.3-flash',
    effort: 'auto',
  };
  const physical = createProductionPhysicalIo(undefined, {
    credentialSources: { 'opencode-go-api-key': () => Promise.resolve('opencode-secret') },
    fetcher: () =>
      Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    providerDeclarations: [declaration],
  });
  return physical.createModel('parent', selection);
};

Deno.test('Increment 101 chat accepts OpenCode Go usage-null chunks and an empty-choices usage frame', async () => {
  const result = await chatModel(openCodeGoChatStream()).generate(request, {});
  assertEquals(result, { kind: 'final', text: 'PROBE_CHAT_OK' });
});

Deno.test('Increment 101 chat accepts a terminal frame that carries usage', async () => {
  const id = 'chatcmpl_terminal_usage';
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 0 },
  };
  const chunk = (choices: unknown[], frameUsage: unknown) =>
    `data: ${
      JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4.1-flash',
        choices,
        usage: frameUsage,
      })
    }\n\n`;
  const stopStream = [
    chunk(
      [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: 'hello' } }],
      null,
    ),
    chunk([{ index: 0, finish_reason: 'stop', delta: {} }], usage),
    'data: [DONE]\n\n',
  ].join('');
  assertEquals(
    await chatModel(stopStream).generate(request, {}),
    { kind: 'final', text: 'hello' },
  );

  const toolStream = [
    chunk([{
      index: 0,
      finish_reason: null,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"ping"}' },
        }],
      },
    }], null),
    chunk([{ index: 0, finish_reason: 'tool_calls', delta: {} }], usage),
    'data: [DONE]\n\n',
  ].join('');
  const toolResult = await chatModel(toolStream).generate(request, {});
  assertEquals(toolResult.kind, 'tool_calls');
  if (toolResult.kind === 'tool_calls') {
    assertEquals(toolResult.calls[0].name, 'echo');
  }
});

Deno.test('Increment 101 chat rejects a usage-only frame before the terminal frame', async () => {
  let code: string | undefined;
  try {
    await chatModel(openCodeGoChatStream({ usageFirst: true })).generate(request, {});
  } catch (error) {
    code = error instanceof OpenRouterAgentError ? error.code : 'unexpected';
  }
  assertEquals(code, 'response_error');
});
