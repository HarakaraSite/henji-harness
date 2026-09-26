/**
 * Increment 135 focused checks for the Host-local credential registration service.
 *
 * Every value is a dummy credential kept inside this test process. The storage path is the
 * production fixed credential path resolved from the process XDG config root; tests isolate it by
 * changing `XDG_CONFIG_HOME` and never write a real credential.
 */

import {
  createCredentialRegistration,
  CredentialRegistrationError,
  credentialRegistrationFailureNotice,
  credentialRegistrationTargets,
} from '../../v0/agent/provider/credential_registration.ts';
import {
  credentialFileFor,
  credentialFilePresenceFor,
  readCredentialFileFor,
} from '../../v0/agent/provider/credential_file.ts';
import { createCredentialResolver } from '../../v0/agent/provider/credential_resolver.ts';
import {
  builtinProviderDeclarations,
  validateProviderDeclaration,
} from '../../v0/agent/provider/provider_declaration.ts';
import {
  activeProviderDeclarations,
  setActiveProviderDeclarations,
} from '../../v0/agent/provider/provider_runtime.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import type { TuiActiveSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { createTuiPresentationAdapter } from '../../v0/presentation/tui_presentation_adapter.ts';

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

const failsWith = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    assert(error instanceof CredentialRegistrationError, 'expected a registration error');
    return error.code;
  }
  throw new Error('expected the save to fail');
};

const withIsolatedXdg = async (
  run: (configRoot: string) => Promise<void>,
): Promise<void> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-135-credential-' });
  const names = [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
  ] as const;
  const previous = names.map((name) => Deno.env.get(name));
  Deno.env.set('XDG_CONFIG_HOME', `${root}/config`);
  Deno.env.set('XDG_DATA_HOME', `${root}/data`);
  Deno.env.set('XDG_STATE_HOME', `${root}/state`);
  try {
    await run(`${root}/config/henji-harness`);
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
    await Deno.remove(root, { recursive: true });
  }
};

const chatDeclaration = validateProviderDeclaration({
  schemaVersion: 1,
  providerId: 'increment135-chat',
  protocol: 'openai-chat-completions',
  endpoint: 'https://increment-135.invalid/v1',
  authProfile: 'increment135-shared-key',
  modelCatalog: {
    kind: 'fixed',
    entries: [{ modelId: 'increment-135-chat', defaultEffort: 'auto', efforts: ['auto'] }],
  },
  defaults: { modelId: 'increment-135-chat', effort: 'auto' },
});

const responsesDeclaration = validateProviderDeclaration({
  schemaVersion: 1,
  providerId: 'increment135-responses',
  protocol: 'openai-responses',
  endpoint: 'https://increment-135.invalid/v1',
  authProfile: 'increment135-shared-key',
  modelCatalog: {
    kind: 'fixed',
    entries: [{ modelId: 'increment-135-responses', defaultEffort: 'auto', efforts: ['auto'] }],
  },
  defaults: { modelId: 'increment-135-responses', effort: 'auto' },
});

const separateDeclaration = validateProviderDeclaration({
  schemaVersion: 1,
  providerId: 'increment135-separate',
  protocol: 'openai-chat-completions',
  endpoint: 'https://increment-135-separate.invalid/v1',
  authProfile: 'increment135-separate-key',
  modelCatalog: {
    kind: 'fixed',
    entries: [{ modelId: 'increment-135-separate', defaultEffort: 'auto', efforts: ['auto'] }],
  },
  defaults: { modelId: 'increment-135-separate', effort: 'auto' },
});

Deno.test('Increment 135 enumerates effective declarations and groups shared profiles once', () => {
  const previous = activeProviderDeclarations();
  try {
    setActiveProviderDeclarations([
      ...builtinProviderDeclarations(),
      chatDeclaration,
      responsesDeclaration,
      separateDeclaration,
    ]);
    const targets = credentialRegistrationTargets();
    assertEquals(
      targets.map((target) => ({
        authProfile: target.authProfile,
        providers: [...target.providers],
      })),
      [
        {
          authProfile: 'openrouter-api-key',
          providers: ['openrouter-chat', 'openrouter-responses'],
        },
        {
          authProfile: 'openai-api-key',
          providers: ['openai-chat', 'openai-responses'],
        },
        {
          authProfile: 'increment135-shared-key',
          providers: ['increment135-chat', 'increment135-responses'],
        },
        {
          authProfile: 'increment135-separate-key',
          providers: ['increment135-separate'],
        },
      ],
    );
    const profiles = targets.map((target) => target.authProfile);
    assertEquals(profiles.length, new Set(profiles).size);
  } finally {
    setActiveProviderDeclarations(previous);
  }
});

Deno.test('Increment 135 saves and updates one credential the current reader accepts', async () => {
  await withIsolatedXdg(async (configRoot) => {
    const registration = createCredentialRegistration();
    const profile = 'increment135-shared-key';
    const first = 'increment-135-dummy-a';
    const second = 'increment-135-dummy-b';
    await registration.save(profile, first);
    assertEquals(await readCredentialFileFor(profile), first);
    assertEquals(credentialFileFor(profile), `${configRoot}/${profile}`);

    const metadata = await Deno.lstat(credentialFileFor(profile));
    assert(metadata.isFile);
    assertEquals(metadata.mode !== null && (metadata.mode & 0o7777) === 0o600, true);
    assertEquals(metadata.uid, Deno.uid());
    assertEquals(await credentialFilePresenceFor(profile), 'present');

    const resolver = createCredentialResolver();
    assertEquals(await resolver.resolve(profile), first);
    await registration.save(profile, second);
    assertEquals(await resolver.resolve(profile), second);
    assertEquals(await readCredentialFileFor(profile), second);

    const entries: string[] = [];
    for await (const entry of Deno.readDir(configRoot)) entries.push(entry.name);
    assertEquals(entries, [profile]);
  });
});

Deno.test('Increment 135 keeps the previous credential readable when an update cannot be written', async () => {
  if (Deno.uid() === 0) return;
  await withIsolatedXdg(async (configRoot) => {
    const registration = createCredentialRegistration();
    const profile = 'increment135-shared-key';
    await registration.save(profile, 'increment-135-dummy-old');
    await Deno.chmod(configRoot, 0o500);
    try {
      assertEquals(
        await failsWith(() => registration.save(profile, 'increment-135-dummy-new')),
        'credential_registration_write_failed',
      );
    } finally {
      await Deno.chmod(configRoot, 0o700);
    }
    assertEquals(await readCredentialFileFor(profile), 'increment-135-dummy-old');
    const entries: string[] = [];
    for await (const entry of Deno.readDir(configRoot)) entries.push(entry.name);
    assertEquals(entries, [profile]);
  });
});

Deno.test('Increment 135 refuses values the current reader would reject', async () => {
  await withIsolatedXdg(async () => {
    const registration = createCredentialRegistration();
    const profile = 'increment135-shared-key';
    for (
      const value of [
        '',
        'has space',
        'line\nbreak',
        'prefix\ninfix\nsuffix',
        'x'.repeat(4097),
        'y'.repeat(4096) + '\n',
      ]
    ) {
      const code = await failsWith(() => registration.save(profile, value));
      assertEquals(code, 'credential_registration_value_invalid');
    }
    assertEquals(
      credentialRegistrationFailureNotice(
        new CredentialRegistrationError('credential_registration_value_invalid'),
      ),
      'credential input invalid',
    );
    assertEquals(await credentialFilePresenceFor(profile), 'missing');
    assertEquals(
      await failsWith(() => registration.save('providers', 'dummy')),
      'credential_registration_profile_invalid',
    );
  });
});

Deno.test('Increment 135 refreshes presence for the current selection without new Worker work', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-135-refresh-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const names = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;
  const previous = names.map((name) => Deno.env.get(name));
  Deno.env.set('XDG_CONFIG_HOME', `${root}/config`);
  Deno.env.set('XDG_DATA_HOME', `${root}/data`);
  Deno.env.set('XDG_STATE_HOME', `${root}/xdg-state`);
  let capsuleStarts = 0;
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
      initialModelSelection: defaultModelSelectionFor('openrouter-chat'),
      capsuleFactory: (url) => {
        capsuleStarts += 1;
        return new WorkerCapsule(url);
      },
    });
    const session = created.session;
    const selectionBefore = session.modelSelectionSnapshot();
    const sessionIdBefore = session.sessionId;
    // Provider-free physical I/O carries no credential inspection, so the Worker-reported
    // startup snapshot is 'unknown'. The Host-local refresh below is the display path under test.
    assertEquals(session.credentialAvailabilitySnapshot(), {
      authProfile: 'openrouter-api-key',
      status: 'unknown',
    });

    const registration = createCredentialRegistration();
    const startsBeforeRefresh = capsuleStarts;
    const requestsBeforeRefresh = session.requestCount();
    assertEquals(await session.refreshCredentialAvailability(), {
      authProfile: 'openrouter-api-key',
      status: 'missing',
    });
    await registration.save('openrouter-api-key', 'increment-135-dummy-a');
    const refreshed = await session.refreshCredentialAvailability();
    assertEquals(refreshed, {
      authProfile: 'openrouter-api-key',
      status: 'present',
    });
    assertEquals(session.credentialAvailabilitySnapshot(), refreshed);
    assertEquals(capsuleStarts, startsBeforeRefresh);
    assertEquals(session.requestCount(), requestsBeforeRefresh);
    assertEquals(session.modelSelectionSnapshot(), selectionBefore);
    assertEquals(session.sessionId, sessionIdBefore);

    const adapter = createTuiPresentationAdapter(session);
    assertEquals(await adapter.refreshCredentialAvailability(), refreshed);

    const navigation = created.navigation;
    assert(navigation?.createNew !== undefined && navigation.switchTo !== undefined);
    assert((await session.submit('materialize session A for Increment 135')).ok);
    const storedId = navigation.currentPosition().sessionId;
    assert(storedId !== undefined);
    await navigation.createNew();
    const startsBeforeSwitch = capsuleStarts;
    const lazy = (await navigation.switchTo(storedId)).session as TuiActiveSession;
    assertEquals(capsuleStarts, startsBeforeSwitch);
    const lazyRefresh = await lazy.refreshCredentialAvailability();
    assertEquals(capsuleStarts, startsBeforeSwitch);
    assertEquals(lazyRefresh, {
      authProfile: 'openrouter-api-key',
      status: 'present',
    });
    assertEquals(lazy.credentialAvailabilitySnapshot(), lazyRefresh);

    const resolver = createCredentialResolver();
    assertEquals(await resolver.resolve('openrouter-api-key'), 'increment-135-dummy-a');
    await registration.save('openrouter-api-key', 'increment-135-dummy-b');
    assertEquals(await resolver.resolve('openrouter-api-key'), 'increment-135-dummy-b');
    assertEquals(session.sessionId, sessionIdBefore);
  } finally {
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    });
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});
