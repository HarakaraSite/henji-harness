/** Test-only OAuth/OIDC issuer for Increment 163. It never contacts the network. */

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const encoder = new TextEncoder();

export interface MockChatGPTLogin {
  readonly clientId: string;
  readonly nonce: string;
  readonly codeChallenge?: string;
  readonly subject?: string;
  readonly email?: string;
  readonly scope?: string;
  readonly expiresIn?: number;
}

export interface MockChatGPTRequest {
  readonly api: string;
  readonly method: string;
  readonly grantType?: string;
  readonly clientId?: string;
  readonly bearerPresent?: boolean;
}

export interface MockChatGPTIssuer {
  readonly fetcher: typeof fetch;
  readonly requests: readonly MockChatGPTRequest[];
  setNextLogin(input: MockChatGPTLogin): Promise<void>;
}

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_')
    .replace(/=+$/u, '');

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req_increment_163_mock',
    },
  });

const signIdToken = async (
  key: CryptoKey,
  input:
    & Required<Pick<MockChatGPTLogin, 'clientId' | 'nonce'>>
    & MockChatGPTLogin,
): Promise<string> => {
  const encode = (value: unknown) => base64Url(encoder.encode(JSON.stringify(value)));
  const head = encode({ alg: 'RS256', kid: 'increment-163-test-key' });
  const claims = encode({
    iss: AUTH,
    aud: input.clientId,
    sub: input.subject ?? 'increment-163-test-subject',
    exp: Date.now() / 1000 + 3600,
    nonce: input.nonce,
    ...(input.email === undefined ? {} : { email: input.email }),
  });
  const signed = `${head}.${claims}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(signed),
  );
  return `${signed}.${base64Url(new Uint8Array(signature))}`;
};

export const createMockChatGPTIssuer = async (): Promise<MockChatGPTIssuer> => {
  const pair = await crypto.subtle.generateKey(
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
    ...await crypto.subtle.exportKey('jwk', pair.publicKey),
    kid: 'increment-163-test-key',
  };
  let nextLogin: MockChatGPTLogin | undefined;
  let nextIdToken: string | undefined;
  let tokenSequence = 0;
  const requests: MockChatGPTRequest[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const bearerPresent = headers.has('authorization');
    if (url.href === `${AUTH}/.well-known/openid-configuration`) {
      requests.push({ api: 'oidc.discovery', method });
      return json({
        issuer: AUTH,
        jwks_uri: `${AUTH}/.well-known/mock-jwks`,
      });
    }
    if (url.href === `${AUTH}/.well-known/mock-jwks`) {
      requests.push({ api: 'oidc.jwks', method });
      return json({ keys: [publicJwk] });
    }
    if (url.href === `${AUTH}/api/accounts/oauth/token`) {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const grantType = form.get('grant_type') ?? undefined;
      const clientId = form.get('client_id') ?? undefined;
      requests.push({ api: 'oauth.token', method, grantType, clientId });
      if (grantType === 'authorization_code') {
        if (nextLogin === undefined || nextIdToken === undefined) {
          return json({ error: { code: 'mock_login_not_configured' } }, 500);
        }
        if (clientId !== nextLogin.clientId) {
          return json({ error: { code: 'mock_client_id_mismatch' } }, 400);
        }
        const verifier = form.get('code_verifier') ?? '';
        const challenge = base64Url(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', encoder.encode(verifier)),
          ),
        );
        if (
          verifier.length === 0 ||
          (nextLogin.codeChallenge !== undefined &&
            challenge !== nextLogin.codeChallenge)
        ) return json({ error: { code: 'mock_pkce_invalid' } }, 400);
        tokenSequence++;
        const login = nextLogin;
        const idToken = nextIdToken;
        nextLogin = undefined;
        nextIdToken = undefined;
        return json({
          access_token: `increment-163-mock-access-${tokenSequence}`,
          refresh_token: `increment-163-mock-refresh-${tokenSequence}`,
          expires_in: login.expiresIn ?? 3600,
          scope: login.scope ?? DIRECT_SCOPE,
          id_token: idToken,
        });
      }
      if (grantType === 'refresh_token') {
        tokenSequence++;
        return json({
          access_token: `increment-163-mock-access-${tokenSequence}`,
          refresh_token: `increment-163-mock-refresh-${tokenSequence}`,
          expires_in: 3600,
          scope: DIRECT_SCOPE,
        });
      }
      return json({ error: { code: 'mock_grant_type_invalid' } }, 400);
    }
    if (url.href === `${RESOURCE}/models`) {
      requests.push({ api: 'models', method, bearerPresent });
      return json({ models: [] });
    }
    requests.push({ api: 'unknown', method, bearerPresent });
    return json({ error: { code: 'mock_endpoint_missing' } }, 404);
  };

  return Object.freeze({
    fetcher,
    requests,
    async setNextLogin(input: MockChatGPTLogin): Promise<void> {
      nextLogin = input;
      nextIdToken = await signIdToken(pair.privateKey, input);
    },
  });
};
