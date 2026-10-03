import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import {
  captureFailureDetails,
  MAX_FAILURE_DETAILS_BYTES,
  validateFailureDetails,
} from '../../v0/agent/core/failure_details.ts';
import { FailureDiagnosticOwner } from '../../v0/agent/session/failure_diagnostic.ts';
import { runAgentTurn } from '../../v0/agent/core/loop.ts';
import type { ModelResult } from '../../v0/agent/core/contracts.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { OpenAIResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import type { OpenAIModelSelection } from '../../v0/agent/provider/model_selection.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import {
  type ProviderEvidenceObservation,
  ProviderEvidenceRecorder,
  validateProviderEvidenceObservation,
} from '../../v0/agent/provider/provider_evidence.ts';
import {
  OpenRouterAgentError,
  OpenRouterAgentModel,
} from '../../v0/agent/provider/openrouter_model.ts';
import { createProviderRequestDispatcher } from '../../v0/agent/provider/auxiliary_request.ts';
import {
  answer176,
  apiErrorStream176,
  completed176,
  frame176,
} from './helpers/increment_176_provider.ts';

const credential = 'i176-only-a-dummy-credential';
const request = {
  transcript: [{ role: 'user' as const, content: { kind: 'text' as const, text: 'Test' } }],
  tools: [],
};
const capture = async (fn: () => Promise<unknown>): Promise<OpenRouterAgentError> => {
  try {
    await fn();
  } catch (error) {
    ok(error instanceof OpenRouterAgentError);
    return error;
  }
  throw new Error('Expected provider failure');
};
const responses = (fetcher: typeof fetch) =>
  new OpenAIResponsesModel({
    selection: defaultModelSelectionFor('openai-responses') as OpenAIModelSelection,
    credentialSource: () => credential,
    fetcher,
  });
const sse = (text: string) =>
  new Response(text, {
    headers: {
      'content-type': 'text/event-stream',
      'x-request-id': 'i176-request',
    },
  });

Deno.test('Increment 176 bounds failure facts and removes known credential and Authorization before truncation', () => {
  const cause = Object.assign(new Error('cause'), { code: 'ECONNRESET' });
  const error = Object.assign(
    new Error(`${credential} Authorization: Bearer ${credential}\n` + '日本語'.repeat(5_000), {
      cause,
    }),
    { code: 'invalid_request', type: 'invalid_request_error', param: 'input' },
  );
  const details = captureFailureDetails(error, {
    operation: 'response_stream',
    secrets: [credential],
  });
  ok(validateFailureDetails(details));
  ok(new TextEncoder().encode(JSON.stringify(details)).length <= MAX_FAILURE_DETAILS_BYTES);
  ok(!JSON.stringify(details).includes(credential));
  ok(!JSON.stringify(details).includes('Bearer '));
  strictEqual(details.truncated, true);
  strictEqual(details.causeType, 'Error');
  strictEqual(details.causeCode, 'ECONNRESET');
  strictEqual(details.param, 'input');
});

Deno.test('Increment 176 classifies HTTP 200 SDK API failure and retains bounded request/stream facts', async () => {
  const observations: ProviderEvidenceObservation[] = [];
  const evidence = new ProviderEvidenceRecorder(undefined, 1, undefined, (fact) => {
    observations.push(fact);
    return observations.length;
  });
  const model = responses(() => Promise.resolve(sse(apiErrorStream176(credential))));
  const error = await capture(() => model.generate(request, { providerEvidence: evidence }));
  strictEqual(error.code, 'response_error');
  strictEqual(error.failureFact.httpStatus, 200);
  strictEqual(error.failureFact.parseReason, 'provider_reported_error');
  const details = error.failureFact.details!;
  strictEqual(details.exceptionType, 'APIError');
  strictEqual(details.errorType, 'invalid_request_error');
  strictEqual(details.errorCode, 'invalid_request');
  strictEqual(details.param, 'input');
  strictEqual(details.requestId, 'i176-request');
  strictEqual(details.responseId, 'i176-response');
  strictEqual(details.streamEventCount, 2);
  strictEqual(details.lastStreamEvent, 'response.reasoning_summary_text.delta');
  strictEqual(details.completedReceived, false);
  ok(!JSON.stringify(observations).includes(credential));
  ok(observations.every(validateProviderEvidenceObservation));
  const owner = new FailureDiagnosticOwner(1);
  const outcome = await runAgentTurn('Test', [], model, new Registry([]), {
    diagnosticOwner: owner,
  });
  deepStrictEqual(outcome.diagnostic?.details, details);
});

Deno.test('Increment 176 distinguishes transport and response parsing while leaving successful observations unchanged', async () => {
  const network = await capture(() =>
    responses(() =>
      Promise.reject(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))
    ).generate(request)
  );
  strictEqual(network.code, 'transport_error');
  strictEqual(network.failureFact.details?.exceptionType, 'APIConnectionError');
  strictEqual(network.failureFact.details?.causeCode, 'ECONNRESET');
  const shape = await capture(() =>
    responses(() =>
      Promise.resolve(
        sse(frame176({ type: 'response.completed', response: { id: 'bad', output: 42 } })),
      )
    ).generate(request)
  );
  strictEqual(shape.code, 'response_error');
  strictEqual(shape.failureFact.details?.field, 'response.output');
  strictEqual(shape.failureFact.details?.actualShape, 'number');
  const facts: ProviderEvidenceObservation[] = [];
  const evidence = new ProviderEvidenceRecorder(undefined, 1, undefined, (fact) => {
    facts.push(fact);
  });
  const result = await responses(() => Promise.resolve(sse(frame176(completed176([answer176])))))
    .generate(request, { providerEvidence: evidence });
  strictEqual(result.kind, 'final');
  deepStrictEqual(facts.map((fact) => fact.kind), ['request_start', 'response_start']);
  ok(!JSON.stringify(facts).includes('details'));
});

Deno.test('Increment 176 retains Chat Completions and auxiliary transport causes at their credential boundary', async () => {
  const thrown = Object.assign(new Error(`socket reset for ${credential}`), { code: 'ECONNRESET' });
  const chat = new OpenRouterAgentModel({ credential, fetcher: () => Promise.reject(thrown) });
  const error = await capture(() => chat.generate(request));
  strictEqual(error.failureFact.details?.errorCode, 'ECONNRESET');
  ok(!JSON.stringify(error.failureFact).includes(credential));
  const dispatch = createProviderRequestDispatcher({
    resolveCredential: () => credential,
    fetcher: () => Promise.reject(thrown),
  });
  let aux: unknown;
  try {
    await dispatch({
      authProfile: 'exa-api-key',
      endpoint: 'https://local.invalid',
      method: 'POST',
    });
  } catch (error) {
    aux = error;
  }
  const details = captureFailureDetails(aux);
  strictEqual(details.errorCode, 'ECONNRESET');
  strictEqual(details.operation, 'auxiliary_fetch');
  ok(!JSON.stringify(details).includes(credential));
});

Deno.test('Increment 176 keeps Chat SSE API metadata, reader causes and parser fields without changing stream classification', async () => {
  const make = (fetcher: typeof fetch) =>
    new OpenRouterAgentModel({ credential, fetcher, responseMode: 'sse' });
  const api = await capture(() =>
    make(() =>
      Promise.resolve(sse(frame176({
        error: {
          message: `Rejected ${credential}`,
          code: 'invalid_request',
          type: 'invalid_request_error',
          param: 'messages',
        },
      })))
    ).generate(request)
  );
  strictEqual(api.failureFact.parseReason, 'provider_reported_error');
  strictEqual(api.failureFact.details?.exceptionType, 'ProviderAPIError');
  strictEqual(api.failureFact.details?.errorCode, 'invalid_request');
  strictEqual(api.failureFact.details?.streamEventCount, 1);
  ok(!JSON.stringify(api.failureFact.details).includes(credential));
  const parse = await capture(() =>
    make(() =>
      Promise.resolve(
        sse(frame176({ id: 'chat-id', choices: [{ index: 0, delta: { content: 42 } }] })),
      )
    ).generate(request)
  );
  strictEqual(parse.failureFact.details?.field, 'choices[0].delta.content');
  strictEqual(parse.failureFact.details?.actualShape, 'number');
  const readError = Object.assign(new Error(`Connection lost ${credential}`), {
    code: 'ECONNRESET',
  });
  const failedBody = new ReadableStream<Uint8Array>({
    pull() {
      throw readError;
    },
  });
  const read = await capture(() =>
    make(() =>
      Promise.resolve(
        new Response(failedBody, { headers: { 'content-type': 'text/event-stream' } }),
      )
    ).generate(request)
  );
  strictEqual(read.failureFact.parseReason, 'response_stream_failed');
  strictEqual(read.failureFact.details?.errorCode, 'ECONNRESET');
  ok(!JSON.stringify(read.failureFact.details).includes(credential));
  const buffered = await capture(() =>
    new OpenRouterAgentModel({
      credential,
      responseMode: 'json',
      fetcher: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                throw readError;
              },
            }),
          ),
        ),
    }).generate(request)
  );
  strictEqual(buffered.failureFact.details?.errorCode, 'ECONNRESET');
  ok(!JSON.stringify(buffered.failureFact.details).includes(credential));
});

Deno.test('Increment 176 adds tool exception facts to the existing result and commit exception facts to the existing diagnostic', async () => {
  const registry = new Registry([{
    name: 'broken',
    description: '',
    inputSchema: {},
    execute() {
      throw Object.assign(
        new Error('File could not be read', {
          cause: Object.assign(new Error('missing'), { code: 'ENOENT' }),
        }),
        { code: 'read_failed' },
      );
    },
  }]);
  const result = await registry.dispatch({ name: 'broken', callId: 'read-1', arguments: {} });
  strictEqual(result.content.outcome, 'error');
  if ('failure' in result.content) {
    strictEqual(result.content.failure?.errorCode, 'read_failed');
    strictEqual(result.content.failure?.causeCode, 'ENOENT');
  } else throw new Error('Tool failure metadata missing');
  const owner = new FailureDiagnosticOwner(1);
  const outcome = await runAgentTurn(
    'Test',
    [],
    { generate: () => ({ kind: 'final', text: 'Done' }) },
    new Registry([]),
    {
      diagnosticOwner: owner,
      commit() {
        throw Object.assign(new Error('write failed'), { code: 'EIO' });
      },
    },
  );
  strictEqual(outcome.diagnostic?.stage, 'session_commit');
  strictEqual(outcome.diagnostic?.details?.errorCode, 'EIO');
});

Deno.test('Increment 176 retains the existing invalid model result classification with short contract facts', async () => {
  const outcome = await runAgentTurn(
    'Test',
    [],
    {
      generate: () => ({ kind: 'final', text: 42 } as unknown as ModelResult),
    },
    new Registry([]),
    { diagnosticOwner: new FailureDiagnosticOwner(1) },
  );
  strictEqual(outcome.diagnostic?.code, 'invalid_model_result');
  strictEqual(outcome.diagnostic?.details?.operation, 'model_result_validation');
  strictEqual(outcome.diagnostic?.details?.field, 'result');
  strictEqual(outcome.diagnostic?.details?.actualShape, 'object');
});
