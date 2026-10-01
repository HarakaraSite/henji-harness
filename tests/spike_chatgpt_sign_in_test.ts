import {
  consumeResponse,
  createAuthorization,
  infer,
  parseCallback,
  parseModels,
  ProbeHttp,
  SpikeFailure,
  tokenSet,
  verifyIdentity,
} from '../scripts/spike_chatgpt_sign_in.ts';
import type { Fact } from '../scripts/spike_chatgpt_sign_in.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_')
    .replace(/=+$/u, '');

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req_spike_test',
    },
  });

const recorder = (facts: Fact[]) => (fact: Fact): Promise<void> => {
  facts.push(fact);
  return Promise.resolve();
};

const sse = (events: unknown[]) => {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''),
  );
  // Transport can divide a UTF-8 character or SSE frame at any chunk boundary.
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 7));
        offset += 7;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

Deno.test('manual OAuth callback, signed identity, grant and account models follow the published contract', async () => {
  const first = await createAuthorization(
    'urn:uuid:spike-test',
    undefined,
    1455,
  );
  const authorize = new URL(first.url);
  assert(
    authorize.searchParams.get('client_id') === 'dynamic_agent_client',
    'first registration',
  );
  assert(
    authorize.searchParams.get('agent_name_hint') === 'Henji',
    'Henji registration name',
  );
  assert(
    authorize.searchParams.get('scope')?.includes('chatgpt.tokens.use.direct'),
    'direct inference scope',
  );
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(first.verifier),
      ),
    ),
  );
  assert(
    authorize.searchParams.get('code_challenge') === challenge,
    'PKCE verifier binds the exchange',
  );
  const callbackUrl = new URL(first.redirectUri);
  callbackUrl.search = new URLSearchParams({
    code: 'mock-code',
    state: first.state,
    client_id: 'oaiapp_spike',
  }).toString();
  const callback = parseCallback(callbackUrl.toString(), first);
  assert(
    callback.clientId === 'oaiapp_spike' && callback.code === 'mock-code',
    'issued ID and code',
  );
  const returning = await createAuthorization(
    'urn:uuid:spike-test',
    callback.clientId,
    54321,
  );
  const returningUrl = new URL(returning.url);
  assert(
    returningUrl.searchParams.get('client_id') === callback.clientId,
    'reuse registered client',
  );
  assert(
    !returningUrl.searchParams.has('agent_name_hint'),
    'name is only initial registration metadata',
  );

  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = {
    ...await crypto.subtle.exportKey('jwk', keys.publicKey),
    kid: 'spike-key',
  };
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const jwtInput = `${encode({ alg: 'RS256', kid: 'spike-key' })}.${
    encode({
      iss: 'https://auth.openai.com',
      aud: callback.clientId,
      sub: 'spike-user',
      exp: Date.now() / 1000 + 3600,
      nonce: first.nonce,
      email: 'spike@example.test',
    })
  }`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keys.privateKey,
    new TextEncoder().encode(jwtInput),
  );
  const token = `${jwtInput}.${base64url(new Uint8Array(signature))}`;
  const facts: Fact[] = [];
  const http = new ProbeHttp(
    recorder(facts),
    (url) =>
      Promise.resolve(
        String(url).endsWith('openid-configuration')
          ? json({
            issuer: 'https://auth.openai.com',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          })
          : json({ keys: [publicJwk] }),
      ),
  );
  const identity = await verifyIdentity(
    token,
    callback.clientId,
    first.nonce,
    http,
  );
  assert(identity.subject === 'spike-user', 'verified signed account identity');
  const alteredSignature = new Uint8Array(signature);
  alteredSignature[0] ^= 1;
  try {
    await verifyIdentity(
      `${jwtInput}.${base64url(alteredSignature)}`,
      callback.clientId,
      first.nonce,
      http,
    );
    throw new Error('expected altered signature failure');
  } catch (error) {
    assert(
      error instanceof SpikeFailure && error.code === 'id_token_verification_failed',
      'signature actually verified',
    );
  }
  const credential = tokenSet({
    access_token: 'spike-access',
    refresh_token: 'spike-refresh',
    expires_in: 3600,
    scope: 'openid chatgpt.tokens.use.direct',
    earliest_refresh_at: 123,
  });
  assert(
    credential.scopes.includes('chatgpt.tokens.use.direct'),
    'grant retained',
  );
  assert(credential.earliestRefreshAt === 123, 'refresh metadata retained');
  const models = parseModels({
    models: [
      { slug: 'model-one', display_name: 'Model One', visibility: 'list' },
      { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'model-two', display_name: 'Model Two', visibility: 'list' },
    ],
  });
  assert(
    models.map((model) => model.slug).join(',') === 'model-one,model-two',
    'server order and display eligibility',
  );
  assert(
    !JSON.stringify(facts).includes(token),
    'ID token excluded from request facts',
  );
});

Deno.test('namespace echo round trip replays reasoning and tool output over two stateless streamed requests', async () => {
  const requests: Record<string, unknown>[] = [];
  const facts: Fact[] = [];
  const reasoning = {
    type: 'reasoning',
    id: 'rs_spike',
    encrypted_content: 'opaque-reasoning',
  };
  const call = {
    type: 'function_call',
    call_id: 'call_spike',
    name: 'echo',
    namespace: 'henji_spike',
    arguments: '{"text":"HENJI_A1_TOOL_OK"}',
  };
  const http = new ProbeHttp(recorder(facts), (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    assert(
      new Headers(init?.headers).get('authorization') === 'Bearer spike-access',
      'OAuth access token is bearer credential',
    );
    return Promise.resolve(
      requests.length === 1
        ? sse([
          { type: 'response.created' },
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          { type: 'response.output_item.done', output_index: 1, item: call },
          { type: 'response.completed', response: { output: [] } },
        ])
        : sse([
          { type: 'response.output_text.delta', delta: '確認' },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              content: [{ type: 'output_text', text: 'HENJI_A1_TOOL_OK' }],
            },
          },
          {
            type: 'response.completed',
            response: {
              output: [],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
        ]),
    );
  });
  const result = await infer(
    'account-model',
    { accessToken: 'spike-access' },
    true,
    http,
  );
  assert(result === 'HENJI_A1_TOOL_OK', 'post-tool final response');
  assert(requests.length === 2, 'one local tool round trip');
  const requestFacts = facts.filter((fact) => fact.kind === 'request');
  assert(
    requestFacts.every((fact) =>
      fact.provider === 'openai-chatgpt' && fact.model === 'account-model'
    ),
    'request attribution',
  );
  assert(
    requestFacts.map((fact) => fact.modelStep).join(',') === '1,2',
    'logical steps and physical request facts',
  );
  const first = requests[0];
  assert(
    first.store === false && first.stream === true &&
      Array.isArray(first.input),
    'direct-route HTTP conditions',
  );
  const tools = first.tools as Record<string, unknown>[];
  assert(
    tools[0].type === 'namespace' && tools[0].name === 'henji_spike',
    'namespace declaration',
  );
  const secondInput = requests[1].input as Record<string, unknown>[];
  assert(
    secondInput.some((item) =>
      item.type === 'reasoning' && item.encrypted_content === 'opaque-reasoning'
    ),
    'reasoning replay',
  );
  assert(
    secondInput.some((item) => item.type === 'function_call' && item.namespace === 'henji_spike'),
    'namespace replay',
  );
  assert(
    secondInput.some((item) =>
      item.type === 'function_call_output' && item.call_id === 'call_spike' &&
      item.output === result
    ),
    'local result returns to model',
  );
  assert(
    !JSON.stringify(facts).includes('spike-access') &&
      !JSON.stringify(facts).includes('opaque-reasoning'),
    'only semantic facts retained',
  );
});

Deno.test('subscription errors stay distinguishable and partial streams do not become success', async () => {
  const facts: Fact[] = [];
  const report = recorder(facts);
  const http = new ProbeHttp(report, () =>
    Promise.resolve(json({
      error: {
        code: 'subscription_sharing_user_not_eligible',
        message: 'spike-access must not be recorded',
      },
    }, 403)));
  try {
    await http.json('responses', 'https://api.openai.com/v1/responses');
    throw new Error('expected HTTP failure');
  } catch (error) {
    assert(
      error instanceof SpikeFailure &&
        error.code === 'subscription_sharing_user_not_eligible',
      'actual provider code',
    );
  }
  try {
    await consumeResponse(
      sse([
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_limit_exceeded' },
          },
        },
      ]),
      report,
    );
    throw new Error('expected stream failure');
  } catch (error) {
    assert(
      error instanceof SpikeFailure &&
        error.code === 'subscription_sharing_usage_limit_exceeded',
      'late stream usage error',
    );
  }
  try {
    await consumeResponse(
      sse([{ type: 'response.output_text.delta', delta: 'partial' }]),
      report,
    );
    throw new Error('expected unfinished stream failure');
  } catch (error) {
    assert(
      error instanceof SpikeFailure &&
        error.code === 'stream_ended_without_response_completed',
      'terminal event determines success',
    );
  }
  assert(
    !JSON.stringify(facts).includes('spike-access'),
    'error body cannot leak credential into facts',
  );
});
