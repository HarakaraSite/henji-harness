import { match, ok, strictEqual } from 'node:assert';
import { createApplicationService } from '../../v0/agent/host/application_service.ts';
import { createCoreService } from '../../v0/agent/host/core_service.ts';
import { startCoreServer } from '../../v0/agent/http/api_worker_client.ts';
import { defaultModelSelectionFor } from '../../v0/agent/provider/model_catalog.ts';
import { builtinProviderDeclarations } from '../../v0/agent/provider/provider_declaration.ts';
import { HenjiApiClient } from '../../v0/api/client.ts';
import { decodeSessionSnapshotJson } from '../../v0/api/codec.ts';
import type { SessionSnapshot } from '../../v0/api/contract.ts';

const response = (text: string): Response => {
  const value = {
    type: 'response.completed',
    response: {
      id: crypto.randomUUID(),
      output: [{
        type: 'message',
        id: crypto.randomUUID(),
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      }],
    },
  };
  const delta = { type: 'response.output_text.delta', delta: text };
  return new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(value)}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
};

const startupStatus = (snapshot: SessionSnapshot): string | undefined => {
  const startup = snapshot.session.startup;
  if (typeof startup !== 'object' || startup === null || Array.isArray(startup)) return undefined;
  const status = (startup as Readonly<Record<string, unknown>>).status;
  return typeof status === 'string' ? status : undefined;
};

Deno.test('S22 Slice 2 HTTP read client reads saved history without activation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-s22-slice2-http-' });
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previous = Object.keys(environment).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  const workspaceRoot = `${root}/workspace`;
  const configRoot = `${environment.XDG_CONFIG_HOME}/henji-harness`;
  const dataRoot = `${environment.XDG_DATA_HOME}/henji-harness`;
  const stateRoot = `${environment.XDG_STATE_HOME}/henji-harness/v1`;
  await Deno.mkdir(workspaceRoot);
  await Deno.mkdir(configRoot, { recursive: true });
  await Deno.writeTextFile(`${configRoot}/openrouter-api-key`, 'local-test-key', { mode: 0o600 });
  let providerRequests = 0;
  const provider = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    async (request) => {
      await request.json();
      providerRequests += 1;
      return response('S22 saved history result');
    },
  );
  const declarations = builtinProviderDeclarations().map((entry) =>
    entry.providerId === 'openrouter-responses'
      ? { ...entry, endpoint: `http://127.0.0.1:${provider.addr.port}/v1` }
      : entry
  );
  const options = {
    workspaceRoot,
    stateRoot,
    configRoot,
    dataRoot,
    physicalIoMode: 'production' as const,
    agent: 'default' as const,
    agentChoice: {},
    rootMaxSteps: 2,
    initialModelSelection: defaultModelSelectionFor('openrouter-responses'),
    providerDeclarations: declarations,
  };
  let seeded: Awaited<ReturnType<typeof createApplicationService>> | undefined;
  let core: Awaited<ReturnType<typeof createCoreService>> | undefined;
  let server: Awaited<ReturnType<typeof startCoreServer>> | undefined;
  let capsuleStarts = 0;
  try {
    seeded = await createApplicationService({
      ...options,
      agent: 'generic',
      agentChoice: { name: 'generic' },
      persistence: 'new',
    });
    const genericSessionId = seeded.session.sessionId;
    const genericOutcome = await seeded.session.submit('Save one generic Session result');
    ok(genericOutcome.ok, JSON.stringify(genericOutcome));
    await seeded.close();
    seeded = undefined;

    seeded = await createApplicationService({ ...options, persistence: 'new' });
    const savedSessionId = seeded.session.sessionId;
    const outcome = await seeded.session.submit('Write one saved result for Slice 2');
    ok(outcome.ok, JSON.stringify(outcome));
    strictEqual(outcome.finalText, 'S22 saved history result');
    strictEqual(providerRequests, 2);
    await seeded.close();
    seeded = undefined;

    core = await createCoreService({
      ...options,
      capsuleFactory: () => {
        capsuleStarts += 1;
        throw new Error('read-only Slice 2 path attempted to start a Worker');
      },
    });
    server = await startCoreServer(core);
    const client = new HenjiApiClient(server.url);

    const coreView = await client.coreRead();
    strictEqual(coreView.apiVersion, 1);
    strictEqual(coreView.workspace, workspaceRoot);
    strictEqual(coreView.activeSessionId, null);
    ok(coreView.build.productVersion.length > 0);
    ok(coreView.implementedOperations.includes('history.read'));

    const snapshot = await client.sessionRead(savedSessionId);
    strictEqual((await client.sessionRead(genericSessionId)).session.position.agent, 'generic');
    strictEqual(snapshot.session.id, savedSessionId);
    strictEqual(snapshot.runtime.active, false);
    strictEqual(snapshot.runtime.activeSessionId, null);
    strictEqual(snapshot.session.startup.status, 'unevaluated');
    strictEqual(snapshot.session.startup.productVersion, coreView.build.productVersion);
    strictEqual(snapshot.session.startup.workspace, workspaceRoot);
    strictEqual(snapshot.session.startup.sessionMode.kind, 'exact');
    ok(
      Object.values(snapshot.conversation.entities).some((item) =>
        item.kind === 'message' && item.text === 'S22 saved history result'
      ),
    );
    strictEqual((await client.coreRead()).activeSessionId, null);
    strictEqual(capsuleStarts, 0);
    strictEqual(providerRequests, 2);

    const listed = await client.sessionsList();
    ok(listed.sessions.some((item) => item.id === savedSessionId));
    const sessionHistory = await client.historyRead({
      sessionRef: savedSessionId.slice(0, 8),
      view: 'session',
    });
    strictEqual(sessionHistory.sessionId, savedSessionId);
    match(sessionHistory.text, /S22 saved history result/u);
    const canonicalHistory = await client.historyRead({ latest: true, view: 'canonical' });
    strictEqual(canonicalHistory.sessionId, savedSessionId);
    match(canonicalHistory.text, /S22 saved history result/u);
    const detailHistory = await client.historyRead({ latest: true, view: 'detail' });
    strictEqual(detailHistory.sessionId, savedSessionId);
    ok(detailHistory.text.endsWith('\n'));
    ok(
      detailHistory.text.split('\n').filter(Boolean).every((line) =>
        typeof JSON.parse(line) === 'object'
      ),
    );

    const subscription = client.sessionSubscribe(savedSessionId)[Symbol.asyncIterator]();
    const first = await subscription.next();
    ok(!first.done);
    strictEqual(first.value.kind, 'session.snapshot');
    if (first.value.kind === 'session.snapshot') {
      strictEqual(first.value.snapshot.session.id, savedSessionId);
    }
    await subscription.return?.(undefined);
    strictEqual((await client.coreRead()).activeSessionId, null);
    strictEqual(capsuleStarts, 0);

    const openInput = {
      commandId: 'slice2-new-command',
      selection: { kind: 'new' as const },
      activation: { agent: 'generic' },
    };
    const [opened, concurrentDuplicate] = await Promise.all([
      client.sessionOpen(openInput),
      client.sessionOpen(openInput),
    ]);
    ok(opened.kind === 'accepted' && concurrentDuplicate.kind === 'accepted');
    if (opened.kind !== 'accepted' || concurrentDuplicate.kind !== 'accepted') return;
    strictEqual(concurrentDuplicate.value.sessionId, opened.value.sessionId);
    const openedSnapshot = await client.sessionRead(opened.value.sessionId);
    strictEqual(openedSnapshot.session.position.agent, 'generic');
    strictEqual(startupStatus(openedSnapshot), 'unevaluated');
    const openedAgain = await client.sessionOpen({
      commandId: 'slice2-new-command',
      selection: { kind: 'new' },
      activation: { agent: 'generic' },
    });
    ok(openedAgain.kind === 'accepted');
    if (openedAgain.kind !== 'accepted') return;
    strictEqual(openedAgain.value.sessionId, opened.value.sessionId);
    strictEqual((await client.coreRead()).activeSessionId, opened.value.sessionId);

    const savedWhileActive = await client.sessionRead(savedSessionId);
    strictEqual(savedWhileActive.session.id, savedSessionId);
    strictEqual(savedWhileActive.runtime.active, false);
    strictEqual(savedWhileActive.runtime.activeSessionId, opened.value.sessionId);
    strictEqual((await client.coreRead()).activeSessionId, opened.value.sessionId);

    const genericResume = await client.sessionOpen({
      commandId: 'slice5-generic-resume-command',
      selection: { kind: 'exact', sessionId: genericSessionId },
    });
    strictEqual(genericResume.kind, 'accepted');
    if (genericResume.kind !== 'accepted') return;
    strictEqual(
      (await client.sessionRead(genericResume.value.sessionId)).session.position.agent,
      'generic',
    );
    strictEqual(capsuleStarts, 0);

    const none = await client.sessionOpen({
      commandId: 'slice2-none-command',
      selection: { kind: 'none' },
    });
    ok(none.kind === 'accepted');
    if (none.kind !== 'accepted') return;
    strictEqual((await client.sessionRead(none.value.sessionId)).session.persistence, 'none');
    const exact = await client.sessionOpen({
      commandId: 'slice2-exact-command',
      selection: { kind: 'exact', sessionId: savedSessionId },
    });
    ok(exact.kind === 'accepted');
    if (exact.kind !== 'accepted') return;
    strictEqual(exact.value.sessionId, savedSessionId);
    ok(
      Object.values((await client.sessionRead(exact.value.sessionId)).conversation.entities).some((
        item,
      ) => item.kind === 'message' && item.text === 'S22 saved history result'),
    );
    const noneAgain = await client.sessionOpen({
      commandId: 'slice2-none-again-command',
      selection: { kind: 'none' },
    });
    strictEqual(noneAgain.kind, 'accepted');
    if (noneAgain.kind !== 'accepted') return;
    strictEqual((await client.sessionRead(noneAgain.value.sessionId)).session.persistence, 'none');
    const continued = await client.sessionOpen({
      commandId: 'slice2-continue-command',
      selection: { kind: 'continue' },
    });
    ok(continued.kind === 'accepted');
    if (continued.kind !== 'accepted') return;
    strictEqual(continued.value.sessionId, savedSessionId);
    strictEqual(capsuleStarts, 0);
    strictEqual(providerRequests, 2);

    await server.shutdown();
    server = undefined;
    await core.close();
    core = undefined;

    let initialCapsuleStarts = 0;
    const initial = await createCoreService({
      ...options,
      initialSession: { kind: 'exact', sessionId: savedSessionId },
      capsuleFactory: () => {
        initialCapsuleStarts += 1;
        throw new Error('lazy initial Session attempted to start a Worker');
      },
    });
    try {
      strictEqual(initial.coreRead().activeSessionId, savedSessionId);
      strictEqual(
        startupStatus(
          decodeSessionSnapshotJson(
            new TextDecoder().decode((await initial.sessionRead(savedSessionId)).bytes),
          ),
        ),
        'unevaluated',
      );
      strictEqual(initialCapsuleStarts, 0);
      strictEqual(providerRequests, 2);
    } finally {
      await initial.close();
    }
  } finally {
    await server?.shutdown();
    await core?.close();
    await seeded?.close();
    await provider.shutdown();
    await provider.finished;
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
