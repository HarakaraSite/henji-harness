import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/server.ts';
import { HenjiApiClient, HenjiApiError } from '../../v0/api/client.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { createMockChatGPTIssuer } from './helpers/increment_163_chatgpt_issuer.ts';

Deno.test('ChatGPT login API starts and cancels without changing the parent provider', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-163-api-' });
  const issuer = await createMockChatGPTIssuer();
  let externalRequests = 0;
  const core = await createCoreService({
    workspaceRoot: root,
    configRoot: `${root}/config`,
    dataRoot: `${root}/data`,
    stateRoot: `${root}/state`,
    physicalIoMode: 'provider-free',
    initialSession: { kind: 'new' },
    providerDeclarations: builtinProviderDeclarations(),
    chatgptFetcher: (input, init) => {
      externalRequests += 1;
      return issuer.fetcher(input, init);
    },
    catalogFetcher: (input) => {
      const url = new URL(String(input));
      return Promise.resolve(Response.json(
        url.pathname.endsWith('/models')
          ? {
            models: [
              { slug: 'account-model-b', display_name: 'Account model B', visibility: 'list' },
              { slug: 'account-model-a', display_name: 'Account model A', visibility: 'list' },
              { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
            ],
          }
          : {},
      ));
    },
  });
  const server = await startCoreServer(core);
  const client = new HenjiApiClient(server.url);
  try {
    const sessionId = core.coreRead().activeSessionId!;
    const before = await client.sessionRead(sessionId);
    const profiles = await client.catalogRead({ kind: 'credentials' });
    strictEqual(profiles.kind, 'credentials');
    if (profiles.kind !== 'credentials') throw new Error('Credential catalog expected');
    const chatgpt = profiles.profiles.find((profile) => profile.authProfile === 'openai-chatgpt');
    ok(chatgpt);
    strictEqual(chatgpt.method, 'chatgpt');
    strictEqual(chatgpt.label, 'Sign in with ChatGPT');
    deepStrictEqual(chatgpt.providers, ['openai-chatgpt']);

    const status = await client.chatgptAuth({ kind: 'status' });
    strictEqual(status.kind, 'chatgpt');
    if (status.kind !== 'chatgpt') throw new Error('Account state expected');
    deepStrictEqual(status.state.accounts, []);
    await rejects(
      () => client.catalogRead({ kind: 'models', provider: 'openai-chatgpt' }),
      (error: unknown) =>
        error instanceof HenjiApiError &&
        error.message === 'chatgpt_selection_missing',
    );

    const started = await client.chatgptAuth({ kind: 'begin' });
    strictEqual(started.kind, 'chatgpt');
    if (started.kind !== 'chatgpt' || started.attempt === undefined) {
      throw new Error('Login attempt expected');
    }
    const authorization = new URL(started.attempt.authorizationUrl);
    strictEqual(authorization.origin, 'https://auth.openai.com');
    strictEqual(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
    ok(authorization.searchParams.get('code_challenge'));
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', 'wrong-state');
    callback.searchParams.set('code', 'callback-secret-must-not-be-returned');
    const rejected = await client.chatgptAuth({
      kind: 'complete',
      attemptId: started.attempt.attemptId,
      callbackUrl: callback.href,
    });
    strictEqual(rejected.kind, 'rejected');
    ok(!JSON.stringify(rejected).includes('callback-secret-must-not-be-returned'));

    strictEqual(
      (await client.chatgptAuth({
        kind: 'cancel',
        attemptId: started.attempt.attemptId,
      })).kind,
      'chatgpt',
    );
    deepStrictEqual(
      (await client.sessionRead(sessionId)).session.selection,
      before.session.selection,
    );
    strictEqual(externalRequests, 0);
    strictEqual(
      (await client.credentialRegister({
        authProfile: 'openai-chatgpt',
        value: 'not-an-api-key-registration',
      })).kind,
      'rejected',
    );
    const login = await client.chatgptAuth({ kind: 'begin' });
    if (login.kind !== 'chatgpt' || login.attempt === undefined) {
      throw new Error('Login attempt expected');
    }
    const auth = new URL(login.attempt.authorizationUrl);
    await issuer.setNextLogin({
      clientId: 'increment-163-core-client',
      nonce: auth.searchParams.get('nonce')!,
      codeChallenge: auth.searchParams.get('code_challenge')!,
      email: 'core-test@example.test',
    });
    const approvedCallback = new URL(auth.searchParams.get('redirect_uri')!);
    approvedCallback.searchParams.set('state', auth.searchParams.get('state')!);
    approvedCallback.searchParams.set('client_id', 'increment-163-core-client');
    approvedCallback.searchParams.set('code', 'increment-163-test-authorization-code');
    const connected = await client.chatgptAuth({
      kind: 'complete',
      attemptId: login.attempt.attemptId,
      callbackUrl: approvedCallback.href,
    });
    strictEqual(connected.kind, 'chatgpt', JSON.stringify(connected));
    if (connected.kind !== 'chatgpt') throw new Error('Connected account expected');
    strictEqual(connected.state.accounts.length, 1);
    ok(connected.state.accounts[0].label.includes('core-test@example.test'));
    strictEqual(connected.state.selectedRegistrationId, connected.state.accounts[0].registrationId);
    strictEqual(connected.state.accounts[0].needsReauthentication, false);
    ok(!JSON.stringify(connected).includes('increment-163-mock-access'));
    ok(!JSON.stringify(connected).includes('increment-163-mock-refresh'));
    deepStrictEqual(
      (await client.sessionRead(sessionId)).session.selection,
      before.session.selection,
    );
    const models = await client.catalogRead({
      kind: 'models',
      provider: 'openai-chatgpt',
      registrationId: connected.state.accounts[0].registrationId,
    });
    if (models.kind !== 'models') throw new Error('ChatGPT catalog expected');
    deepStrictEqual(models.models.map((model) => model.modelId), [
      'account-model-b',
      'account-model-a',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]);
    deepStrictEqual(
      (await client.sessionRead(sessionId)).session.selection,
      before.session.selection,
    );
    const presence = await client.credentialPresenceRead();
    strictEqual(
      presence.profiles.find((profile) => profile.authProfile === 'openai-chatgpt')?.status,
      'present',
    );
  } finally {
    await server.shutdown();
    await core.close();
    await Deno.remove(root, { recursive: true });
  }
});
