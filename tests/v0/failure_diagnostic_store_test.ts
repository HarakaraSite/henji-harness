import { assert, assertEquals, assertRejects } from './test_helpers.ts';
import {
  createFailureDiagnostic,
  FailureDiagnosticCollisionError,
  FailureDiagnosticOwner,
  type FailureDiagnosticV1,
} from '../../v0/agent/failure_diagnostic.ts';
import {
  DenoFailureDiagnosticStore,
  failureDiagnosticPaths,
  FailureDiagnosticStoreError,
  FakeFailureDiagnosticStore,
  MAX_FAILURE_DIAGNOSTICS,
} from '../../v0/agent/failure_diagnostic_store.ts';
import { AgentSession } from '../../v0/agent/session.ts';
import { ParentTurnExecutionContext } from '../../v0/agent/execution_context.ts';
import { OpenRouterAgentError } from '../../v0/agent/openrouter_model.ts';
import { createPlannerDelegationTool } from '../../v0/agent/planner_delegation.ts';
import { Registry } from '../../v0/agent/tools.ts';
import { runAgentTurn } from '../../v0/agent/loop.ts';
import type { Model, ModelRequest } from '../../v0/agent/contracts.ts';
import { CancellationCleanupError } from '../../v0/agent/cancellation.ts';
import type { SessionPersistence } from '../../v0/agent/session.ts';

const UUIDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000013',
  '00000000-0000-4000-8000-000000000014',
  '00000000-0000-4000-8000-000000000015',
  '00000000-0000-4000-8000-000000000016',
  '00000000-0000-4000-8000-000000000017',
] as const;
const TIME = '2026-09-02T00:00:00.000Z';

const diagnostic = (id: string, turn = 1): FailureDiagnosticV1 =>
  createFailureDiagnostic({
    stage: 'response_parse',
    code: 'response_error',
    lane: 'parent',
    providerRequestCount: 1,
    httpStatus: 200,
    parseReason: 'invalid_sse_json',
    turnNumber: turn,
    modelStep: 1,
    occurredAt: TIME,
  }, { uuid: () => id, now: () => TIME });

const storeRoot = async (): Promise<
  { root: string; state: string; workspace: string }
> => {
  const root = await Deno.makeTempDir({ prefix: 'henji-diagnostics-' });
  return { root, state: `${root}/state`, workspace: `${root}/workspace` };
};

const expectStoreError = async (
  operation: () => Promise<unknown>,
  code: FailureDiagnosticStoreError['code'],
): Promise<void> => {
  await assertRejects(async () => {
    try {
      await operation();
    } catch (error) {
      assert(error instanceof FailureDiagnosticStoreError);
      assertEquals(error.code, code);
      throw error;
    }
    throw new Error('expected store error');
  });
};

Deno.test('diagnostic store partitions by workspace and persists canonical records with strict modes', async () => {
  const fixture = await storeRoot();
  try {
    const store = new DenoFailureDiagnosticStore(
      fixture.state,
      fixture.workspace,
    );
    const other = new DenoFailureDiagnosticStore(
      fixture.state,
      `${fixture.root}/other`,
    );
    const value = diagnostic(UUIDS[0]);
    await store.write(value);
    assertEquals(await store.read(value.diagnosticId), value);
    assertEquals(await store.list(), [value]);
    assertEquals(await other.list(), []);
    const paths = await failureDiagnosticPaths(
      fixture.state,
      fixture.workspace,
    );
    const rootInfo = await Deno.lstat(paths.root);
    const diagnosticsInfo = await Deno.lstat(paths.diagnostics);
    const locksInfo = await Deno.lstat(paths.locks);
    const fileInfo = await Deno.lstat(
      `${paths.diagnostics}/${value.diagnosticId}.json`,
    );
    assertEquals(rootInfo.mode! & 0o777, 0o700);
    assertEquals(diagnosticsInfo.mode! & 0o777, 0o700);
    assertEquals(locksInfo.mode! & 0o777, 0o700);
    assertEquals(fileInfo.mode! & 0o777, 0o600);
    assert(
      !rootInfo.isSymlink && !diagnosticsInfo.isSymlink && !fileInfo.isSymlink,
    );
    assertEquals(
      new TextDecoder().decode(
        await Deno.readFile(`${paths.diagnostics}/${value.diagnosticId}.json`),
      ),
      JSON.stringify(value) + '\n',
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test('diagnostic store enforces 16-record capacity without eviction', async () => {
  const fixture = await storeRoot();
  try {
    const store = new DenoFailureDiagnosticStore(
      fixture.state,
      fixture.workspace,
    );
    for (let index = 0; index < MAX_FAILURE_DIAGNOSTICS; index += 1) {
      await store.write(diagnostic(UUIDS[index], index + 1));
    }
    await expectStoreError(
      () => store.write(diagnostic(UUIDS[16], 17)),
      'diagnostic_capacity',
    );
    assertEquals(
      (await store.list()).map((value) => value.diagnosticId),
      [...UUIDS.slice(0, 16)].sort(),
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test('diagnostic store rejects duplicate IDs, malformed namespace entries, and stale temp collisions', async () => {
  const fixture = await storeRoot();
  try {
    const store = new DenoFailureDiagnosticStore(
      fixture.state,
      fixture.workspace,
    );
    const value = diagnostic(UUIDS[0]);
    await store.write(value);
    await expectStoreError(() => store.write(value), 'diagnostic_invalid');
    const paths = await failureDiagnosticPaths(
      fixture.state,
      fixture.workspace,
    );
    await Deno.writeTextFile(`${paths.diagnostics}/unexpected`, 'marker');
    await expectStoreError(() => store.list(), 'diagnostic_invalid');
    await Deno.remove(`${paths.diagnostics}/unexpected`);
    await Deno.symlink(
      `${paths.diagnostics}/${value.diagnosticId}.json`,
      `${paths.diagnostics}/.tmp-${UUIDS[1]}`,
    );
    await expectStoreError(() => store.list(), 'diagnostic_invalid');
    await Deno.remove(`${paths.diagnostics}/.tmp-${UUIDS[1]}`);
    await Deno.writeTextFile(`${paths.diagnostics}/.tmp-${UUIDS[1]}`, 'x');
    await Deno.chmod(`${paths.diagnostics}/.tmp-${UUIDS[1]}`, 0o644);
    await expectStoreError(() => store.list(), 'diagnostic_invalid');
    await Deno.chmod(`${paths.diagnostics}/.tmp-${UUIDS[1]}`, 0o600);
    await Deno.writeTextFile(`${paths.diagnostics}/.tmp-${UUIDS[2]}`, 'x');
    await expectStoreError(() => store.list(), 'diagnostic_invalid');
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test('diagnostic store fails closed for wrong mode, owner, and corrupt canonical bytes', async () => {
  const fixture = await storeRoot();
  try {
    const store = new DenoFailureDiagnosticStore(
      fixture.state,
      fixture.workspace,
    );
    await store.write(diagnostic(UUIDS[3]));
    const paths = await failureDiagnosticPaths(
      fixture.state,
      fixture.workspace,
    );
    await Deno.chmod(paths.diagnostics, 0o755);
    await expectStoreError(() => store.list(), 'diagnostic_invalid');
    await Deno.chmod(paths.diagnostics, 0o700);
    await Deno.writeTextFile(
      `${paths.diagnostics}/${UUIDS[0]}.json`,
      '{"schemaVersion":1}\n',
    );
    await expectStoreError(() => store.list(), 'diagnostic_invalid');
    const wrongOwner = new DenoFailureDiagnosticStore(
      fixture.state,
      fixture.workspace,
      {
        ownerId: () => (Deno.uid() ?? 0) + 1,
      },
    );
    await expectStoreError(() => wrongOwner.list(), 'diagnostic_invalid');
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test('diagnostic store atomic failure leaves prior records and reports fixed IO error', async () => {
  const fixture = await storeRoot();
  try {
    let fail = false;
    const store = new DenoFailureDiagnosticStore(
      fixture.state,
      fixture.workspace,
      {
        atomicWrite: (target, bytes, temporary) => {
          if (fail) throw new Error('private atomic marker');
          const file = Deno.openSync(temporary, {
            write: true,
            createNew: true,
            mode: 0o600,
          });
          try {
            file.writeSync(bytes);
            file.syncSync();
          } finally {
            file.close();
          }
          Deno.renameSync(temporary, target);
        },
      },
    );
    const first = diagnostic(UUIDS[0]);
    const second = diagnostic(UUIDS[1]);
    await store.write(first);
    fail = true;
    await expectStoreError(() => store.write(second), 'diagnostic_io_failure');
    assertEquals(await store.list(), [first]);
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test('diagnostic lock is nonblocking across store instances', async () => {
  const fixture = await storeRoot();
  let lock: Deno.FsFile | undefined;
  try {
    const store = new DenoFailureDiagnosticStore(
      fixture.state,
      fixture.workspace,
    );
    await store.write(diagnostic(UUIDS[3]));
    const paths = await failureDiagnosticPaths(
      fixture.state,
      fixture.workspace,
    );
    lock = await Deno.open(paths.lock, { read: true, write: true });
    assert(await lock.tryLock(true));
    await expectStoreError(
      () => store.write(diagnostic(UUIDS[0])),
      'diagnostic_busy',
    );
  } finally {
    try {
      lock?.unlockSync();
    } catch {
      // The lock may already be released during fixture cleanup.
    }
    lock?.close();
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test('shared owner persists planner failure before parent final and retains correlation', async () => {
  const persisted: FailureDiagnosticV1[] = [];
  const diagnosticStore = new FakeFailureDiagnosticStore();
  const modelRequests: ModelRequest[] = [];
  const order: string[] = [];
  let requestCount = 0;
  const childModel: Model = {
    generate: () => {
      requestCount += 1;
      order.push('child');
      throw new OpenRouterAgentError(
        'response_error',
        'private provider body marker',
        1,
        200,
        {
          stage: 'response_parse',
          code: 'response_error',
          httpStatus: 200,
          parseReason: 'invalid_sse_json',
        },
      );
    },
  };
  const parentModel: Model = {
    generate: (request) => {
      requestCount += 1;
      order.push('parent');
      modelRequests.push(request);
      return modelRequests.length === 1
        ? {
          kind: 'tool_calls' as const,
          calls: [{
            callId: 'delegate',
            name: 'delegate_to_planner',
            arguments: { task: 'plan' },
          }],
        }
        : { kind: 'final' as const, text: 'parent final' };
    },
  };
  const planner = createPlannerDelegationTool(async (task, childContext) => ({
    outcome: await runAgentTurn(task, [], childModel, new Registry([]), {
      executionContext: childContext,
      diagnosticOwner: childContext.diagnosticOwner,
    }),
    externalRequests: 1,
  }));
  const session = new AgentSession(parentModel, new Registry([planner]), {
    diagnosticPersistence: (value) => {
      order.push('persist');
      persisted.push(value);
      return diagnosticStore.write(value);
    },
    providerRequestCount: () => requestCount,
    createTurnExecutionContext: (turn, signal, cancellation, owner, count) =>
      new ParentTurnExecutionContext(
        turn,
        undefined,
        signal,
        cancellation,
        owner,
        count,
      ),
  });
  const outcome = await session.submit('delegate');
  assert(outcome.ok);
  assertEquals(outcome.finalText, 'parent final');
  assertEquals(outcome.diagnostic?.lane, 'planner');
  assertEquals(outcome.diagnostic?.providerRequestCount, 2);
  assertEquals(persisted.length, 1);
  assertEquals(await diagnosticStore.list(), persisted);
  assertEquals(order, ['parent', 'child', 'persist', 'parent']);
  await session.close();
});

const makeChildFailureModel = (): Model => ({
  generate: () => {
    throw new OpenRouterAgentError(
      'response_error',
      'private provider body marker',
      1,
      200,
      {
        stage: 'response_parse',
        code: 'response_error',
        httpStatus: 200,
        parseReason: 'invalid_sse_json',
      },
    );
  },
});

const makeDelegatingParent = (
  childModel: Model,
  second: (session: AgentSession) => Model['generate'],
): {
  readonly session: AgentSession;
  readonly records: FailureDiagnosticV1[];
} => {
  const records: FailureDiagnosticV1[] = [];
  const parentModel: Model = {
    generate: (request, options) => {
      if (request.transcript.length === 1) {
        return {
          kind: 'tool_calls' as const,
          calls: [{
            callId: 'delegate',
            name: 'delegate_to_planner',
            arguments: { task: 'plan' },
          }],
        };
      }
      return second(session)(request, options);
    },
  };
  const planner = createPlannerDelegationTool(async (task, childContext) => ({
    outcome: await runAgentTurn(task, [], childModel, new Registry([]), {
      executionContext: childContext,
      diagnosticOwner: childContext.diagnosticOwner,
    }),
    externalRequests: 1,
  }));
  const session = new AgentSession(parentModel, new Registry([planner]), {
    diagnosticPersistence: (value) => {
      records.push(value);
    },
    createTurnExecutionContext: (turn, signal, cancellation, owner, count) =>
      new ParentTurnExecutionContext(
        turn,
        undefined,
        signal,
        cancellation,
        owner,
        count,
      ),
  });
  return { session, records };
};

Deno.test('planner failure survives a later parent exception without replacement', async () => {
  const { session, records } = makeDelegatingParent(
    makeChildFailureModel(),
    () => {
      throw new Error('private parent exception marker');
    },
  );
  const outcome = await session.submit('exception');
  assert(!outcome.ok);
  assertEquals(outcome.diagnostic?.lane, 'planner');
  assertEquals(outcome.diagnostic?.parseReason, 'invalid_sse_json');
  assertEquals(records.length, 1);
  assert(!session.isAvailable());
  await session.close();
});

Deno.test('planner failure survives parent cancellation after child settlement', async () => {
  const { session, records } = makeDelegatingParent(
    makeChildFailureModel(),
    (current) => () => {
      assertEquals(current.cancelActiveTurn(), 'requested');
      return { kind: 'final' as const, text: 'ignored after cancellation' };
    },
  );
  const outcome = await session.submit('cancel');
  assert(!outcome.ok);
  assertEquals(outcome.stopReason, 'cancelled');
  assertEquals(outcome.diagnostic?.lane, 'planner');
  assertEquals(records.length, 1);
  assert(session.isAvailable());
  await session.close();
});

Deno.test('diagnostic owner collision preserves the first record and caches persistence', async () => {
  let writes = 0;
  const owner = new FailureDiagnosticOwner(1, {
    uuid: () => UUIDS[0],
    now: () => TIME,
    persist: () => {
      writes += 1;
    },
  });
  const first = owner.record({
    stage: 'transport',
    code: 'transport_error',
    providerRequestCount: 1,
    modelStep: 1,
  });
  let collision: unknown;
  try {
    owner.record({
      stage: 'http',
      code: 'http_error',
      providerRequestCount: 1,
      httpStatus: 500,
      modelStep: 1,
    });
  } catch (error) {
    collision = error;
  }
  assert(collision instanceof FailureDiagnosticCollisionError);
  assert(owner.hasCollision);
  assertEquals(owner.snapshot(), first);
  await owner.persist();
  await owner.persist();
  assertEquals(writes, 1);
});

const noOpPersistence = (): SessionPersistence => ({
  record: undefined,
  commit: () => undefined,
  rollback: () => undefined,
  close: () => undefined,
});

Deno.test('session commit and cancellation cleanup failures persist typed diagnostics without commit', async () => {
  const commitRecords: FailureDiagnosticV1[] = [];
  const commitSession = new AgentSession(
    { generate: () => ({ kind: 'final' as const, text: 'answer' }) },
    new Registry([]),
    {
      persistence: {
        ...noOpPersistence(),
        commit: () => {
          throw new Error('private commit marker');
        },
      },
      diagnosticPersistence: (value) => {
        commitRecords.push(value);
      },
    },
  );
  const commitOutcome = await commitSession.submit('commit');
  assert(!commitOutcome.ok);
  assertEquals(commitOutcome.diagnostic?.stage, 'session_commit');
  assertEquals(commitOutcome.diagnostic?.code, 'commit_error');
  assertEquals(commitSession.transcriptSnapshot(), []);
  assert(!commitSession.isAvailable());

  const cleanupRecords: FailureDiagnosticV1[] = [];
  const cleanupSession = new AgentSession(
    {
      generate: () => {
        throw new CancellationCleanupError();
      },
    },
    new Registry([]),
    {
      diagnosticPersistence: (value) => {
        cleanupRecords.push(value);
      },
    },
  );
  const cleanupOutcome = await cleanupSession.submit('cleanup');
  assert(!cleanupOutcome.ok);
  assertEquals(cleanupOutcome.diagnostic?.stage, 'cancellation_cleanup');
  assertEquals(cleanupOutcome.diagnostic?.code, 'cleanup_error');
  assertEquals(commitRecords.length, 1);
  assertEquals(cleanupRecords.length, 1);
  assert(!cleanupSession.isAvailable());
});

Deno.test('persistence failure retains the same recoverable diagnostic with a fixed error code', async () => {
  const events: import('../../v0/agent/events.ts').AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate: () => {
        throw new Error('private model marker');
      },
    },
    new Registry([]),
    {
      eventSink: (event) => events.push(event),
      diagnosticPersistence: () => {
        throw new Error('private persistence marker');
      },
    },
  );
  const outcome = await session.submit('failed persistence');
  assert(!outcome.ok);
  assertEquals(outcome.diagnosticDurability, 'failed');
  assertEquals(outcome.diagnosticPersistenceError, 'diagnostic_io_failure');
  const event = events.at(-1);
  assert(event?.kind === 'turn_end');
  assertEquals(event.diagnostic?.diagnosticId, outcome.diagnostic?.diagnosticId);
  assertEquals(event.diagnosticDurability, 'failed');
  assertEquals(event.diagnosticPersistenceError, 'diagnostic_io_failure');
  assert(session.isAvailable());
  assertEquals(session.transcriptSnapshot(), []);
});

Deno.test('diagnostic persistence settles before its terminal event is published', async () => {
  const order: string[] = [];
  const session = new AgentSession(
    {
      generate: () => {
        throw new Error('private model marker');
      },
    },
    new Registry([]),
    {
      eventSink: (event) => {
        if (event.kind === 'turn_end') order.push('event');
      },
      diagnosticPersistence: () => {
        order.push('persist');
      },
    },
  );
  const outcome = await session.submit('publish order');
  assert(!outcome.ok);
  assertEquals(order, ['persist', 'event']);
  assertEquals(outcome.diagnosticDurability, 'yes');
  await session.close();
});

Deno.test('credential, authorization, and private payload markers never cross diagnostic surfaces', async () => {
  const fixture = await storeRoot();
  try {
    const store = new DenoFailureDiagnosticStore(fixture.state, fixture.workspace);
    const events: import('../../v0/agent/events.ts').AgentEvent[] = [];
    const session = new AgentSession(
      {
        generate: () => {
          throw new OpenRouterAgentError(
            'response_error',
            'credential-value-marker Authorization: Bearer authorization-shaped-marker private-payload-marker',
            1,
            200,
            {
              stage: 'response_parse',
              code: 'response_error',
              httpStatus: 200,
              parseReason: 'invalid_sse_json',
            },
          );
        },
      },
      new Registry([]),
      {
        eventSink: (event) => events.push(event),
        diagnosticPersistence: store.persist,
      },
    );
    const outcome = await session.submit('marker test');
    const id = outcome.diagnostic?.diagnosticId;
    assert(id !== undefined);
    const readback = await store.read(id);
    const paths = await store.pathsPromise;
    const raw = await Deno.readTextFile(`${paths.diagnostics}/${id}.json`);
    // LoopOutcome.error retains its existing internal compatibility text; only the typed
    // diagnostic projections may cross persistence/event boundaries.
    const surfaces = JSON.stringify({ diagnostic: outcome.diagnostic, events, readback });
    assert(!surfaces.includes('credential-value-marker'));
    assert(!surfaces.includes('authorization-shaped-marker'));
    assert(!surfaces.includes('private-payload-marker'));
    assert(!raw.includes('credential-value-marker'));
    assert(!raw.includes('Authorization: Bearer'));
    assert(!raw.includes('authorization-shaped-marker'));
    assert(!raw.includes('private-payload-marker'));
    for (const path of [`${paths.root}/sessions`, `${paths.root}/contexts`]) {
      let exists = false;
      try {
        await Deno.lstat(path);
        exists = true;
      } catch (error) {
        assert(error instanceof Deno.errors.NotFound);
      }
      assert(!exists);
    }
    await session.close();
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test('close waits for the active diagnostic persistence before releasing session ownership', async () => {
  let release!: () => void;
  const order: string[] = [];
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = new AgentSession(
    {
      generate: () => {
        throw new Error('private model marker');
      },
    },
    new Registry([]),
    {
      persistence: {
        ...noOpPersistence(),
        close: () => {
          order.push('close');
        },
      },
      diagnosticPersistence: () => {
        order.push('persist-start');
        return pending;
      },
    },
  );
  const submit = session.submit('pending');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const close = session.close();
  assertEquals(order, ['persist-start']);
  release();
  const outcome = await submit;
  assert(!outcome.ok);
  await close;
  assertEquals(order, ['persist-start', 'close']);
});

Deno.test('successful and ordinary cancelled turns do not persist diagnostics', async () => {
  const persisted: FailureDiagnosticV1[] = [];
  const session = new AgentSession(
    { generate: () => ({ kind: 'final' as const, text: 'ok' }) },
    new Registry([]),
    {
      diagnosticPersistence: (value) => {
        persisted.push(value);
      },
    },
  );
  const success = await session.submit('success');
  assert(success.ok);
  assertEquals(persisted, []);
  await session.close();
});
