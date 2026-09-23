import { defaultModelSelectionFor, selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import type {
  NavigationBinding,
  SessionNavigationHost,
} from '../../v0/agent/session/session_navigation.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import type { PresentationEvent } from '../../v0/presentation/contract.ts';
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

const presentationSelection = (
  selection: ReturnType<typeof selectModelFor>,
) => ({
  provider: selection.provider,
  modelId: selection.modelId,
  effort: selection.effort,
});

const assertSessionNotFound = async (
  store: SqliteHistoryV7ProductionStore,
  id: string,
): Promise<void> => {
  let notFound = false;
  try {
    await store.readWorker(id);
  } catch (error) {
    notFound = typeof error === 'object' && error !== null &&
      (error as { readonly code?: unknown }).code === 'session_not_found';
  }
  assert(notFound, `expected ${id} not to be materialized`);
};

Deno.test('Increment 47 keeps a new binding temporary until its first durable change', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-47-new-session-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    const navigation = created.navigation;
    assert(navigation?.createNew !== undefined);
    assert((await created.session.submit('preserve the old Session')).ok);
    const oldId = navigation.currentPosition().sessionId;
    assert(oldId !== undefined);
    const inherited = selectModelFor('openai-responses', 'gpt-5.6-terra', 'high');
    assertEquals(await created.session.selectModel(inherited), 'selected');
    const adapter = createTuiPresentationAdapter(
      created.session,
      undefined,
      navigation,
    );

    const result = await adapter.dispatch({ kind: 'new_session' });
    assert(result.kind === 'binding');
    const temporaryId = result.position.sessionId;
    assert(temporaryId !== undefined && temporaryId !== oldId);
    assertEquals(result.position.committedTurn, 0);
    assertEquals(result.position.messageCount, 0);
    assertEquals(result.restored, { messages: [], omitted: 0 });
    assertEquals(adapter.modelSelectionSnapshot(), inherited);
    await assertSessionNotFound(store, temporaryId);

    const listed = await navigation.list();
    assert(listed.sessions.some((row) => row.id === oldId));
    assert(!listed.sessions.some((row) => row.id === temporaryId));

    const resumed = await adapter.dispatch({
      kind: 'resume_session',
      id: oldId,
    });
    assert(resumed.kind === 'binding');
    assertEquals(resumed.position.sessionId, oldId);
    await assertSessionNotFound(store, temporaryId);

    const second = await adapter.dispatch({ kind: 'new_session' });
    assert(second.kind === 'binding');
    const exitWithoutChangeId = second.position.sessionId;
    assert(exitWithoutChangeId !== undefined);
    await created.close();
    created = undefined;
    await assertSessionNotFound(store, exitWithoutChangeId);
  } finally {
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 47 materializes temporary bindings on existing durable admissions', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-increment-47-admissions-',
  });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  try {
    created = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    const navigation = created.navigation;
    assert(navigation?.createNew !== undefined);
    const adapter = createTuiPresentationAdapter(
      created.session,
      undefined,
      navigation,
    );

    const renamed = await adapter.dispatch({ kind: 'new_session' });
    assert(
      renamed.kind === 'binding' && renamed.position.sessionId !== undefined,
    );
    assertEquals(
      await adapter.dispatch({
        kind: 'rename_session',
        title: 'Named before turn one',
      }),
      {
        kind: 'session_title',
        status: 'renamed',
        title: 'Named before turn one',
      },
    );
    assertEquals(
      (await store.readWorker(renamed.position.sessionId)).title,
      'Named before turn one',
    );

    const providerChanged = await adapter.dispatch({ kind: 'new_session' });
    assert(
      providerChanged.kind === 'binding' &&
        providerChanged.position.sessionId !== undefined,
    );
    assertEquals(
      await adapter.dispatch({ kind: 'select_provider', provider: 'openai-responses' }),
      {
        kind: 'model_selection',
        status: 'selected',
        selection: presentationSelection(defaultModelSelectionFor('openai-responses')),
      },
    );
    assertEquals(
      (await store.readWorker(providerChanged.position.sessionId)).activeModel,
      defaultModelSelectionFor('openai-responses'),
    );

    const modelChanged = await adapter.dispatch({ kind: 'new_session' });
    assert(
      modelChanged.kind === 'binding' &&
        modelChanged.position.sessionId !== undefined,
    );
    const nextModel = selectModelFor('openai-responses', 'gpt-6-astra', 'medium');
    assertEquals(
      await adapter.dispatch({
        kind: 'select_model',
        provider: nextModel.provider,
        modelId: nextModel.modelId,
        effort: nextModel.effort,
      }),
      {
        kind: 'model_selection',
        status: 'selected',
        selection: presentationSelection(nextModel),
      },
    );
    assertEquals(
      (await store.readWorker(modelChanged.position.sessionId)).activeModel,
      nextModel,
    );

    const effortChanged = await adapter.dispatch({ kind: 'new_session' });
    assert(
      effortChanged.kind === 'binding' &&
        effortChanged.position.sessionId !== undefined,
    );
    const nextEffort = selectModelFor('openai-responses', 'gpt-6-astra', 'high');
    assertEquals(
      await adapter.dispatch({
        kind: 'select_model',
        provider: nextEffort.provider,
        modelId: nextEffort.modelId,
        effort: nextEffort.effort,
      }),
      {
        kind: 'model_selection',
        status: 'selected',
        selection: presentationSelection(nextEffort),
      },
    );
    assertEquals(
      (await store.readWorker(effortChanged.position.sessionId)).activeModel,
      nextEffort,
    );

    const submitted = await adapter.dispatch({ kind: 'new_session' });
    assert(
      submitted.kind === 'binding' &&
        submitted.position.sessionId !== undefined,
    );
    const outcome = await adapter.dispatch({
      kind: 'ordinary_submit',
      text: 'first durable turn',
    });
    assert(outcome.kind === 'outcome' && outcome.outcome.ok);
    const storedTurn = await store.readWorker(submitted.position.sessionId);
    assertEquals(storedTurn.nextTurn, 2);
    assert(storedTurn.transcript.length > 0);
  } finally {
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 35 keeps the current presentation binding when new Session setup fails', async () => {
  const oldSelection = selectModelFor(
    'openrouter-chat',
    'z-ai/glm-5.3-flash',
    'low',
  );
  const core = {
    submit: () => Promise.reject(new Error('not used')),
    modelSelectionSnapshot: () => oldSelection,
  };
  const position = {
    sessionId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-09-12T00:00:00.000Z',
    agent: 'default' as const,
    committedTurn: 1,
    messageCount: 2,
  };
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: () => Promise.resolve({ sessions: [], skippedInvalid: 0 }),
    renameCurrent: () => Promise.resolve('unchanged'),
    createNew: () => Promise.reject(new Error('target setup failed')),
    switchTo: () => Promise.reject(new Error('not used')) as Promise<NavigationBinding>,
    currentPosition: () => position,
  };
  const events: PresentationEvent[] = [];
  const adapter = createTuiPresentationAdapter(
    core,
    (event) => events.push(event),
    navigation,
  );
  let rejected = false;
  try {
    await adapter.dispatch({ kind: 'new_session' });
  } catch (error) {
    rejected = error instanceof Error &&
      error.message === 'target setup failed';
  }
  assert(rejected);
  assertEquals(adapter.modelSelectionSnapshot(), oldSelection);
  assertEquals(events, []);

  const noPersistence = createTuiPresentationAdapter(core);
  assertEquals(
    await noPersistence.dispatch({ kind: 'new_session' }),
    { kind: 'rejected', reason: 'unavailable' },
  );
});
