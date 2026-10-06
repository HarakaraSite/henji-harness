import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import {
  builtinCredentialDeclarations,
  validateCredentialDeclaration,
} from '../../v0/agent/provider/credential_declaration.ts';
import { credentialFileFor } from '../../v0/agent/provider/credential_file.ts';
import {
  createCredentialRegistration,
  credentialRegistrationTargets,
} from '../../v0/agent/provider/credential_registration.ts';
import { createCredentialResolver } from '../../v0/agent/provider/credential_resolver.ts';
import {
  builtinProviderDeclarations,
  validateProviderDeclaration,
} from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient, HenjiApiError } from '../../v0/api/client.ts';

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

const braveDeclaration = (authProfile = 'brave-api-key') =>
  validateCredentialDeclaration({
    schemaVersion: 1,
    authProfile,
    label: 'Brave Search — API key',
    purpose: 'Web search',
    method: 'api-key',
    consumers: ['tool:web_search'],
  });

Deno.test('Increment 173 registers Exa and external service keys through the existing resolver path', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-173-registration-' });
  const credentialRoot = `${root}/credentials`;
  try {
    const registration = createCredentialRegistration({
      credentialRoot,
      providerDeclarations: [],
      credentialDeclarations: [...builtinCredentialDeclarations(), braveDeclaration()],
    });
    assertEquals(
      registration.targets().map(({ authProfile, providers, consumers, purpose }) => ({
        authProfile,
        providers: [...providers],
        consumers: consumers === undefined ? undefined : [...consumers],
        purpose,
      })),
      [
        {
          authProfile: 'exa-api-key',
          providers: [],
          consumers: ['tool:web_search'],
          purpose: 'Web search',
        },
        {
          authProfile: 'brave-api-key',
          providers: [],
          consumers: ['tool:web_search'],
          purpose: 'Web search',
        },
      ],
    );

    const resolver = createCredentialResolver({ credentialRoot });
    const exaFirst = 'increment-173-exa-dummy-first';
    const exaUpdated = 'increment-173-exa-dummy-updated';
    const braveKey = 'increment-173-brave-dummy';
    await registration.save('exa-api-key', exaFirst);
    await registration.save('brave-api-key', braveKey);
    assertEquals(await resolver.resolve('exa-api-key'), exaFirst);
    assertEquals(await resolver.resolve('brave-api-key'), braveKey);
    await registration.save('exa-api-key', exaUpdated);
    assertEquals(await resolver.resolve('exa-api-key'), exaUpdated);
    assertEquals(
      await Deno.readTextFile(credentialFileFor('exa-api-key', credentialRoot)),
      exaUpdated,
    );
    assertEquals(
      await Deno.readTextFile(credentialFileFor('brave-api-key', credentialRoot)),
      braveKey,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 173 groups shared provider and service profiles while retaining provider display metadata', () => {
  const provider = validateProviderDeclaration({
    schemaVersion: 1,
    providerId: 'increment173-provider',
    protocol: 'openai-chat-completions',
    endpoint: 'https://increment-173.invalid/v1',
    authProfile: 'increment173-shared-key',
    modelCatalog: {
      kind: 'fixed',
      entries: [{ modelId: 'increment-173-model', defaultEffort: 'auto', efforts: ['auto'] }],
    },
    defaults: { modelId: 'increment-173-model', effort: 'auto' },
  });
  const search = validateCredentialDeclaration({
    schemaVersion: 1,
    authProfile: 'increment173-shared-key',
    label: 'Search service key',
    purpose: 'Web search',
    method: 'api-key',
    consumers: ['tool:web_search', 'tool:shared'],
  });
  const fetch = validateCredentialDeclaration({
    schemaVersion: 1,
    authProfile: 'increment173-shared-key',
    label: 'Fetch service key',
    purpose: 'Page download',
    method: 'api-key',
    consumers: ['tool:shared', 'tool:web_fetch'],
  });

  const targets = credentialRegistrationTargets([provider], [search, fetch]);
  assertEquals(targets, [{
    authProfile: 'increment173-shared-key',
    providers: ['increment173-provider'],
    method: 'api-key',
    label: 'increment173-shared-key — API key',
    consumers: ['tool:web_search', 'tool:shared', 'tool:web_fetch'],
    purpose: 'Web search · Page download',
  }]);
});

Deno.test('Increment 173 loads service declarations into the Core API registration catalog', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-173-core-' });
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${root}/config`;
  const dataRoot = `${root}/data`;
  const stateRoot = `${root}/state`;
  const credentialRoot = `${stateRoot}/credentials`;
  await Deno.mkdir(workspaceRoot, { recursive: true });
  await Deno.mkdir(`${configRoot}/credentials`, { recursive: true });
  await Deno.writeTextFile(
    `${configRoot}/credentials/brave-search.json`,
    JSON.stringify(braveDeclaration()),
  );

  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  try {
    core = await createCoreService({
      workspaceRoot,
      configRoot,
      dataRoot,
      stateRoot,
      physicalIoMode: 'provider-free',
      providerDeclarations: builtinProviderDeclarations().filter((item) =>
        item.providerId !== 'openai-chatgpt'
      ),
      initialSession: { kind: 'none' },
    });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);
    const catalog = await client.catalogRead({ kind: 'credentials' });
    assert(catalog.kind === 'credentials');
    const exa = catalog.profiles.find((profile) => profile.authProfile === 'exa-api-key');
    const brave = catalog.profiles.find((profile) => profile.authProfile === 'brave-api-key');
    assert(exa);
    assertEquals({
      providers: [...brave!.providers],
      method: brave!.method,
      label: brave!.label,
      consumers: brave!.consumers === undefined ? undefined : [...brave!.consumers],
      purpose: brave!.purpose,
    }, {
      providers: [],
      method: 'api-key',
      label: 'Brave Search — API key',
      consumers: ['tool:web_search'],
      purpose: 'Web search',
    });

    const providerCatalog = await client.catalogRead({ kind: 'providers' });
    assert(providerCatalog.kind === 'providers');
    assertEquals(
      providerCatalog.providers.map((item) => item.provider),
      builtinProviderDeclarations().filter((item) => item.providerId !== 'openai-chatgpt')
        .map((item) => item.providerId),
    );
    let modelsRejected = false;
    try {
      await client.catalogRead({ kind: 'models', provider: 'brave-search' });
    } catch (error) {
      modelsRejected = error instanceof HenjiApiError && error.status === 404;
    }
    assert(modelsRejected, 'service declarations must not enter the model catalog');

    const key = 'increment-173-core-brave-dummy';
    const registered = await client.credentialRegister({
      authProfile: 'brave-api-key',
      value: key,
    });
    assertEquals(registered, {
      kind: 'registered',
      authProfile: 'brave-api-key',
      status: 'present',
    });
    const presence = await client.credentialPresenceRead();
    const bravePresence = presence.profiles.find((profile) =>
      profile.authProfile === 'brave-api-key'
    );
    assertEquals(bravePresence, {
      authProfile: 'brave-api-key',
      providers: [],
      method: 'api-key',
      label: 'Brave Search — API key',
      consumers: ['tool:web_search'],
      purpose: 'Web search',
      status: 'present',
    });
    assertEquals(
      await createCredentialResolver({ credentialRoot }).resolve('brave-api-key'),
      key,
    );
    const apiMetadata = JSON.stringify({ catalog, providerCatalog, registered, presence });
    assert(!apiMetadata.includes(key), 'API metadata must not contain the credential value');
  } finally {
    if (server !== undefined) await server.shutdown();
    else await core?.close();
    await Deno.remove(root, { recursive: true });
  }
});
