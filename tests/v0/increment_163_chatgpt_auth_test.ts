import {
  ChatGPTAuthError,
  chatGPTCredentialPresence,
  createChatGPTAuthService,
} from '../../v0/agent/provider/chatgpt_auth.ts';
import { createMockChatGPTIssuer } from './helpers/increment_163_chatgpt_issuer.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
};

const failsWith = async (
  run: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> => {
  try {
    await run();
  } catch (error) {
    assert(error instanceof ChatGPTAuthError, 'expected a ChatGPT auth error');
    assertEquals(error.code, expectedCode);
    return;
  }
  throw new Error(`expected ${expectedCode}`);
};

const withCredentialRoot = async (
  run: (credentialRoot: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-163-auth-' });
  try {
    await run(`${root}/config/henji-harness`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

const makeCallback = (
  authorizationUrl: string,
  clientId: string,
): { authorization: URL; callbackUrl: string } => {
  const authorization = new URL(authorizationUrl);
  const callback = new URL(authorization.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({
    code: 'increment-163-mock-code',
    state: authorization.searchParams.get('state')!,
    client_id: clientId,
  }).toString();
  return { authorization, callbackUrl: callback.toString() };
};

const completeLogin = async (
  service: ReturnType<typeof createChatGPTAuthService>,
  issuer: Awaited<ReturnType<typeof createMockChatGPTIssuer>>,
  registrationId?: string,
  subject = 'increment-163-test-subject',
): Promise<Awaited<ReturnType<typeof service.status>>> => {
  const attempt = await service.begin(registrationId);
  const { authorization, callbackUrl } = makeCallback(
    attempt.authorizationUrl,
    'oaiapp_increment_163',
  );
  await issuer.setNextLogin({
    clientId: 'oaiapp_increment_163',
    nonce: authorization.searchParams.get('nonce')!,
    codeChallenge: authorization.searchParams.get('code_challenge')!,
    subject,
    email: 'increment-163@example.test',
  });
  return await service.complete(attempt.attemptId, callbackUrl);
};

Deno.test('Increment 163 completes dynamic OAuth, verifies identity, persists private state, and resumes', async () => {
  await withCredentialRoot(async (credentialRoot) => {
    const issuer = await createMockChatGPTIssuer();
    const facts: Record<string, unknown>[] = [];
    const service = createChatGPTAuthService({
      credentialRoot,
      fetcher: issuer.fetcher,
      reportFact: (fact) => {
        facts.push({ ...fact });
      },
    });
    try {
      const state = await completeLogin(service, issuer);
      assertEquals(state.accounts.length, 1);
      assertEquals(state.accounts[0].label, 'increment-163@example.test');
      assertEquals(state.accounts[0].needsReauthentication, false);
      assertEquals(
        state.selectedRegistrationId,
        state.accounts[0].registrationId,
      );
      assertEquals(await service.presence(), 'present');

      const accountPath = `${credentialRoot}/chatgpt/accounts/${
        encodeURIComponent(state.accounts[0].registrationId)
      }.json`;
      const account = JSON.parse(await Deno.readTextFile(accountPath));
      const metadata = await Deno.lstat(accountPath);
      assert(metadata.isFile);
      assertEquals(
        metadata.mode !== null && (metadata.mode & 0o7777) === 0o600,
        true,
      );
      assertEquals(account.clientId, 'oaiapp_increment_163');
      assertEquals(account.subject, 'increment-163-test-subject');
      assertEquals(account.scopes.includes('chatgpt.tokens.use.direct'), true);

      const credential = await service.resolve();
      assertEquals(credential.registrationId, state.selectedRegistrationId);
      assertEquals(credential.accessToken, 'increment-163-mock-access-1');
      const persistedState = await service.status();
      assertEquals(
        JSON.stringify(persistedState).includes('accessToken'),
        false,
      );
      assertEquals(
        JSON.stringify(persistedState).includes('increment-163-mock-access'),
        false,
      );
      assert(
        issuer.requests.some((request) => request.api === 'oidc.discovery'),
      );
      assert(issuer.requests.some((request) => request.api === 'oidc.jwks'));
      assert(
        issuer.requests.some((request) =>
          request.api === 'oauth.token' &&
          request.grantType === 'authorization_code'
        ),
      );
      const factsText = JSON.stringify(facts);
      for (
        const secret of [
          'increment-163-mock-code',
          'increment-163-mock-access-1',
          'increment-163-mock-refresh-1',
          account.idToken,
        ]
      ) {
        assert(
          !factsText.includes(secret),
          'auth facts do not include credentials or callback code',
        );
      }
      assert(
        !factsText.includes('authorization'),
        'auth facts omit authorization data',
      );

      await service.close();
      const restarted = createChatGPTAuthService({
        credentialRoot,
        fetcher: issuer.fetcher,
      });
      try {
        assertEquals(
          (await restarted.status()).selectedRegistrationId,
          state.selectedRegistrationId,
        );
        assertEquals(
          (await restarted.resolve()).accessToken,
          'increment-163-mock-access-1',
        );
      } finally {
        await restarted.close();
      }
    } finally {
      await service.close();
    }
  });
});

Deno.test('Increment 163 reuses an issued client for relogin and keeps account identity bound', async () => {
  await withCredentialRoot(async (credentialRoot) => {
    const issuer = await createMockChatGPTIssuer();
    const service = createChatGPTAuthService({
      credentialRoot,
      fetcher: issuer.fetcher,
    });
    try {
      const initial = await completeLogin(service, issuer);
      const registrationId = initial.accounts[0].registrationId;

      const attempt = await service.begin(registrationId);
      const { authorization, callbackUrl } = makeCallback(
        attempt.authorizationUrl,
        'oaiapp_increment_163',
      );
      assertEquals(
        authorization.searchParams.get('client_id'),
        'oaiapp_increment_163',
      );
      assertEquals(authorization.searchParams.has('agent_name_hint'), false);
      await issuer.setNextLogin({
        clientId: 'oaiapp_increment_163',
        nonce: authorization.searchParams.get('nonce')!,
        codeChallenge: authorization.searchParams.get('code_challenge')!,
        subject: 'increment-163-test-subject',
        email: 'increment-163@example.test',
      });
      const reloginState = await service.complete(
        attempt.attemptId,
        callbackUrl,
      );
      assertEquals(reloginState.accounts.length, 1);
      assertEquals(reloginState.accounts[0].registrationId, registrationId);
      assertEquals(reloginState.selectedRegistrationId, registrationId);

      const secondAccountAttempt = await service.begin();
      assert(secondAccountAttempt.registrationId !== registrationId);
      const secondAccountAuth = new URL(secondAccountAttempt.authorizationUrl);
      const secondAccountCallback = makeCallback(
        secondAccountAttempt.authorizationUrl,
        'oaiapp_increment_163_second',
      );
      await issuer.setNextLogin({
        clientId: 'oaiapp_increment_163_second',
        nonce: secondAccountAuth.searchParams.get('nonce')!,
        codeChallenge: secondAccountAuth.searchParams.get('code_challenge')!,
        subject: 'second-chatgpt-account',
        email: 'second@example.test',
      });
      const secondAccountState = await service.complete(
        secondAccountAttempt.attemptId,
        secondAccountCallback.callbackUrl,
      );
      assertEquals(secondAccountState.accounts.length, 2);
      assertEquals(secondAccountState.selectedRegistrationId, registrationId);
      assertEquals(
        secondAccountState.accounts.some((item) =>
          item.registrationId === secondAccountAttempt.registrationId &&
          item.label === 'second@example.test'
        ),
        true,
      );
      const defaultCredential = await service.resolve();
      const boundCredential = await service.resolve(
        secondAccountAttempt.registrationId,
      );
      assertEquals(defaultCredential.registrationId, registrationId);
      assertEquals(
        boundCredential.registrationId,
        secondAccountAttempt.registrationId,
      );
      assert(defaultCredential.accessToken !== boundCredential.accessToken);
      assertEquals(
        await service.presence(secondAccountAttempt.registrationId),
        'present',
      );
      const selectedSecond = await service.select(
        secondAccountAttempt.registrationId,
      );
      assertEquals(
        selectedSecond.selectedRegistrationId,
        secondAccountAttempt.registrationId,
      );
      assertEquals(
        (await service.resolve()).registrationId,
        secondAccountAttempt.registrationId,
      );

      const mismatch = await service.begin(registrationId);
      const next = makeCallback(
        mismatch.authorizationUrl,
        'oaiapp_increment_163',
      );
      await issuer.setNextLogin({
        clientId: 'oaiapp_increment_163',
        nonce: next.authorization.searchParams.get('nonce')!,
        codeChallenge: next.authorization.searchParams.get('code_challenge')!,
        subject: 'different-chatgpt-account',
        email: 'other@example.test',
      });
      await failsWith(
        () => service.complete(mismatch.attemptId, next.callbackUrl),
        'chatgpt_account_identity_mismatch',
      );
      const afterMismatch = await service.status();
      assertEquals(
        afterMismatch.accounts.length,
        2,
      );
      assertEquals(
        afterMismatch.accounts.some((item) =>
          item.registrationId === registrationId &&
          item.label === 'increment-163@example.test'
        ),
        true,
      );
    } finally {
      await service.close();
    }
  });
});

Deno.test('Increment 163 retains an issued client id after an incomplete code exchange', async () => {
  await withCredentialRoot(async (credentialRoot) => {
    const issuer = await createMockChatGPTIssuer();
    const service = createChatGPTAuthService({
      credentialRoot,
      fetcher: issuer.fetcher,
    });
    try {
      const first = await service.begin();
      assert(first.registrationId.length > 0);
      const callback = makeCallback(
        first.authorizationUrl,
        'oaiapp_increment_163',
      );
      await failsWith(
        () => service.complete(first.attemptId, callback.callbackUrl),
        'mock_login_not_configured',
      );

      const retry = await service.begin();
      const retryAuthorization = new URL(retry.authorizationUrl);
      assertEquals(retry.registrationId, first.registrationId);
      assertEquals(
        retryAuthorization.searchParams.get('client_id'),
        'oaiapp_increment_163',
      );
      assertEquals(
        retryAuthorization.searchParams.has('agent_name_hint'),
        false,
      );
      await issuer.setNextLogin({
        clientId: 'oaiapp_increment_163',
        nonce: retryAuthorization.searchParams.get('nonce')!,
        codeChallenge: retryAuthorization.searchParams.get('code_challenge')!,
      });
      const retryCallback = makeCallback(
        retry.authorizationUrl,
        'oaiapp_increment_163',
      );
      const state = await service.complete(
        retry.attemptId,
        retryCallback.callbackUrl,
      );
      assertEquals(state.accounts.length, 1);
      assertEquals(state.accounts[0].registrationId, first.registrationId);
    } finally {
      await service.close();
    }
  });
});

Deno.test('Increment 163 rejects cancellation during completion and saves the accepted login', async () => {
  await withCredentialRoot(async (credentialRoot) => {
    const issuer = await createMockChatGPTIssuer();
    let notifyExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      notifyExchangeStarted = resolve;
    });
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (
        url.pathname === '/api/accounts/oauth/token' &&
        form.get('grant_type') === 'authorization_code'
      ) {
        notifyExchangeStarted();
        await exchangeGate;
      }
      return await issuer.fetcher(input, init);
    };
    const service = createChatGPTAuthService({ credentialRoot, fetcher });
    try {
      const cancelledBeforeSend = await service.begin();
      await service.cancel(cancelledBeforeSend.attemptId);
      await failsWith(
        () => service.complete(cancelledBeforeSend.attemptId, ''),
        'chatgpt_attempt_not_found',
      );

      const attempt = await service.begin();
      const { authorization, callbackUrl } = makeCallback(
        attempt.authorizationUrl,
        'oaiapp_increment_163',
      );
      await issuer.setNextLogin({
        clientId: 'oaiapp_increment_163',
        nonce: authorization.searchParams.get('nonce')!,
        codeChallenge: authorization.searchParams.get('code_challenge')!,
      });
      const completion = service.complete(attempt.attemptId, callbackUrl);
      await exchangeStarted;
      await failsWith(
        () => service.cancel(attempt.attemptId),
        'chatgpt_completion_in_progress',
      );

      releaseExchange();
      const state = await completion;
      assertEquals(state.accounts.length, 1);
      assertEquals(state.accounts[0].registrationId, attempt.registrationId);
      assertEquals(state.selectedRegistrationId, attempt.registrationId);
      assertEquals(await service.cancel(attempt.attemptId), undefined);
    } finally {
      releaseExchange();
      await service.close();
    }
  });
});

Deno.test('Increment 163 serializes relogin account replacement with an in-flight refresh', async () => {
  await withCredentialRoot(async (credentialRoot) => {
    const issuer = await createMockChatGPTIssuer();
    let notifyRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let jwksResponses = 0;
    let notifyReloginIdentityFetch!: () => void;
    const reloginIdentityFetch = new Promise<void>((resolve) => {
      notifyReloginIdentityFetch = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (
        url.pathname === '/api/accounts/oauth/token' &&
        form.get('grant_type') === 'refresh_token'
      ) {
        notifyRefreshStarted();
        await refreshGate;
        return new Response(
          JSON.stringify({ error: { code: 'invalid_grant' } }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      const response = await issuer.fetcher(input, init);
      if (url.pathname === '/.well-known/mock-jwks') {
        jwksResponses++;
        if (jwksResponses === 2) notifyReloginIdentityFetch();
      }
      return response;
    };
    const service = createChatGPTAuthService({ credentialRoot, fetcher });
    let registrationId: string;
    try {
      const initial = await completeLogin(service, issuer);
      registrationId = initial.accounts[0].registrationId;
      const accountPath = `${credentialRoot}/chatgpt/accounts/${
        encodeURIComponent(registrationId)
      }.json`;
      const expiredAccount = JSON.parse(await Deno.readTextFile(accountPath));
      expiredAccount.expiresAt = Date.now() - 1;
      await Deno.writeTextFile(
        accountPath,
        `${JSON.stringify(expiredAccount)}\n`,
      );

      const refresh = service.resolve(registrationId);
      await refreshStarted;
      const relogin = await service.begin(registrationId);
      const { authorization, callbackUrl } = makeCallback(
        relogin.authorizationUrl,
        'oaiapp_increment_163',
      );
      await issuer.setNextLogin({
        clientId: 'oaiapp_increment_163',
        nonce: authorization.searchParams.get('nonce')!,
        codeChallenge: authorization.searchParams.get('code_challenge')!,
      });
      let completionSettled = false;
      const completion = service.complete(relogin.attemptId, callbackUrl)
        .finally(() => {
          completionSettled = true;
        });
      await reloginIdentityFetch;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assertEquals(completionSettled, false);

      releaseRefresh();
      await failsWith(() => refresh, 'invalid_grant');
      const state = await completion;
      assertEquals(state.accounts[0].registrationId, registrationId);
      assertEquals(state.accounts[0].needsReauthentication, false);
      const saved = JSON.parse(await Deno.readTextFile(accountPath));
      assertEquals(saved.accessToken, 'increment-163-mock-access-2');
      assertEquals(saved.refreshToken, 'increment-163-mock-refresh-2');
      assertEquals(saved.needsReauthentication, false);
      assertEquals(await service.presence(registrationId), 'present');
    } finally {
      releaseRefresh();
      await service.close();
    }
  });
});

Deno.test('Increment 163 requires the nonce and direct inference scope before exposing an account token', async () => {
  await withCredentialRoot(async (credentialRoot) => {
    const issuer = await createMockChatGPTIssuer();
    const service = createChatGPTAuthService({
      credentialRoot,
      fetcher: issuer.fetcher,
    });
    try {
      const attempt = await service.begin();
      const { authorization, callbackUrl } = makeCallback(
        attempt.authorizationUrl,
        'oaiapp_increment_163',
      );
      await issuer.setNextLogin({
        clientId: 'oaiapp_increment_163',
        nonce: 'wrong-nonce',
        codeChallenge: authorization.searchParams.get('code_challenge')!,
      });
      await failsWith(
        () => service.complete(attempt.attemptId, callbackUrl),
        'chatgpt_id_token_verification_failed',
      );
      assertEquals((await service.status()).accounts.length, 0);
    } finally {
      await service.close();
    }

    const issuerWithoutGrant = await createMockChatGPTIssuer();
    const noGrantService = createChatGPTAuthService({
      credentialRoot: `${credentialRoot}-no-grant`,
      fetcher: issuerWithoutGrant.fetcher,
    });
    try {
      const attempt = await noGrantService.begin();
      const { authorization, callbackUrl } = makeCallback(
        attempt.authorizationUrl,
        'oaiapp_increment_163',
      );
      await issuerWithoutGrant.setNextLogin({
        clientId: 'oaiapp_increment_163',
        nonce: authorization.searchParams.get('nonce')!,
        codeChallenge: authorization.searchParams.get('code_challenge')!,
        scope: 'openid profile email offline_access resource.invoke',
      });
      const state = await noGrantService.complete(
        attempt.attemptId,
        callbackUrl,
      );
      assertEquals(state.accounts[0].needsReauthentication, true);
      assertEquals(await noGrantService.presence(), 'missing');
      await failsWith(
        () => noGrantService.resolve(),
        'chatgpt_plan_usage_not_granted',
      );
    } finally {
      await noGrantService.close();
    }
  });
});

Deno.test('Increment 163 serializes refresh across processes and rereads the replacement token', async () => {
  await withCredentialRoot(async (credentialRoot) => {
    const issuer = await createMockChatGPTIssuer();
    const service = createChatGPTAuthService({
      credentialRoot,
      fetcher: issuer.fetcher,
    });
    let registrationId: string;
    try {
      const state = await completeLogin(service, issuer);
      registrationId = state.accounts[0].registrationId;
      const path = `${credentialRoot}/chatgpt/accounts/${encodeURIComponent(registrationId)}.json`;
      const account = JSON.parse(await Deno.readTextFile(path));
      account.expiresAt = Date.now() - 1;
      await Deno.writeTextFile(path, `${JSON.stringify(account)}\n`);
    } finally {
      await service.close();
    }

    const workerPath = new URL('./increment_163_chatgpt_auth_refresh_worker.ts', import.meta.url)
      .pathname;
    const startWorker = () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          'run',
          '--no-config',
          `--allow-read=${credentialRoot},${Deno.cwd()}`,
          `--allow-write=${credentialRoot}`,
          workerPath,
          credentialRoot,
          registrationId,
        ],
        stdout: 'piped',
        stderr: 'piped',
      }).output();
    const [first, second] = await Promise.all([startWorker(), startWorker()]);
    assertEquals(first.code, 0);
    assertEquals(second.code, 0);
    assertEquals(
      new TextDecoder().decode(first.stdout).trim(),
      'increment-163-replacement-access',
    );
    assertEquals(
      new TextDecoder().decode(second.stdout).trim(),
      'increment-163-replacement-access',
    );
    const refreshFacts = (await Deno.readTextFile(`${credentialRoot}/refresh-request-count.txt`))
      .split('\n').filter((line) => line === 'refresh');
    assertEquals(refreshFacts.length, 1);
    const path = `${credentialRoot}/chatgpt/accounts/${encodeURIComponent(registrationId)}.json`;
    const updated = JSON.parse(await Deno.readTextFile(path));
    assertEquals(updated.accessToken, 'increment-163-replacement-access');
    assertEquals(updated.refreshToken, 'increment-163-replacement-refresh');
    assertEquals(
      await chatGPTCredentialPresence({ credentialRoot, registrationId }),
      'present',
    );
  });
});
