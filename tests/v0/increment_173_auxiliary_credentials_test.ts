import {
  ParentTurnExecutionContext,
  TurnRequestBudget,
} from '../../v0/agent/core/execution_context.ts';
import {
  builtinCredentialDeclarations,
  CredentialDeclarationError,
  loadCredentialDeclarations,
} from '../../v0/agent/provider/credential_declaration.ts';
import { createCredentialRegistration } from '../../v0/agent/provider/credential_registration.ts';
import {
  ProviderEvidenceRecorder,
  validateProviderEvidenceObservation,
} from '../../v0/agent/provider/provider_evidence.ts';
import {
  createProductionPhysicalIo,
  createWorkerRequestCounter,
} from '../../v0/agent/worker/worker_physical_io.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

Deno.test('external service registration declarations load beside bundled Exa metadata', async () => {
  const configRoot = await Deno.makeTempDir();
  try {
    assert((await loadCredentialDeclarations({ configRoot })).length === 0);
    await Deno.mkdir(`${configRoot}/credentials`);
    await Deno.writeTextFile(
      `${configRoot}/credentials/brave.json`,
      JSON.stringify({
        schemaVersion: 1,
        authProfile: 'brave-api-key',
        label: 'Brave — API key',
        purpose: 'Web search',
        method: 'api-key',
        consumers: ['tool:brave_search'],
      }),
    );
    const declarations = [
      ...builtinCredentialDeclarations(),
      ...await loadCredentialDeclarations({ configRoot }),
    ];
    assert(declarations.length === 2);
    assert(declarations[0].authProfile === 'exa-api-key');
    assert(declarations[1].authProfile === 'brave-api-key');
    assert(declarations[1].consumers[0] === 'tool:brave_search');
    assert(declarations[1].method === 'api-key');
  } finally {
    await Deno.remove(configRoot, { recursive: true });
  }
});

Deno.test('invalid declaration JSON errors do not quote the source contents', async () => {
  const configRoot = await Deno.makeTempDir();
  const input = 'dummy-private-value-not-valid-json';
  try {
    await Deno.mkdir(`${configRoot}/credentials`);
    await Deno.writeTextFile(`${configRoot}/credentials/service.json`, input);
    let failure: unknown;
    try {
      await loadCredentialDeclarations({ configRoot });
    } catch (error) {
      failure = error;
    }
    assert(failure instanceof CredentialDeclarationError);
    assert(failure.message === 'credential declaration was not valid JSON');
    assert(!failure.message.includes(input));
  } finally {
    await Deno.remove(configRoot, { recursive: true });
  }
});

Deno.test('registered service keys resolve at dispatch for named-header GET and default Bearer', async () => {
  const configRoot = await Deno.makeTempDir();
  const observed: Array<
    {
      method: string;
      named: string | null;
      bearer: string | null;
      body: string;
      query: string | null;
    }
  > = [];
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen: () => {} },
    async (request) => {
      observed.push({
        method: request.method,
        named: request.headers.get('X-Subscription-Token'),
        bearer: request.headers.get('authorization'),
        body: await request.text(),
        query: new URL(request.url).searchParams.get('q'),
      });
      return Response.json({ results: [{ title: 'Local result' }] });
    },
  );
  try {
    const registration = createCredentialRegistration({ configRoot });
    await registration.save('brave-api-key', 'dummy-brave-old');
    const counter = createWorkerRequestCounter();
    const physicalIo = createProductionPhysicalIo(counter, { configRoot });
    // Updating through the same registration path must be seen without rebuilding the Worker I/O.
    await registration.save('brave-api-key', 'dummy-brave-updated');
    await registration.save('exa-api-key', 'dummy-exa');
    const evidence = new ProviderEvidenceRecorder();
    const execution = new ParentTurnExecutionContext(
      1,
      new TurnRequestBudget({ parent: 1, aggregate: 1 }),
      undefined,
      undefined,
      undefined,
      counter.count,
      counter.count,
      evidence,
    );
    const endpoint = `http://127.0.0.1:${server.addr.port}/search?q=local`;
    const response = await physicalIo.requestProvider!({
      endpoint,
      authProfile: 'brave-api-key',
      method: 'GET',
      authentication: { kind: 'header', name: 'X-Subscription-Token' },
      evidence: {
        execution,
        phase: 'user_turn',
        modelStep: 1,
        requestMetadata: { provider: 'brave', api: 'brave-search', authProfile: 'brave-api-key' },
      },
    });
    assert(response.status === 200);
    assert(new TextDecoder().decode(response.bytes).includes('Local result'));
    await physicalIo.requestProvider!({ endpoint, authProfile: 'exa-api-key', method: 'POST' });
    assert(observed.length === 2);
    assert(observed[0].method === 'GET');
    assert(observed[0].query === 'local');
    assert(observed[0].body === '');
    assert(observed[0].named === 'dummy-brave-updated');
    assert(observed[0].bearer === null);
    assert(observed[1].named === null);
    assert(observed[1].bearer === 'Bearer dummy-exa');
    assert(counter.count() === 2);
    assert(execution.snapshot().aggregate === 0);
    const snapshot = evidence.snapshot();
    assert(snapshot.requests.length === 1);
    const record = snapshot.requests[0];
    assert(record.request.method === 'GET');
    assert(record.request.requestMetadata.api === 'brave-search');
    assert(
      validateProviderEvidenceObservation({ kind: 'request_start', request: record.request }),
    );
    assert(
      validateProviderEvidenceObservation({
        kind: 'response_start',
        requestOrdinal: record.request.ordinal,
        response: record.response,
      }),
    );
    const serialized = JSON.stringify({ snapshot, response });
    assert(!serialized.includes('dummy-brave-updated'));
    assert(!serialized.includes('dummy-exa'));
    assert(!serialized.toLowerCase().includes('authorization'));
    assert(!serialized.toLowerCase().includes('x-subscription-token'));
  } finally {
    await server.shutdown();
    await Deno.remove(configRoot, { recursive: true });
  }
});
