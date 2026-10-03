/**
 * Host-local Sign in with ChatGPT lifecycle and request-time token resolution.
 *
 * OAuth identity is verified before an account is published. Access and refresh tokens remain in
 * the private chatgpt account file; only resolve() returns an access token to its caller.
 */

import type { ChatGPTLoginAttempt, ChatGPTState } from '../../api/chatgpt_contract.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;
export type ChatGPTAuthFact = Readonly<Record<string, unknown>>;
type ChatGPTAuthReporter = (
  fact: ChatGPTAuthFact,
) => void | Promise<void>;

type ChatGPTAuthFailureCode =
  | 'chatgpt_attempt_not_found'
  | 'chatgpt_account_missing'
  | 'chatgpt_selection_missing'
  | 'chatgpt_registration_missing'
  | 'chatgpt_callback_url_invalid'
  | 'chatgpt_callback_uri_mismatch'
  | 'chatgpt_callback_state_mismatch'
  | 'chatgpt_authorization_not_completed'
  | 'chatgpt_issued_client_id_missing'
  | 'chatgpt_callback_client_id_mismatch'
  | 'chatgpt_authorization_code_missing'
  | 'chatgpt_id_token_invalid'
  | 'chatgpt_id_token_algorithm_unverified'
  | 'chatgpt_id_token_key_missing'
  | 'chatgpt_id_token_verification_failed'
  | 'chatgpt_account_identity_mismatch'
  | 'chatgpt_plan_usage_not_granted'
  | 'chatgpt_refresh_token_missing'
  | 'chatgpt_attempt_expired'
  | 'chatgpt_completion_in_progress'
  | 'chatgpt_transport_error'
  | 'chatgpt_http_error'
  | 'chatgpt_response_parse_failed'
  | 'chatgpt_saved_state_invalid'
  | 'chatgpt_saved_state_read_failed'
  | 'chatgpt_saved_state_write_failed'
  | 'chatgpt_fact_report_failed'
  | 'chatgpt_oauth_error';

/** Machine-readable, value-free error exposed to Core and provider callers. */
export class ChatGPTAuthError extends Error {
  readonly code: ChatGPTAuthFailureCode | string;
  readonly api?: string;
  readonly field?: string;
  readonly valueShape?: string;

  constructor(
    code: ChatGPTAuthFailureCode | string,
    details: { api?: string; field?: string; valueShape?: string } = {},
  ) {
    super(code);
    this.name = 'ChatGPTAuthError';
    this.code = code;
    this.api = details.api;
    this.field = details.field;
    this.valueShape = details.valueShape;
  }
}

interface ChatGPTAuthServiceOptions {
  /** Henji runtime config root. ChatGPT files are stored below `${configRoot}/chatgpt`. */
  readonly configRoot?: string;
  /** Injectable only for tests and isolated probes. Production uses the global fetch. */
  readonly fetcher?: typeof fetch;
  /** Receives short request facts. Never receives OAuth URLs, codes, tokens, or authorization. */
  readonly reportFact?: ChatGPTAuthReporter;
}

export interface ChatGPTAuthService {
  status(): Promise<ChatGPTState>;
  begin(registrationId?: string): Promise<ChatGPTLoginAttempt>;
  complete(attemptId: string, callbackUrl: string): Promise<ChatGPTState>;
  cancel(attemptId: string): Promise<void>;
  select(registrationId: string): Promise<ChatGPTState>;
  selectedRegistrationId(): Promise<string | undefined>;
  resolve(registrationId?: string): Promise<ResolvedChatGPTCredential>;
  presence(registrationId?: string): Promise<'present' | 'missing' | 'unknown'>;
  close(): Promise<void>;
}

interface ResolvedChatGPTCredential {
  readonly accessToken: string;
  readonly registrationId: string;
}

interface ResolveChatGPTCredentialOptions extends ChatGPTAuthServiceOptions {
  /** Frozen, nonsecret account binding for this model execution. */
  readonly registrationId?: string;
  /** Optional already-resolved selection. If absent, the persisted selection is read. */
  readonly selectedRegistrationId?: string;
}

interface ChatGPTCredentialPresenceOptions {
  readonly configRoot?: string;
  readonly registrationId?: string;
  readonly selectedRegistrationId?: string;
}

interface PendingAuthorization {
  readonly registrationId: string;
  readonly clientId?: string;
  readonly verifier: string;
  readonly state: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly authorizationUrl: string;
}

interface RegistrationRecord {
  readonly schemaVersion: 1;
  readonly registrationId: string;
  readonly clientId?: string;
  readonly updatedAt: number;
}

interface AccountRecord {
  readonly schemaVersion: 1;
  readonly registrationId: string;
  readonly clientId: string;
  readonly subject: string;
  readonly email?: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
  readonly earliestRefreshAt?: unknown;
  readonly needsReauthentication?: boolean;
}

interface HostRecord {
  readonly schemaVersion: 1;
  readonly hostId: string;
}

interface SelectionRecord {
  readonly schemaVersion: 1;
  readonly registrationId: string;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const valueShape = (value: unknown): string =>
  value === undefined
    ? 'missing'
    : value === null
    ? 'null'
    : Array.isArray(value)
    ? `array(length=${value.length})`
    : typeof value === 'string'
    ? `string(length=${value.length})`
    : typeof value;

const invalidField = (
  api: string,
  field: string,
  value: unknown,
): ChatGPTAuthError => {
  return new ChatGPTAuthError('chatgpt_response_parse_failed', {
    api,
    field,
    valueShape: valueShape(value),
  });
};

const requiredObject = (
  value: unknown,
  api: string,
  field: string,
): JsonObject => {
  if (!isObject(value)) throw invalidField(api, field, value);
  return value;
};

const requiredString = (
  value: unknown,
  api: string,
  field: string,
): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidField(api, field, value);
  }
  return value;
};

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_')
    .replace(/=+$/u, '');

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

const configRootOf = (configRoot?: string): string =>
  configRoot ?? resolveRuntimePaths().configRoot;

const chatGPTDirectory = (configRoot: string): string => `${configRoot}/chatgpt`;
const hostPath = (configRoot: string): string => `${chatGPTDirectory(configRoot)}/host.json`;
const selectionPath = (configRoot: string): string =>
  `${chatGPTDirectory(configRoot)}/selection.json`;
const registrationsDirectory = (configRoot: string): string =>
  `${chatGPTDirectory(configRoot)}/registrations`;
const accountsDirectory = (configRoot: string): string =>
  `${chatGPTDirectory(configRoot)}/accounts`;
const storageId = (registrationId: string): string => encodeURIComponent(registrationId);
const registrationPath = (configRoot: string, registrationId: string): string =>
  `${registrationsDirectory(configRoot)}/${storageId(registrationId)}.json`;
const accountPath = (configRoot: string, registrationId: string): string =>
  `${accountsDirectory(configRoot)}/${storageId(registrationId)}.json`;
const accountLockPath = (configRoot: string, registrationId: string): string =>
  `${accountsDirectory(configRoot)}/${storageId(registrationId)}.lock`;

const report = async (
  reporter: ChatGPTAuthReporter | undefined,
  fact: ChatGPTAuthFact,
): Promise<void> => {
  if (reporter === undefined) return;
  try {
    await reporter(fact);
  } catch {
    throw new ChatGPTAuthError('chatgpt_fact_report_failed');
  }
};

const readJson = async <T>(path: string): Promise<T | undefined> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new ChatGPTAuthError('chatgpt_saved_state_read_failed');
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  }
};

const writeJsonAtomically = async (
  path: string,
  value: unknown,
): Promise<void> => {
  const separator = path.lastIndexOf('/');
  const directory = path.slice(0, separator);
  const basename = path.slice(separator + 1);
  const staging = `${directory}/.${basename}.${crypto.randomUUID()}.tmp`;
  let stagingOwned = false;
  try {
    await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
    const bytes = encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
    const file = await Deno.open(staging, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    stagingOwned = true;
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await file.write(bytes.subarray(offset));
        if (!Number.isSafeInteger(written) || written <= 0) {
          throw new ChatGPTAuthError('chatgpt_saved_state_write_failed');
        }
        offset += written;
      }
    } finally {
      file.close();
    }
    await Deno.chmod(staging, 0o600);
    await Deno.rename(staging, path);
    stagingOwned = false;
  } catch (error) {
    if (error instanceof ChatGPTAuthError) throw error;
    throw new ChatGPTAuthError('chatgpt_saved_state_write_failed');
  } finally {
    if (stagingOwned) {
      try {
        await Deno.remove(staging);
      } catch {
        // Only this write's own uniquely named staging file is considered for cleanup.
      }
    }
  }
};

const parseRegistration = (
  value: unknown,
  registrationId: string,
): RegistrationRecord => {
  if (
    !isObject(value) || value.schemaVersion !== 1 ||
    value.registrationId !== registrationId
  ) {
    throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  }
  if (value.clientId !== undefined && typeof value.clientId !== 'string') {
    throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  }
  if (typeof value.updatedAt !== 'number') {
    throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  }
  return value as unknown as RegistrationRecord;
};

const parseAccount = (
  value: unknown,
  registrationId: string,
): AccountRecord => {
  if (
    !isObject(value) || value.schemaVersion !== 1 ||
    value.registrationId !== registrationId ||
    typeof value.clientId !== 'string' || typeof value.subject !== 'string' ||
    typeof value.accessToken !== 'string' ||
    typeof value.refreshToken !== 'string' ||
    typeof value.idToken !== 'string' || typeof value.expiresAt !== 'number' ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((scope) => typeof scope === 'string')
  ) {
    throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  }
  if (value.email !== undefined && typeof value.email !== 'string') {
    throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  }
  if (
    value.needsReauthentication !== undefined &&
    typeof value.needsReauthentication !== 'boolean'
  ) {
    throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  }
  return value as unknown as AccountRecord;
};

const loadAccount = async (
  configRoot: string,
  registrationId: string,
): Promise<AccountRecord | undefined> => {
  const value = await readJson<unknown>(
    accountPath(configRoot, registrationId),
  );
  return value === undefined ? undefined : parseAccount(value, registrationId);
};

const loadRegistration = async (
  configRoot: string,
  registrationId: string,
): Promise<RegistrationRecord | undefined> => {
  const value = await readJson<unknown>(
    registrationPath(configRoot, registrationId),
  );
  return value === undefined ? undefined : parseRegistration(value, registrationId);
};

const selectedFromDisk = async (
  configRoot: string,
): Promise<string | undefined> => {
  const value = await readJson<unknown>(selectionPath(configRoot));
  if (value === undefined) return undefined;
  if (
    !isObject(value) || value.schemaVersion !== 1 ||
    typeof value.registrationId !== 'string' ||
    value.registrationId.length === 0
  ) throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
  return value.registrationId;
};

const resolveRegistrationId = async (
  configRoot: string,
  registrationId?: string,
  selectedRegistrationId?: string,
): Promise<string> => {
  const resolved = registrationId ?? selectedRegistrationId ??
    await selectedFromDisk(configRoot);
  if (resolved === undefined || resolved.length === 0) {
    throw new ChatGPTAuthError('chatgpt_selection_missing');
  }
  return resolved;
};

const createAuthorization = async (
  hostId: string,
  clientId: string | undefined,
  redirectUri: string,
): Promise<Omit<PendingAuthorization, 'registrationId'>> => {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
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
    code_challenge: encodeBase64Url(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', encoder.encode(verifier)),
      ),
    ),
  }).toString();
  return {
    authorizationUrl: url.toString(),
    verifier,
    state,
    nonce,
    redirectUri,
    clientId,
  };
};

const parseCallback = (
  input: string,
  pending: PendingAuthorization,
): { code: string; clientId: string } => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ChatGPTAuthError('chatgpt_callback_url_invalid');
  }
  const expected = new URL(pending.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new ChatGPTAuthError('chatgpt_callback_uri_mismatch');
  }
  if (url.searchParams.get('state') !== pending.state) {
    throw new ChatGPTAuthError('chatgpt_callback_state_mismatch');
  }
  if (url.searchParams.has('error')) {
    throw new ChatGPTAuthError('chatgpt_authorization_not_completed');
  }
  const clientId = url.searchParams.get('client_id') ?? pending.clientId;
  if (
    clientId === undefined || clientId.length === 0 ||
    clientId === 'dynamic_agent_client'
  ) {
    throw new ChatGPTAuthError('chatgpt_issued_client_id_missing');
  }
  if (pending.clientId !== undefined && pending.clientId !== clientId) {
    throw new ChatGPTAuthError('chatgpt_callback_client_id_mismatch');
  }
  const code = url.searchParams.get('code');
  if (code === null || code.length === 0) {
    throw new ChatGPTAuthError('chatgpt_authorization_code_missing');
  }
  return { code, clientId };
};

const remoteErrorCode = (value: unknown): string | undefined => {
  if (!isObject(value)) return undefined;
  const error = value.error;
  const code = typeof error === 'string' ? error : isObject(error) ? error.code : undefined;
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/u.test(code) ? code : undefined;
};

const createRequester = (
  fetcher: typeof fetch,
  reporter: ChatGPTAuthReporter | undefined,
) => {
  let requestOrder = 0;
  const parseFailure = async (
    api: string,
    field: string,
    value: unknown,
  ): Promise<void> => {
    await report(reporter, {
      kind: 'parse_failure',
      api,
      requestOrder,
      field,
      valueShape: valueShape(value),
    });
  };
  const reportParseShape = async (
    api: string,
    field: string,
    shape: string,
  ): Promise<void> => {
    await report(reporter, {
      kind: 'parse_failure',
      api,
      requestOrder,
      field,
      valueShape: shape,
    });
  };
  const json = async (
    api: string,
    url: string,
    init?: RequestInit,
  ): Promise<JsonObject> => {
    const order = ++requestOrder;
    await report(reporter, {
      kind: 'request',
      provider: 'openai-chatgpt',
      api,
      requestOrder: order,
      method: init?.method ?? 'GET',
    });
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch {
      await report(reporter, {
        kind: 'response',
        api,
        requestOrder: order,
        error: 'transport_error',
      });
      throw new ChatGPTAuthError('chatgpt_transport_error');
    }
    await report(reporter, {
      kind: 'response',
      api,
      requestOrder: order,
      httpStatus: response.status,
      requestId: response.headers.get('x-request-id'),
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const remoteCode = remoteErrorCode(body);
      await report(reporter, {
        kind: 'failure',
        api,
        requestOrder: order,
        error: remoteCode ?? 'http_error',
        bodyShape: valueShape(body),
        ...(isObject(body) ? { bodyFields: Object.keys(body) } : {}),
      });
      throw new ChatGPTAuthError(remoteCode ?? 'chatgpt_http_error');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      await parseFailure(api, 'body', 'invalid_json');
      throw new ChatGPTAuthError('chatgpt_response_parse_failed', {
        api,
        field: 'body',
        valueShape: 'invalid_json',
      });
    }
    try {
      return requiredObject(body, api, 'body');
    } catch (error) {
      await parseFailure(api, 'body', body);
      throw error;
    }
  };
  return { json, parseFailure, reportParseShape };
};

const decodeJwtPart = (value: string): JsonObject => {
  const decoded = new TextDecoder().decode(decodeBase64Url(value));
  return requiredObject(JSON.parse(decoded), 'oidc.id_token', 'jwt_part');
};

const verifyIdentity = async (
  idToken: string,
  clientId: string,
  nonce: string,
  requester: ReturnType<typeof createRequester>,
): Promise<{ subject: string; email?: string }> => {
  const discovery = await requester.json(
    'oidc.discovery',
    `${AUTH}/.well-known/openid-configuration`,
  );
  let issuer: string;
  let jwksUri: string;
  try {
    issuer = requiredString(discovery.issuer, 'oidc.discovery', 'issuer');
    jwksUri = requiredString(
      discovery.jwks_uri,
      'oidc.discovery',
      'jwks_uri',
    );
  } catch (error) {
    if (error instanceof ChatGPTAuthError && error.field !== undefined) {
      await requester.reportParseShape(
        error.api ?? 'oidc.discovery',
        error.field,
        error.valueShape ?? 'unknown',
      );
    }
    throw error;
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    await requester.reportParseShape(
      'oauth.token',
      'id_token',
      valueShape(idToken),
    );
    throw new ChatGPTAuthError('chatgpt_id_token_invalid');
  }
  let header: JsonObject;
  let claims: JsonObject;
  try {
    header = decodeJwtPart(parts[0]);
    claims = decodeJwtPart(parts[1]);
  } catch {
    await requester.reportParseShape(
      'oauth.token',
      'id_token',
      valueShape(idToken),
    );
    throw new ChatGPTAuthError('chatgpt_id_token_invalid');
  }
  if (header.alg !== 'RS256') {
    throw new ChatGPTAuthError('chatgpt_id_token_algorithm_unverified');
  }
  const jwks = await requester.json('oidc.jwks', jwksUri);
  if (!Array.isArray(jwks.keys)) {
    await requester.parseFailure('oidc.jwks', 'keys', jwks.keys);
    throw invalidField('oidc.jwks', 'keys', jwks.keys);
  }
  const jwk = jwks.keys.find((key) => isObject(key) && key.kid === header.kid);
  if (jwk === undefined) {
    throw new ChatGPTAuthError('chatgpt_id_token_key_missing');
  }
  let valid: boolean;
  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      decodeBase64Url(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    throw new ChatGPTAuthError('chatgpt_id_token_verification_failed');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !valid || issuer !== AUTH || claims.iss !== issuer ||
    !audience.includes(clientId) || typeof claims.exp !== 'number' ||
    claims.exp <= Date.now() / 1000 || claims.nonce !== nonce
  ) throw new ChatGPTAuthError('chatgpt_id_token_verification_failed');
  let subject: string;
  try {
    subject = requiredString(claims.sub, 'oidc.id_token', 'sub');
  } catch (error) {
    if (error instanceof ChatGPTAuthError && error.field !== undefined) {
      await requester.reportParseShape(
        error.api ?? 'oidc.id_token',
        error.field,
        error.valueShape ?? 'unknown',
      );
    }
    throw error;
  }
  return {
    subject,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
  };
};

const tokenSet = (
  token: JsonObject,
  api = 'oauth.token',
): Pick<
  AccountRecord,
  'accessToken' | 'refreshToken' | 'expiresAt' | 'scopes' | 'earliestRefreshAt'
> => {
  if (typeof token.expires_in !== 'number' || token.expires_in <= 0) {
    throw invalidField(api, 'expires_in', token.expires_in);
  }
  const scope = requiredString(token.scope, api, 'scope');
  return {
    accessToken: requiredString(token.access_token, api, 'access_token'),
    refreshToken: requiredString(token.refresh_token, api, 'refresh_token'),
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: scope.split(/\s+/u).filter((item) => item.length > 0),
    ...(token.earliest_refresh_at === undefined
      ? {}
      : { earliestRefreshAt: token.earliest_refresh_at }),
  };
};

const saveRegistration = async (
  configRoot: string,
  registrationId: string,
  clientId?: string,
): Promise<void> => {
  await writeJsonAtomically(
    registrationPath(configRoot, registrationId),
    {
      schemaVersion: 1,
      registrationId,
      ...(clientId === undefined ? {} : { clientId }),
      updatedAt: Date.now(),
    } satisfies RegistrationRecord,
  );
};

/** Reuse a client id left by a callback whose token exchange or identity check did not finish. */
const findUnboundRegistration = async (
  configRoot: string,
): Promise<RegistrationRecord | undefined> => {
  let names: string[];
  try {
    names = [];
    for await (
      const entry of Deno.readDir(registrationsDirectory(configRoot))
    ) {
      if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw new ChatGPTAuthError('chatgpt_saved_state_read_failed');
  }
  const pending: RegistrationRecord[] = [];
  for (const name of names) {
    const value = await readJson<unknown>(
      `${registrationsDirectory(configRoot)}/${name}`,
    );
    if (!isObject(value) || typeof value.registrationId !== 'string') {
      throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
    }
    const registration = parseRegistration(value, value.registrationId);
    if (
      registration.clientId !== undefined &&
      await loadAccount(configRoot, registration.registrationId) === undefined
    ) pending.push(registration);
  }
  pending.sort((left, right) => right.updatedAt - left.updatedAt);
  return pending[0];
};

const readHostId = async (configRoot: string): Promise<string> => {
  const path = hostPath(configRoot);
  const lockPath = `${chatGPTDirectory(configRoot)}/host.lock`;
  let lock: Deno.FsFile;
  try {
    await Deno.mkdir(chatGPTDirectory(configRoot), {
      recursive: true,
      mode: 0o700,
    });
    lock = await Deno.open(lockPath, {
      read: true,
      write: true,
      create: true,
      mode: 0o600,
    });
  } catch {
    throw new ChatGPTAuthError('chatgpt_saved_state_write_failed');
  }
  try {
    await lock.lock(true);
    const saved = await readJson<unknown>(path);
    if (saved !== undefined) {
      if (
        !isObject(saved) || saved.schemaVersion !== 1 ||
        typeof saved.hostId !== 'string'
      ) {
        throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
      }
      return saved.hostId;
    }
    const hostId = `urn:uuid:${crypto.randomUUID()}`;
    await writeJsonAtomically(
      path,
      { schemaVersion: 1, hostId } satisfies HostRecord,
    );
    return hostId;
  } catch (error) {
    if (error instanceof ChatGPTAuthError) throw error;
    throw new ChatGPTAuthError('chatgpt_saved_state_read_failed');
  } finally {
    try {
      await lock.unlock();
    } catch {
      // Closing the descriptor below also releases the advisory lock.
    }
    lock.close();
  }
};

const withAccountLock = async <T>(
  configRoot: string,
  registrationId: string,
  action: () => Promise<T>,
): Promise<T> => {
  let lock: Deno.FsFile;
  try {
    await Deno.mkdir(accountsDirectory(configRoot), {
      recursive: true,
      mode: 0o700,
    });
    lock = await Deno.open(accountLockPath(configRoot, registrationId), {
      read: true,
      write: true,
      create: true,
      mode: 0o600,
    });
  } catch {
    throw new ChatGPTAuthError('chatgpt_saved_state_write_failed');
  }
  try {
    await lock.lock(true);
    return await action();
  } finally {
    try {
      await lock.unlock();
    } catch {
      // Closing the descriptor below also releases the advisory lock.
    }
    lock.close();
  }
};

const persistSelection = async (
  configRoot: string,
  registrationId: string,
): Promise<void> => {
  await writeJsonAtomically(
    selectionPath(configRoot),
    {
      schemaVersion: 1,
      registrationId,
    } satisfies SelectionRecord,
  );
};

const listAccountRecords = async (
  configRoot: string,
): Promise<readonly AccountRecord[]> => {
  const directory = accountsDirectory(configRoot);
  let names: string[];
  try {
    names = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && entry.name.endsWith('.json')) names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw new ChatGPTAuthError('chatgpt_saved_state_read_failed');
  }
  names.sort();
  const records: AccountRecord[] = [];
  for (const name of names) {
    const value = await readJson<unknown>(`${directory}/${name}`);
    if (value === undefined) continue;
    if (!isObject(value) || typeof value.registrationId !== 'string') {
      throw new ChatGPTAuthError('chatgpt_saved_state_invalid');
    }
    records.push(parseAccount(value, value.registrationId));
  }
  return records;
};

const stateOf = async (configRoot: string): Promise<ChatGPTState> => {
  const [selectedRegistrationId, records] = await Promise.all([
    selectedFromDisk(configRoot),
    listAccountRecords(configRoot),
  ]);
  return Object.freeze({
    ...(selectedRegistrationId === undefined ? {} : { selectedRegistrationId }),
    accounts: Object.freeze(records.map((record) =>
      Object.freeze({
        registrationId: record.registrationId,
        label: record.email ?? 'ChatGPT account',
        needsReauthentication: record.needsReauthentication === true ||
          !record.scopes.includes(DIRECT_SCOPE),
      })
    )),
  });
};

const exchangeCode = async (
  requester: ReturnType<typeof createRequester>,
  input: {
    clientId: string;
    code: string;
    verifier: string;
    redirectUri: string;
  },
): Promise<JsonObject> =>
  await requester.json(
    'oauth.token',
    `${AUTH}/api/accounts/oauth/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
        resource: RESOURCE,
      }),
    },
  );

const resolveStoredAccount = async (
  configRoot: string,
  registrationId: string,
  requester: ReturnType<typeof createRequester>,
): Promise<ResolvedChatGPTCredential> => {
  let account = await loadAccount(configRoot, registrationId);
  if (account === undefined) {
    throw new ChatGPTAuthError('chatgpt_account_missing');
  }
  if (
    account.needsReauthentication === true ||
    !account.scopes.includes(DIRECT_SCOPE)
  ) {
    throw new ChatGPTAuthError('chatgpt_plan_usage_not_granted');
  }
  if (account.expiresAt > Date.now()) {
    return { accessToken: account.accessToken, registrationId };
  }
  return await withAccountLock(configRoot, registrationId, async () => {
    account = await loadAccount(configRoot, registrationId);
    if (account === undefined) {
      throw new ChatGPTAuthError('chatgpt_account_missing');
    }
    if (
      account.needsReauthentication === true ||
      !account.scopes.includes(DIRECT_SCOPE)
    ) {
      throw new ChatGPTAuthError('chatgpt_plan_usage_not_granted');
    }
    if (account.expiresAt > Date.now()) {
      return { accessToken: account.accessToken, registrationId };
    }
    if (account.refreshToken.length === 0) {
      throw new ChatGPTAuthError('chatgpt_refresh_token_missing');
    }
    let token: JsonObject;
    try {
      token = await requester.json(
        'oauth.token',
        `${AUTH}/api/accounts/oauth/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: account.clientId,
            refresh_token: account.refreshToken,
            resource: RESOURCE,
          }),
        },
      );
    } catch (error) {
      if (error instanceof ChatGPTAuthError && error.code === 'invalid_grant') {
        await writeJsonAtomically(
          accountPath(configRoot, registrationId),
          {
            ...account,
            needsReauthentication: true,
          } satisfies AccountRecord,
        );
      }
      throw error;
    }
    let tokens: ReturnType<typeof tokenSet>;
    try {
      tokens = tokenSet(token);
    } catch (error) {
      if (error instanceof ChatGPTAuthError && error.field !== undefined) {
        await requester.reportParseShape(
          error.api ?? 'oauth.token',
          error.field,
          error.valueShape ?? 'unknown',
        );
      }
      throw error;
    }
    const next: AccountRecord = {
      ...account,
      ...tokens,
      ...(typeof token.id_token === 'string' ? { idToken: token.id_token } : {}),
      needsReauthentication: !tokens.scopes.includes(DIRECT_SCOPE),
    };
    await writeJsonAtomically(accountPath(configRoot, registrationId), next);
    if (next.needsReauthentication === true) {
      throw new ChatGPTAuthError('chatgpt_plan_usage_not_granted');
    }
    return { accessToken: next.accessToken, registrationId };
  });
};

/** Resolve one explicitly bound account, or the persisted selected account. */
export const resolveChatGPTCredential = async (
  options: ResolveChatGPTCredentialOptions = {},
): Promise<ResolvedChatGPTCredential> => {
  const configRoot = configRootOf(options.configRoot);
  const registrationId = await resolveRegistrationId(
    configRoot,
    options.registrationId,
    options.selectedRegistrationId,
  );
  return await resolveStoredAccount(
    configRoot,
    registrationId,
    createRequester(options.fetcher ?? fetch, options.reportFact),
  );
};

/** Read whether the account selected for a request has a usable saved grant. */
export const chatGPTCredentialPresence = async (
  options: ChatGPTCredentialPresenceOptions = {},
): Promise<'present' | 'missing' | 'unknown'> => {
  try {
    const configRoot = configRootOf(options.configRoot);
    const registrationId = await resolveRegistrationId(
      configRoot,
      options.registrationId,
      options.selectedRegistrationId,
    );
    const account = await loadAccount(configRoot, registrationId);
    return account !== undefined && account.needsReauthentication !== true &&
        account.scopes.includes(DIRECT_SCOPE)
      ? 'present'
      : 'missing';
  } catch (error) {
    return error instanceof ChatGPTAuthError &&
        (error.code === 'chatgpt_selection_missing' ||
          error.code === 'chatgpt_account_missing')
      ? 'missing'
      : 'unknown';
  }
};

/** Create the Core-owned ChatGPT OAuth and account service. */
export const createChatGPTAuthService = (
  options: ChatGPTAuthServiceOptions = {},
): ChatGPTAuthService => {
  const configRoot = configRootOf(options.configRoot);
  const requester = createRequester(
    options.fetcher ?? fetch,
    options.reportFact,
  );
  const attempts = new Map<string, PendingAuthorization>();
  const completingAttempts = new Set<string>();
  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new ChatGPTAuthError('chatgpt_attempt_expired');
  };

  return Object.freeze({
    status: async (): Promise<ChatGPTState> => await stateOf(configRoot),

    begin: async (registrationId?: string): Promise<ChatGPTLoginAttempt> => {
      ensureOpen();
      const reusableRegistration = registrationId === undefined
        ? await findUnboundRegistration(configRoot)
        : undefined;
      const resolvedRegistrationId = registrationId ??
        reusableRegistration?.registrationId ?? crypto.randomUUID();
      const existingAccount = registrationId === undefined
        ? undefined
        : await loadAccount(configRoot, resolvedRegistrationId);
      const savedRegistration = registrationId === undefined
        ? reusableRegistration
        : await loadRegistration(configRoot, resolvedRegistrationId);
      if (
        registrationId !== undefined && existingAccount === undefined &&
        savedRegistration === undefined
      ) {
        throw new ChatGPTAuthError('chatgpt_account_missing');
      }
      const clientId = existingAccount?.clientId ?? savedRegistration?.clientId;
      const hostId = await readHostId(configRoot);
      const redirectUri = 'http://127.0.0.1:1455/auth/callback';
      const pending = await createAuthorization(hostId, clientId, redirectUri);
      const attemptId = crypto.randomUUID();
      attempts.set(attemptId, {
        registrationId: resolvedRegistrationId,
        ...pending,
      });
      return Object.freeze({
        attemptId,
        registrationId: resolvedRegistrationId,
        authorizationUrl: pending.authorizationUrl,
      });
    },

    complete: async (
      attemptId: string,
      callbackUrl: string,
    ): Promise<ChatGPTState> => {
      ensureOpen();
      const pending = attempts.get(attemptId);
      if (pending === undefined) {
        throw new ChatGPTAuthError('chatgpt_attempt_not_found');
      }
      const callback = parseCallback(callbackUrl, pending);
      completingAttempts.add(attemptId);
      attempts.delete(attemptId);
      try {
        // Keep a newly issued client id even when the subsequent token exchange cannot complete.
        await saveRegistration(
          configRoot,
          pending.registrationId,
          callback.clientId,
        );
        const token = await exchangeCode(requester, {
          clientId: callback.clientId,
          code: callback.code,
          verifier: pending.verifier,
          redirectUri: pending.redirectUri,
        });
        let tokens: ReturnType<typeof tokenSet>;
        try {
          tokens = tokenSet(token);
        } catch (error) {
          if (error instanceof ChatGPTAuthError && error.field !== undefined) {
            await requester.reportParseShape(
              error.api ?? 'oauth.token',
              error.field,
              error.valueShape ?? 'unknown',
            );
          }
          throw error;
        }
        let idToken: string;
        try {
          idToken = requiredString(token.id_token, 'oauth.token', 'id_token');
        } catch (error) {
          if (error instanceof ChatGPTAuthError && error.field !== undefined) {
            await requester.reportParseShape(
              error.api ?? 'oauth.token',
              error.field,
              error.valueShape ?? 'unknown',
            );
          }
          throw error;
        }
        const identity = await verifyIdentity(
          idToken,
          callback.clientId,
          pending.nonce,
          requester,
        );
        await withAccountLock(
          configRoot,
          pending.registrationId,
          async () => {
            const previous = await loadAccount(
              configRoot,
              pending.registrationId,
            );
            if (
              previous !== undefined && identity.subject !== previous.subject
            ) {
              throw new ChatGPTAuthError(
                'chatgpt_account_identity_mismatch',
              );
            }
            const account: AccountRecord = {
              schemaVersion: 1,
              registrationId: pending.registrationId,
              clientId: callback.clientId,
              ...identity,
              idToken,
              ...tokens,
              needsReauthentication: !tokens.scopes.includes(DIRECT_SCOPE),
            };
            await writeJsonAtomically(
              accountPath(configRoot, pending.registrationId),
              account,
            );
          },
        );
        if (await selectedFromDisk(configRoot) === undefined) {
          await persistSelection(configRoot, pending.registrationId);
        }
        await report(options.reportFact, {
          kind: 'login',
          provider: 'openai-chatgpt',
          identityVerified: true,
          planUsageEnabled: tokens.scopes.includes(DIRECT_SCOPE),
        });
        return await stateOf(configRoot);
      } finally {
        completingAttempts.delete(attemptId);
      }
    },

    cancel: (attemptId: string): Promise<void> => {
      ensureOpen();
      if (completingAttempts.has(attemptId)) {
        throw new ChatGPTAuthError('chatgpt_completion_in_progress');
      }
      attempts.delete(attemptId);
      return Promise.resolve();
    },

    select: async (registrationId: string): Promise<ChatGPTState> => {
      ensureOpen();
      const account = await loadAccount(configRoot, registrationId);
      if (account === undefined) {
        throw new ChatGPTAuthError('chatgpt_account_missing');
      }
      await persistSelection(configRoot, registrationId);
      return await stateOf(configRoot);
    },

    selectedRegistrationId: async (): Promise<string | undefined> =>
      await selectedFromDisk(configRoot),

    resolve: async (
      registrationId?: string,
    ): Promise<ResolvedChatGPTCredential> => {
      ensureOpen();
      return await resolveChatGPTCredential({
        configRoot,
        ...(registrationId === undefined ? {} : { registrationId }),
        fetcher: options.fetcher,
        reportFact: options.reportFact,
      });
    },

    presence: async (
      registrationId?: string,
    ): Promise<'present' | 'missing' | 'unknown'> =>
      await chatGPTCredentialPresence({
        configRoot,
        ...(registrationId === undefined ? {} : { registrationId }),
      }),

    close: (): Promise<void> => {
      closed = true;
      attempts.clear();
      return Promise.resolve();
    },
  });
};
