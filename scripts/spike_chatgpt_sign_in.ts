/** Standalone A1 spike. No Henji runtime/config imports or API-key credentials. */
const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const encoder = new TextEncoder();

type ObjectValue = Record<string, unknown>;
type Fetcher = typeof fetch;
export type Fact = Readonly<Record<string, unknown>>;
type Report = (fact: Fact) => Promise<void>;

export class SpikeFailure extends Error {
  constructor(
    readonly code: string,
    readonly field?: string,
    readonly shape?: string,
  ) {
    super(code);
  }
}

const shape = (value: unknown): string =>
  value === undefined
    ? 'missing'
    : value === null
    ? 'null'
    : Array.isArray(value)
    ? `array(length=${value.length})`
    : typeof value === 'string'
    ? `string(length=${value.length})`
    : typeof value;

const object = (value: unknown, field: string): ObjectValue => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SpikeFailure('response_parse_failed', field, shape(value));
  }
  return value as ObjectValue;
};

const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpikeFailure('response_parse_failed', field, shape(value));
  }
  return value;
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_')
    .replace(/=+$/u, '');

const decode64 = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    (char) => char.charCodeAt(0),
  );

export async function createAuthorization(
  hostId: string,
  clientId: string | undefined,
  port: number,
) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(`${AUTH}/api/accounts/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId ?? 'dynamic_agent_client',
    ...(clientId === undefined ? { agent_name_hint: 'Henji' } : {}),
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    resource: RESOURCE,
    scope: SCOPES,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: base64url(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', encoder.encode(verifier)),
      ),
    ),
  }).toString();
  // No id_token_hint: a returning login uses the account selector, without printing an ID token.
  return { url: url.toString(), verifier, state, nonce, redirectUri, clientId };
}

type Authorization = Awaited<ReturnType<typeof createAuthorization>>;

export function parseCallback(input: string, pending: Authorization) {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SpikeFailure('callback_url_invalid');
  }
  const expected = new URL(pending.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new SpikeFailure('callback_uri_mismatch');
  }
  if (url.searchParams.get('state') !== pending.state) {
    throw new SpikeFailure('callback_state_mismatch');
  }
  if (url.searchParams.has('error')) {
    throw new SpikeFailure('authorization_not_completed');
  }
  const clientId = url.searchParams.get('client_id') ?? pending.clientId;
  if (!clientId || clientId === 'dynamic_agent_client') {
    throw new SpikeFailure('issued_client_id_missing');
  }
  if (pending.clientId !== undefined && pending.clientId !== clientId) {
    throw new SpikeFailure('callback_client_id_mismatch');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new SpikeFailure('authorization_code_missing');
  return { code, clientId };
}

// HTTP facts contain only status, request identity, field names/shapes and machine error codes.
const errorCode = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as ObjectValue).error;
  const code = typeof error === 'string'
    ? error
    : typeof error === 'object' && error !== null
    ? (error as ObjectValue).code
    : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/u.test(code) ? code : undefined;
};

export class ProbeHttp {
  #order = 0;
  constructor(readonly report: Report, readonly fetcher: Fetcher = fetch) {}

  async request(
    api: string,
    url: string,
    init?: RequestInit,
    context: { model?: string; modelStep?: number } = {},
  ): Promise<Response> {
    const requestOrder = ++this.#order;
    await this.report({
      kind: 'request',
      provider: 'openai-chatgpt',
      api,
      requestOrder,
      method: init?.method ?? 'GET',
      ...context,
    });
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch {
      await this.report({
        kind: 'response',
        api,
        requestOrder,
        error: 'transport_error',
      });
      throw new SpikeFailure('transport_error');
    }
    await this.report({
      kind: 'response',
      api,
      requestOrder,
      httpStatus: response.status,
      requestId: response.headers.get('x-request-id'),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const code = errorCode(body);
      await this.report({
        kind: 'failure',
        api,
        requestOrder,
        error: code ?? 'http_error',
        bodyShape: shape(body),
        ...(typeof body === 'object' && body !== null ? { bodyFields: Object.keys(body) } : {}),
      });
      throw new SpikeFailure(code ?? 'http_error');
    }
    return response;
  }

  async json(
    api: string,
    url: string,
    init?: RequestInit,
  ): Promise<ObjectValue> {
    const response = await this.request(api, url, init);
    try {
      return object(await response.json(), api);
    } catch (error) {
      if (error instanceof SpikeFailure) throw error;
      throw new SpikeFailure('invalid_json', api);
    }
  }
}

export async function verifyIdentity(
  idToken: string,
  clientId: string,
  nonce: string,
  http: ProbeHttp,
) {
  const discovery = await http.json(
    'oidc.discovery',
    `${AUTH}/.well-known/openid-configuration`,
  );
  const issuer = string(discovery.issuer, 'discovery.issuer');
  const jwksUri = string(discovery.jwks_uri, 'discovery.jwks_uri');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new SpikeFailure('id_token_invalid');
  let header: ObjectValue;
  let claims: ObjectValue;
  try {
    const decoder = new TextDecoder();
    header = object(
      JSON.parse(decoder.decode(decode64(parts[0]))),
      'id_token.header',
    );
    claims = object(
      JSON.parse(decoder.decode(decode64(parts[1]))),
      'id_token.claims',
    );
  } catch {
    throw new SpikeFailure('id_token_invalid');
  }
  // Production discovery advertised RS256 on 2026-10-01. Other algorithms remain unverified.
  if (header.alg !== 'RS256') {
    throw new SpikeFailure('id_token_algorithm_unverified');
  }
  const jwks = await http.json('oidc.jwks', jwksUri);
  if (!Array.isArray(jwks.keys)) {
    throw new SpikeFailure(
      'response_parse_failed',
      'jwks.keys',
      shape(jwks.keys),
    );
  }
  const jwk = jwks.keys.find((key) =>
    typeof key === 'object' && key !== null && key.kid === header.kid
  );
  if (jwk === undefined) throw new SpikeFailure('id_token_key_missing');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decode64(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !valid || issuer !== AUTH || claims.iss !== issuer ||
    !audience.includes(clientId) ||
    typeof claims.exp !== 'number' || claims.exp <= Date.now() / 1000 ||
    claims.nonce !== nonce
  ) {
    throw new SpikeFailure('id_token_verification_failed');
  }
  return {
    subject: string(claims.sub, 'id_token.sub'),
    email: typeof claims.email === 'string' ? claims.email : undefined,
  };
}

interface Credential {
  clientId: string;
  subject: string;
  email?: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
  earliestRefreshAt?: unknown;
}

export function tokenSet(token: ObjectValue) {
  if (typeof token.expires_in !== 'number' || token.expires_in <= 0) {
    throw new SpikeFailure(
      'response_parse_failed',
      'expires_in',
      shape(token.expires_in),
    );
  }
  return {
    accessToken: string(token.access_token, 'access_token'),
    refreshToken: string(token.refresh_token, 'refresh_token'),
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: string(token.scope, 'scope').split(/\s+/u),
    ...(token.earliest_refresh_at === undefined
      ? {}
      : { earliestRefreshAt: token.earliest_refresh_at }),
  };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new SpikeFailure('saved_state_read_failed');
  }
}

async function savePrivate(path: string, value: unknown): Promise<void> {
  const staging = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(staging, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    createNew: true,
  });
  await Deno.rename(staging, path);
}

async function tokenRequest(
  http: ProbeHttp,
  body: URLSearchParams,
): Promise<ObjectValue> {
  return await http.json('oauth.token', `${AUTH}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function readHiddenCallback(): Promise<string> {
  console.log(
    'Paste the full callback URL here (input is hidden), then press Enter. Ctrl-C cancels.',
  );
  const terminal = Deno.stdin.isTerminal();
  if (terminal) Deno.stdin.setRaw(true);
  const bytes: number[] = [];
  const buffer = new Uint8Array(1);
  try {
    while (await Deno.stdin.read(buffer) !== null) {
      const byte = buffer[0];
      if (byte === 3) throw new SpikeFailure('login_cancelled');
      if (byte === 10 || byte === 13) {
        return new TextDecoder().decode(new Uint8Array(bytes));
      }
      if (byte === 127 || byte === 8) bytes.pop();
      else if (byte === 21) bytes.length = 0;
      else bytes.push(byte);
    }
    throw new SpikeFailure('callback_input_closed');
  } finally {
    if (terminal) Deno.stdin.setRaw(false);
    console.log();
  }
}

async function login(
  dir: string,
  port: number,
  http: ProbeHttp,
): Promise<void> {
  const savedHost = await readJson<{ hostId: string }>(`${dir}/host.json`);
  const host = savedHost ?? { hostId: `urn:uuid:${crypto.randomUUID()}` };
  if (savedHost === undefined) await savePrivate(`${dir}/host.json`, host);
  const registration = await readJson<{ clientId: string }>(
    `${dir}/registration.json`,
  );
  const previous = await readJson<Credential>(`${dir}/credential.json`);
  let server: Deno.HttpServer;
  try {
    server = Deno.serve(
      { hostname: '127.0.0.1', port, onListen: () => {} },
      () =>
        new Response(
          'Return to the spike terminal and paste the full URL from the address bar.',
        ),
    );
  } catch {
    throw new SpikeFailure('callback_listener_failed');
  }
  try {
    const pending = await createAuthorization(
      host.hostId,
      registration?.clientId,
      (server.addr as Deno.NetAddr).port,
    );
    console.log(
      'Open this URL in your browser outside the VM and choose Continue with ChatGPT:',
    );
    console.log(pending.url);
    const callback = parseCallback(await readHiddenCallback(), pending);
    // Retain the issued registration even if code exchange fails; later login reuses it.
    await savePrivate(`${dir}/registration.json`, {
      clientId: callback.clientId,
    });
    const token = await tokenRequest(
      http,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: callback.clientId,
        code: callback.code,
        code_verifier: pending.verifier,
        redirect_uri: pending.redirectUri,
        resource: RESOURCE,
      }),
    );
    const idToken = string(token.id_token, 'id_token');
    const identity = await verifyIdentity(
      idToken,
      callback.clientId,
      pending.nonce,
      http,
    );
    if (previous !== undefined && identity.subject !== previous.subject) {
      throw new SpikeFailure('account_identity_mismatch');
    }
    const credential: Credential = {
      clientId: callback.clientId,
      ...identity,
      idToken,
      ...tokenSet(token),
    };
    await savePrivate(`${dir}/credential.json`, credential);
    await http.report({
      kind: 'login',
      identityVerified: true,
      planUsageEnabled: credential.scopes.includes(DIRECT_SCOPE),
    });
    console.log(
      credential.scopes.includes(DIRECT_SCOPE)
        ? 'Connected. ChatGPT plan usage is enabled.'
        : 'Connected. ChatGPT plan usage was not granted.',
    );
  } finally {
    await server.shutdown();
  }
}

export async function refresh(
  dir: string,
  credential: Credential,
  http: ProbeHttp,
): Promise<Credential> {
  const token = await tokenRequest(
    http,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
      resource: RESOURCE,
    }),
  );
  const next = {
    ...credential,
    ...tokenSet(token),
    ...(typeof token.id_token === 'string' ? { idToken: token.id_token } : {}),
  };
  await savePrivate(`${dir}/credential.json`, next);
  await http.report({ kind: 'refresh', credentialSaved: true });
  return next;
}

export function parseModels(payload: ObjectValue) {
  if (!Array.isArray(payload.models)) {
    throw new SpikeFailure(
      'response_parse_failed',
      'models',
      shape(payload.models),
    );
  }
  return payload.models.flatMap((entry, index) => {
    const model = object(entry, `models[${index}]`);
    return model.visibility === 'list'
      ? [{
        slug: string(model.slug, `models[${index}].slug`),
        displayName: string(
          model.display_name,
          `models[${index}].display_name`,
        ),
      }]
      : [];
  });
}

export async function consumeResponse(
  response: Response,
  report: Report,
): Promise<ObjectValue> {
  if (response.body === null) throw new SpikeFailure('stream_body_missing');
  let pending = '';
  let completed: ObjectValue | undefined;
  const outputItems = new Map<number, ObjectValue>();
  const eventCounts: Record<string, number> = {};
  const consume = (frame: string) => {
    const data = frame.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n');
    if (data.length === 0 || data === '[DONE]') return;
    let event: ObjectValue;
    try {
      event = object(JSON.parse(data), 'stream.event');
    } catch {
      throw new SpikeFailure('stream_event_invalid');
    }
    const type = string(event.type, 'stream.event.type');
    eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    if (type === 'response.output_item.done') {
      const index = event.output_index;
      if (typeof index !== 'number') {
        throw new SpikeFailure(
          'response_parse_failed',
          'response.output_item.done.output_index',
          shape(index),
        );
      }
      outputItems.set(index, object(event.item, 'response.output_item.done.item'));
    }
    if (type === 'response.completed') {
      completed = object(event.response, 'response.completed.response');
    }
    if (
      type === 'response.failed' || type === 'response.incomplete' ||
      type === 'error'
    ) {
      const failure = type === 'error' ? { error: event } : event.response;
      throw new SpikeFailure(errorCode(failure) ?? type);
    }
  };
  try {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(pending)) !== null) {
        consume(pending.slice(0, boundary.index).replaceAll('\r\n', '\n'));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
    }
    pending += decoder.decode();
    if (pending.trim().length > 0) consume(pending.replaceAll('\r\n', '\n'));
    if (completed === undefined) {
      throw new SpikeFailure('stream_ended_without_response_completed');
    }
    // Read finished items from the stream; the terminal event establishes completion.
    return {
      ...completed,
      output: [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
    };
  } finally {
    await report({
      kind: 'stream',
      completed: completed !== undefined,
      eventCounts,
      outputItemTypes: [...outputItems.values()].map((item) => item.type),
      completedOutputShape: shape(completed?.output),
      completedOutputCount: Array.isArray(completed?.output) ? completed.output.length : null,
    });
  }
}

function responseBody(
  model: string,
  input: unknown[],
  tool: boolean,
  firstStep = true,
) {
  return {
    model,
    input,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    instructions: tool
      ? 'Use henji_spike.echo once with text HENJI_A1_TOOL_OK. After its result, reply exactly HENJI_A1_TOOL_OK.'
      : 'Reply exactly HENJI_A1_OK.',
    ...(tool
      ? {
        tools: [{
          type: 'namespace',
          name: 'henji_spike',
          description: 'A local spike tool.',
          tools: [{
            type: 'function',
            name: 'echo',
            description: 'Return the supplied text locally.',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            strict: false,
          }],
        }],
        tool_choice: firstStep ? 'required' : 'none',
      }
      : {}),
  };
}

export async function infer(
  model: string,
  credential: { accessToken: string },
  tool: boolean,
  http: ProbeHttp,
) {
  const input: unknown[] = [{
    role: 'user',
    content: tool
      ? 'Run the local echo tool, then confirm its result.'
      : 'Confirm this connection.',
  }];
  const step = async (first: boolean) => {
    const response = await http.request('responses', `${RESOURCE}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(responseBody(model, input, tool, first)),
    }, { model, modelStep: first ? 1 : 2 });
    return await consumeResponse(response, http.report);
  };
  let result = await step(true);
  if (tool) {
    const output = result.output as unknown[];
    const calls = output.filter((item) =>
      object(item, 'response.output.item').type === 'function_call'
    ).map((item) => object(item, 'function_call'));
    if (calls.length !== 1) {
      throw new SpikeFailure('expected_one_local_tool_call');
    }
    const call = calls[0];
    if (call.name !== 'echo') {
      throw new SpikeFailure('unexpected_local_tool_call');
    }
    const args = object(
      JSON.parse(string(call.arguments, 'function_call.arguments')),
      'echo.arguments',
    );
    const text = string(args.text, 'echo.text');
    await http.report({
      kind: 'tool',
      name: 'echo',
      namespace: call.namespace ?? null,
      arguments: { text },
      result: text,
    });
    input.push(...output, {
      type: 'function_call_output',
      call_id: string(call.call_id, 'function_call.call_id'),
      output: text,
    });
    result = await step(false);
  }
  const text = (result.output as unknown[]).flatMap((item) => {
    const message = object(item, 'response.output.item');
    return message.type === 'message' && Array.isArray(message.content)
      ? message.content.flatMap((part) => {
        const content = object(part, 'message.content');
        return content.type === 'output_text' ? [string(content.text, 'output_text.text')] : [];
      })
      : [];
  }).join('');
  if (text.length === 0) throw new SpikeFailure('assistant_text_missing');
  await http.report({
    kind: 'inference',
    model,
    toolRoundTrip: tool,
    text,
    expectedMarker: tool ? 'HENJI_A1_TOOL_OK' : 'HENJI_A1_OK',
    replyMatchesMarker: text.trim() === (tool ? 'HENJI_A1_TOOL_OK' : 'HENJI_A1_OK'),
    usage: result.usage,
  });
  return text;
}

const HELP = `A1 standalone ChatGPT sign-in spike (no Henji runtime changes)
Usage: deno run --no-config --allow-read --allow-write --allow-net scripts/spike_chatgpt_sign_in.ts COMMAND --dir PATH [--model SLUG] [--port PORT]
Commands:
  login    Show the OAuth URL and accept a hidden, manually pasted callback URL.
  status   Read saved registration/credential status without network requests.
  models   GET the signed-in account's model list.
  infer    One Responses request with a short connection check.
  tool     Two Responses requests with a local namespace echo round trip.
  refresh  Explicitly refresh and persist the rotated token set.
Use one process/account per directory. Live requests require the agreed spike approval.
Credentials: PATH/credential.json (0600); non-secret request facts: PATH/facts.jsonl.
`;

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help')) {
    console.log(HELP);
    return;
  }
  const command = args[0];
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const dir = option('--dir');
  if (
    !dir ||
    !['login', 'status', 'models', 'infer', 'tool', 'refresh'].includes(command)
  ) throw new SpikeFailure('usage_error');
  const model = option('--model');
  if ((command === 'infer' || command === 'tool') && !model) {
    throw new SpikeFailure('model_required');
  }
  const port = Number(option('--port') ?? '1455');
  const runId = crypto.randomUUID();
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const report: Report = async (fact) => {
    await Deno.writeTextFile(
      `${dir}/facts.jsonl`,
      JSON.stringify({
        runId,
        command,
        occurredAt: new Date().toISOString(),
        ...fact,
      }) + '\n',
      { append: true, mode: 0o600 },
    );
  };
  const http = new ProbeHttp(report);
  try {
    if (command === 'login') {
      await login(dir, port, http);
      return;
    }
    let credential = await readJson<Credential>(`${dir}/credential.json`);
    if (command === 'status') {
      const registration = await readJson(`${dir}/registration.json`);
      console.log(
        JSON.stringify(
          {
            registered: registration !== undefined,
            connected: credential !== undefined,
            planUsageEnabled: credential?.scopes.includes(DIRECT_SCOPE) ??
              false,
            expiresAt: credential?.expiresAt,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (credential === undefined) throw new SpikeFailure('login_required');
    if (command === 'refresh' || credential.expiresAt <= Date.now()) {
      credential = await refresh(dir, credential, http);
      if (command === 'refresh') {
        console.log('Token set refreshed and saved.');
        return;
      }
    }
    if (!credential.scopes.includes(DIRECT_SCOPE)) {
      throw new SpikeFailure('plan_usage_not_granted');
    }
    if (command === 'models') {
      const models = parseModels(
        await http.json('models', `${RESOURCE}/models`, {
          headers: { authorization: `Bearer ${credential.accessToken}` },
        }),
      );
      await report({ kind: 'models', count: models.length, models });
      console.log(JSON.stringify(models, null, 2));
      return;
    }
    console.log(await infer(model!, credential, command === 'tool', http));
  } catch (error) {
    const failure = error instanceof SpikeFailure
      ? error
      : new SpikeFailure('spike_operation_failed');
    await report({
      kind: 'failure',
      error: failure.code,
      ...(failure.field ? { field: failure.field, valueShape: failure.shape } : {}),
    });
    throw failure;
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(
      error instanceof SpikeFailure ? error.code : 'spike_operation_failed',
    );
    Deno.exitCode = 1;
  }
}
