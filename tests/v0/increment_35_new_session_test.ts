import { selectModelFor } from '../../v0/agent/provider/model_catalog.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
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

Deno.test('Increment 35 creates and adopts a durable empty Session with the current binding', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-increment-35-new-session-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const events: PresentationEvent[] = [];
  let created: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
  let reopened: Awaited<ReturnType<typeof createWorkerSession>> | undefined;
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
    const oldId = navigation.currentPosition().sessionId;
    assert(oldId !== undefined);
    const oldDefinition = created.session.definition;
    assert((await created.session.submit('preserve the old Session')).ok);
    assertEquals(navigation.renameCurrent('Previous work'), 'renamed');
    const inherited = selectModelFor('openai', 'gpt-5.6-terra', 'high');
    assertEquals(await created.session.selectModel(inherited), 'selected');
    const requestCount = created.requestCount();
    const adapter = createTuiPresentationAdapter(
      created.session,
      (event) => events.push(event),
      navigation,
    );

    const result = await adapter.dispatch({ kind: 'new_session' });
    assert(result.kind === 'binding');
    const newId = result.position.sessionId;
    assert(newId !== undefined && newId !== oldId);
    assertEquals(result.position.committedTurn, 0);
    assertEquals(result.position.messageCount, 0);
    assertEquals(result.position.title, undefined);
    assertEquals(result.position.checkpoint, undefined);
    assertEquals(result.restored, { messages: [], omitted: 0 });
    assertEquals(adapter.modelSelectionSnapshot(), inherited);
    assertEquals(created.requestCount(), requestCount);

    const storedNew = await store.readWorker(newId);
    assertEquals(storedNew.nextTurn, 1);
    assertEquals(storedNew.transcript, []);
    assertEquals(storedNew.title, null);
    assertEquals(storedNew.activeModel, inherited);
    assertEquals(storedNew.definition, oldDefinition);
    assertEquals(storedNew.turnModels, []);
    assertEquals(storedNew.turnExecutions, []);
    assertEquals(await store.readCheckpoint(newId), undefined);

    const storedOld = await store.readWorker(oldId);
    assertEquals(storedOld.title, 'Previous work');
    assert(storedOld.transcript.length > 0);
    const listed = await navigation.list();
    assert(listed.sessions.some((row) => row.id === oldId && !row.current));
    assert(listed.sessions.some((row) => row.id === newId && row.current));
    assertEquals(
      events.slice(-2).map((event) => event.kind),
      ['session_binding_replaced', 'restored_log'],
    );
    const resumedOld = await adapter.dispatch({ kind: 'resume_session', id: oldId });
    assert(resumedOld.kind === 'binding');
    assertEquals(resumedOld.position.sessionId, oldId);
    assertEquals(resumedOld.position.title, 'Previous work');
    assert((resumedOld.restored?.messages.length ?? 0) > 0);
    assertEquals(created.requestCount(), requestCount);

    await created.close();
    created = undefined;
    reopened = await createWorkerSession({
      workspaceRoot,
      stateRoot,
      persistence: 'session',
      sessionId: newId,
      physicalIoMode: 'provider-free',
    });
    assertEquals(reopened.navigation?.currentPosition().committedTurn, 0);
    assertEquals(reopened.session.modelSelectionSnapshot(), inherited);
    assertEquals(reopened.restored, { messages: [], omitted: 0 });
  } finally {
    await reopened?.close();
    await created?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 35 keeps the current presentation binding when new Session setup fails', async () => {
  const oldSelection = selectModelFor('openrouter', 'z-ai/glm-5.3-flash', 'low');
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
    renameCurrent: () => 'unchanged',
    createNew: () => Promise.reject(new Error('target setup failed')),
    switchTo: () => Promise.reject(new Error('not used')) as Promise<NavigationBinding>,
    historyPage: () => Promise.resolve(undefined),
    currentPosition: () => position,
  };
  const events: PresentationEvent[] = [];
  const adapter = createTuiPresentationAdapter(core, (event) => events.push(event), navigation);
  let rejected = false;
  try {
    await adapter.dispatch({ kind: 'new_session' });
  } catch (error) {
    rejected = error instanceof Error && error.message === 'target setup failed';
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
