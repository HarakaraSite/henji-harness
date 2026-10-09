import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
} from '../../v0/agent/provider/provider_evidence.ts';
import { deepStrictEqual, strictEqual } from 'node:assert';
import type { Model, ModelRequest } from '../../v0/agent/core/contracts.ts';
import { OpenRouterAgentModel } from '../../v0/agent/provider/openrouter_transport.ts';
import { ChatGPTResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import { PRODUCTION_PROFILE } from '../../v0/agent/provider/provider_profile.ts';
import { resolveContextBudget } from '../../v0/agent/session/context_budget.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { createProductionPhysicalIo } from '../../v0/agent/worker/worker_physical_io.ts';
import { validateProviderDeclaration } from '../../v0/agent/provider/provider_declaration.ts';
import type { ModelSelection } from '../../v0/agent/provider/model_selection.ts';

const request: ModelRequest = {
  systemInstruction: 'Keep the original instruction 日本語.',
  transcript: [{ role: 'user', content: { kind: 'text', text: 'Read marker.' } }],
  tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object' } }],
};

Deno.test('Increment 218 production deferred Chat reserves the output it sends before its first request', async () => {
  const declaration = validateProviderDeclaration({
    schemaVersion: 1,
    providerId: 'opencode-go-chat',
    protocol: 'openai-chat-completions',
    endpoint: 'https://opencode.ai/zen/go/v1',
    authProfile: 'opencode-go-api-key',
    modelCatalog: {
      kind: 'fixed',
      entries: [{ modelId: 'deepseek-v4.1-flash', defaultEffort: 'auto', efforts: ['auto'] }],
    },
    defaults: { modelId: 'deepseek-v4.1-flash', effort: 'auto' },
  });
  const selections: ModelSelection[] = [ROOT_DEFAULT_MODEL_SELECTION, {
    provider: declaration.providerId,
    api: 'openai-chat-completions',
    authProfile: declaration.authProfile,
    modelId: declaration.defaults.modelId,
    effort: declaration.defaults.effort,
  }];
  let sent = '';
  const physical = createProductionPhysicalIo(undefined, {
    credentialRoot: '/tmp/henji-218-unused-credentials',
    credentialSources: {
      'openrouter-api-key': () => Promise.resolve('fixture-key'),
      'opencode-go-api-key': () => Promise.resolve('fixture-key'),
    },
    providerDeclarations: [declaration],
    fetcher: (_url, init) => {
      sent = String(init?.body);
      return Promise.resolve(
        new Response(
          'data: ' + JSON.stringify({
            id: 'gen_increment_218',
            choices: [{
              index: 0,
              delta: { role: 'assistant', content: 'Done.' },
              finish_reason: 'stop',
              native_finish_reason: 'stop',
            }],
          }) + '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    },
  });
  for (const selection of selections) {
    const model = physical.createModel('parent', selection);
    const budget = resolveContextBudget(
      { defaults: { contextTokens: 100_000, outputReserve: 2048 } },
      selection,
      model.requestOutputReserve,
    );
    strictEqual(budget.outputReserve, PRODUCTION_PROFILE.maxCompletionTokens);
    strictEqual(budget.inputLimit, 100_000 - PRODUCTION_PROFILE.maxCompletionTokens);
    await model.generate(request);
    strictEqual(budget.outputReserve, JSON.parse(sent).max_completion_tokens);
  }
});

Deno.test('Increment 218 counts the same Chat body that the adapter sends and reserves its output', async () => {
  let sent = '';
  const observations: ProviderEvidenceObservation[] = [];
  const evidence = new ProviderEvidenceRecorder(undefined, undefined, undefined, (fact) => {
    observations.push(fact);
    return 1;
  });
  evidence.setInputTokenEstimate(77);
  const model = new OpenRouterAgentModel({
    profile: { ...PRODUCTION_PROFILE, maxCompletionTokens: 2048, reasoningEffort: 'high' },
    credentialSource: () => Promise.resolve('fixture-credential'),
    fetcher: (_url, init) => {
      sent = String(init?.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 65, completion_tokens: 2, total_tokens: 67 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    },
  });
  const measured = model.measureRequestWire!(request);
  await model.generate(request, { providerEvidence: evidence });
  deepStrictEqual(observations.find((fact) => fact.kind === 'request_usage'), {
    kind: 'request_usage',
    requestOrdinal: 1,
    usage: {
      inputTokens: 65,
      outputTokens: 2,
      totalTokens: 67,
      estimatedInputTokens: 77,
      inputEstimateDifference: -12,
    },
  });
  strictEqual(measured.bodyBytes, new TextEncoder().encode(sent).byteLength);
  const body = JSON.parse(sent);
  strictEqual(
    measured.messagesBytes,
    new TextEncoder().encode(JSON.stringify(body.messages)).byteLength,
  );
  strictEqual(body.max_completion_tokens, 2048);
  const budget = resolveContextBudget(
    { defaults: { contextTokens: 8192 } },
    ROOT_DEFAULT_MODEL_SELECTION,
    model.requestOutputReserve,
  );
  strictEqual(budget.outputReserve, 2048);
  strictEqual(budget.inputLimit, 6144);
});

Deno.test('Increment 218 Responses budget includes actual reasoning and namespace wire fields', async () => {
  let sent = '';
  const model: Model = new ChatGPTResponsesModel({
    selection: {
      provider: 'openai-chatgpt',
      api: 'openai-responses',
      authProfile: 'openai-chatgpt',
      modelId: 'fixture-model',
      effort: 'high',
    },
    credentialSource: () => Promise.resolve('fixture-credential'),
    fetcher: async (input, init) => {
      sent = init?.body === undefined ? await new Request(input).text() : String(init.body);
      return new Response(
        'data: ' + JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'response-1',
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Done.' }],
            }],
          },
        }) + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const measured = model.measureRequestWire!(request);
  await model.generate(request);
  strictEqual(measured.bodyBytes, new TextEncoder().encode(sent).byteLength);
  const body = JSON.parse(sent);
  deepStrictEqual(body.include, ['reasoning.encrypted_content']);
  deepStrictEqual(body.reasoning, { summary: 'auto', effort: 'high' });
  strictEqual(body.tools[0].type, 'namespace');
  strictEqual(body.store, false);
  strictEqual(
    measured.messagesBytes,
    new TextEncoder().encode(JSON.stringify(body.input)).byteLength,
  );
});
