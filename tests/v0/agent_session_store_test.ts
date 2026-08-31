import { assert, assertEquals } from './test_helpers.ts';
import {
  createSessionPersistence,
  decodeSessionRecord,
  DenoSessionStore,
  encodeSemanticContextCheckpoint,
  encodeSessionRecord,
  FakeSessionStore,
  MAX_RESTORED_DISPLAY_BYTES,
  MAX_SESSION_FILE_BYTES,
  MAX_VALID_SESSIONS_PER_WORKSPACE,
  MAX_WORKSPACE_DIRECTORY_ENTRIES,
  metadataFromRecord,
  parseCausalTranscript,
  restoredMessages,
  selectStateRoot,
  type SessionRecord,
  SessionStoreError,
  validateSessionRecord,
  workspaceDigest,
} from '../../v0/agent/session_store.ts';
import { AGENT_SESSION_UNAVAILABLE, AgentSession } from '../../v0/agent/session.ts';
import { CancellationCleanupError } from '../../v0/agent/cancellation.ts';
import { type AgentEvent, EVENT_DELIVERY_ERROR } from '../../v0/agent/events.ts';
import { Registry } from '../../v0/agent/tools.ts';
import { type ModelRequest } from '../../v0/agent/contracts.ts';
import { createRuntimeSession } from '../../v0/agent/runtime.ts';
import { DEFAULT_AGENT_SELECTION } from '../../v0/agent/agent_catalog.ts';

const id = '11111111-1111-4111-8111-111111111111';
const transcript = [
  { role: 'user' as const, content: { kind: 'text' as const, text: 'hello' } },
  {
    role: 'assistant' as const,
    content: { kind: 'text' as const, text: 'world' },
  },
];
const record = (workspaceRoot = '/tmp/workspace'): SessionRecord => ({
  schemaVersion: 1,
  sessionId: id,
  workspaceRoot,
  agent: 'default',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:01.000Z',
  nextTurn: 2,
  transcript,
});

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const steeringTranscript = (): SessionRecord['transcript'] => [
  { role: 'user', content: { kind: 'text', text: 'first' } },
  {
    role: 'assistant',
    content: [{ kind: 'tool_call', callId: 'one', name: 'continue', arguments: {} }],
  },
  {
    role: 'tool',
    content: [{
      kind: 'tool_result',
      callId: 'one',
      name: 'continue',
      text: 'complete',
      outcome: 'success',
    }],
  },
  { role: 'user', content: { kind: 'text', text: 'steer this turn' } },
  { role: 'assistant', content: { kind: 'text', text: 'finished first' } },
];

const steeringRecord = (
  workspaceRoot: string,
  sessionId = id,
  transcript = steeringTranscript(),
  nextTurn = 2,
): SessionRecord => ({
  ...record(workspaceRoot),
  sessionId,
  nextTurn,
  transcript,
});

const expectStoreError = async (
  operation: () => Promise<unknown>,
  code: SessionStoreError['code'],
): Promise<void> => {
  let actual: SessionStoreError['code'] | undefined;
  try {
    await operation();
  } catch (error) {
    if (error instanceof SessionStoreError) actual = error.code;
  }
  assertEquals(actual, code);
};

const sizedRecord = (
  sessionId: string,
  workspaceRoot: string,
  resultText: string,
): SessionRecord => ({
  schemaVersion: 1,
  sessionId,
  workspaceRoot,
  agent: 'default',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:01.000Z',
  nextTurn: 2,
  transcript: [
    { role: 'user', content: { kind: 'text', text: 'boundary' } },
    {
      role: 'assistant',
      content: [{
        kind: 'tool_call',
        callId: 'boundary-call',
        name: 'submit_json_result',
        arguments: {},
      }],
    },
    {
      role: 'tool',
      content: [{
        kind: 'tool_result',
        callId: 'boundary-call',
        name: 'submit_json_result',
        text: resultText,
        outcome: 'success',
        terminal: 'json_result',
      }],
    },
  ],
});

const largeContextTranscript = (): SessionRecord['transcript'] => [
  ...Array.from({ length: 6 }, (_, turn) => [
    {
      role: 'user' as const,
      content: { kind: 'text' as const, text: `goal-${turn} ${'x'.repeat(8_000)}` },
    },
    {
      role: 'assistant' as const,
      content: { kind: 'text' as const, text: `decision-${turn} ${'y'.repeat(8_000)}` },
    },
  ]).flat(),
];

Deno.test('session codec emits canonical v1 bytes and rejects noncanonical input', () => {
  const encoded = encodeSessionRecord(record());
  assertEquals(
    new TextDecoder().decode(encoded),
    `${JSON.stringify(record())}\n`,
  );
  assertEquals(decodeSessionRecord(encoded), record());
  for (
    const malformed of [
      `${JSON.stringify({ ...record(), schemaVersion: 2 })}\n`,
      ` ${JSON.stringify(record())}\n`,
      `${JSON.stringify({ ...record(), extra: true })}\n`,
      `\ufeff${JSON.stringify(record())}\n`,
      `${
        JSON.stringify(record()).replace(
          '"nextTurn":2',
          '"nextTurn":2,"nextTurn":2',
        )
      }\n`,
    ]
  ) {
    let rejected = false;
    try {
      decodeSessionRecord(bytes(malformed));
    } catch (error) {
      rejected = error instanceof SessionStoreError &&
        error.code === 'session_invalid';
    }
    assert(rejected, `malformed session accepted: ${malformed.slice(0, 30)}`);
  }
});

Deno.test('schema-v1 codec rejects malformed steering positions and preserves old byte shape', async () => {
  const steering = steeringRecord('/tmp/workspace');
  const encoded = encodeSessionRecord(steering);
  assertEquals(decodeSessionRecord(encoded), steering);
  assertEquals(parseCausalTranscript(steering.transcript), 1);
  assertEquals(
    new TextDecoder().decode(encoded),
    `${JSON.stringify(steering)}\n`,
  );
  const secondStep = [
    ...steeringTranscript().slice(0, 3),
    { role: 'user' as const, content: { kind: 'text' as const, text: 'first steer' } },
    {
      role: 'assistant' as const,
      content: [{ kind: 'tool_call' as const, callId: 'two', name: 'continue', arguments: {} }],
    },
    {
      role: 'tool' as const,
      content: [{
        kind: 'tool_result' as const,
        callId: 'two',
        name: 'continue',
        text: 'complete again',
        outcome: 'success' as const,
      }],
    },
    { role: 'user' as const, content: { kind: 'text' as const, text: 'second steer' } },
    { role: 'assistant' as const, content: { kind: 'text' as const, text: 'done' } },
  ];
  const malformed: readonly SessionRecord[] = [
    steeringRecord(
      '/tmp/workspace',
      id,
      steeringTranscript().slice(0, 3).concat([
        steeringTranscript()[3],
      ]),
    ),
    steeringRecord('/tmp/workspace', id, steeringTranscript().slice(0, 3)),
    steeringRecord('/tmp/workspace', id, [...steeringTranscript(), {
      role: 'user',
      content: { kind: 'text', text: 'after final' },
    }]),
    steeringRecord('/tmp/workspace', id, secondStep),
    steeringRecord('/tmp/workspace', id, [
      steeringTranscript()[0],
      steeringTranscript()[1],
      steeringTranscript()[3],
      steeringTranscript()[2],
      steeringTranscript()[4],
    ]),
    steeringRecord('/tmp/workspace', id, steeringTranscript(), 3),
    steeringRecord('/tmp/workspace', id, [
      { role: 'user', content: { kind: 'text', text: 'bad\0text' } },
      steeringTranscript()[4],
    ]),
  ];
  for (const value of malformed) {
    assertEquals(validateSessionRecord(value), false);
    await expectStoreError(
      () => Promise.resolve().then(() => encodeSessionRecord(value)),
      'session_invalid',
    );
  }

  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-steering-invalid-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  const paths = await store.pathsPromise;
  await Deno.mkdir(`${paths.sessions}/${id}`, { recursive: true, mode: 0o700 });
  const invalidOnDisk = { ...malformed[3], workspaceRoot: workspace };
  await Deno.writeFile(
    `${paths.sessions}/${id}/session.json`,
    bytes(`${JSON.stringify(invalidOnDisk)}\n`),
  );
  await Deno.chmod(`${paths.sessions}/${id}/session.json`, 0o600);
  const listed = await store.list();
  assertEquals(listed.sessions, []);
  assertEquals(listed.skippedInvalid, 1);
  await expectStoreError(() => store.openExisting(id), 'session_invalid');
  await Deno.remove(root, { recursive: true });
});

Deno.test('Deno store commits, lists, opens, resumes, and rolls back a canonical steering record', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-steering-store-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  const handle = await store.allocate('default');
  const initial = {
    ...steeringRecord(workspace, handle.id),
    createdAt: '2026-08-27T00:00:01.000Z',
  } satisfies SessionRecord;
  const persistence = createSessionPersistence(handle, workspace, 'default');
  persistence.commit(initial.transcript, initial.nextTurn, initial.updatedAt);
  assertEquals(await store.read(handle.id), initial);
  assertEquals((await store.list()).sessions, [{
    id: handle.id,
    agent: 'default',
    createdAt: initial.createdAt,
    updatedAt: initial.updatedAt,
    turnCount: 1,
    messageCount: initial.transcript.length,
  }]);
  await persistence.close();

  const resumedHandle = await store.openExisting(handle.id);
  assertEquals(resumedHandle.record, initial);
  const resumedPersistence = createSessionPersistence(
    resumedHandle,
    workspace,
    'default',
    resumedHandle.record,
  );
  const requests: ModelRequest[] = [];
  const resumed = new AgentSession(
    {
      generate(request) {
        requests.push(request);
        return { kind: 'final' as const, text: 'finished second' };
      },
    },
    new Registry([]),
    {
      initialRecord: resumedHandle.record,
      persistence: resumedPersistence,
    },
  );
  const outcome = await resumed.submit('second');
  assert(outcome.ok);
  assertEquals(requests[0].transcript.at(-1), {
    role: 'user',
    content: { kind: 'text', text: 'second' },
  });
  const committed = await store.read(handle.id);
  assertEquals(committed.nextTurn, 3);
  assertEquals(metadataFromRecord(committed).turnCount, 2);
  assertEquals(committed.transcript.slice(0, initial.transcript.length), initial.transcript);
  await resumed.close();

  const rollbackHandle = await store.openExisting(handle.id);
  const rollbackPersistence = createSessionPersistence(
    rollbackHandle,
    workspace,
    'default',
    rollbackHandle.record,
  );
  const extended = {
    ...committed,
    nextTurn: 4,
    updatedAt: '2026-08-29T00:00:02.000Z',
    transcript: [
      ...committed.transcript,
      { role: 'user' as const, content: { kind: 'text' as const, text: 'rollback turn' } },
      { role: 'assistant' as const, content: { kind: 'text' as const, text: 'rollback answer' } },
    ],
  } satisfies SessionRecord;
  rollbackPersistence.commit(extended.transcript, extended.nextTurn, extended.updatedAt);
  assertEquals(await store.read(handle.id), extended);
  rollbackPersistence.rollback();
  assertEquals(await store.read(handle.id), committed);
  await rollbackPersistence.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('AgentSession compaction installs a sibling checkpoint and resumes with canonical history intact', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-compaction-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace, { sourceProfileId: 'profile-v1' });
  const handle = await store.allocate('default');
  const initial: SessionRecord = {
    ...record(workspace),
    sessionId: handle.id,
    nextTurn: 7,
    transcript: largeContextTranscript(),
  };
  const persistence = createSessionPersistence(handle, workspace, 'default');
  persistence.commit(initial.transcript, initial.nextTurn, initial.updatedAt);
  const before = await store.read(handle.id);
  const summaryRequests: ModelRequest[] = [];
  const model = {
    generate(request: ModelRequest) {
      summaryRequests.push(request);
      return { kind: 'final' as const, text: '{"schemaVersion":1,"summary":"first-turn summary"}' };
    },
  };
  const session = new AgentSession(model, new Registry([]), {
    agent: 'default',
    initialRecord: initial,
    persistence,
    sourceProfileId: 'profile-v1',
    summarizeContext: (request) => {
      summaryRequests.push(request);
      return { kind: 'final' as const, text: '{"schemaVersion":1,"summary":"first-turn summary"}' };
    },
  });
  assert(session.contextCompactionPreview().useful);
  const compacted = await session.compactContext();
  assertEquals(compacted.kind, 'installed');
  assertEquals(compacted.coveredThroughTurn, 4);
  assertEquals(await store.read(handle.id), before);
  const checkpoint = await store.readCheckpoint(handle.id);
  assert(checkpoint !== undefined);
  assertEquals(checkpoint.sourceProfileId, 'profile-v1');
  assertEquals(checkpoint.coveredThroughTurn, 4);
  assertEquals(session.currentPosition().checkpoint?.retainedFromTurn, 5);
  assertEquals(summaryRequests.length, 1);
  await session.close();

  const reopened = await store.openExisting(handle.id);
  const resumedRequests: ModelRequest[] = [];
  const resumedPersistence = createSessionPersistence(
    reopened,
    workspace,
    'default',
    reopened.record,
  );
  const resumed = new AgentSession(
    {
      generate(request) {
        resumedRequests.push(request);
        return { kind: 'final' as const, text: 'resumed' };
      },
    },
    new Registry([]),
    {
      agent: 'default',
      initialRecord: reopened.record,
      persistence: resumedPersistence,
      sourceProfileId: 'profile-v1',
    },
  );
  const next = await resumed.submit('third goal');
  assert(next.ok);
  assertEquals(resumedRequests.length, 1);
  const projected = resumedRequests[0].transcript;
  assertEquals(projected[0], {
    role: 'user',
    content: {
      kind: 'text',
      text:
        '[henji-context-checkpoint:v1]\ncovered-through-turn: 4\nretained-from-turn: 5\nsummary:\nfirst-turn summary',
    },
  });
  assert(!JSON.stringify(projected).includes('first decision'));
  const after = await store.read(handle.id);
  assertEquals(after.transcript.slice(0, initial.transcript.length), initial.transcript);
  assertEquals(after.nextTurn, 8);
  assertEquals((await store.readCheckpoint(handle.id))?.summary, 'first-turn summary');
  await resumed.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('AgentSession marks itself unavailable when summary cancellation cleanup fails', async () => {
  const store = new FakeSessionStore('/workspace');
  const handle = await store.allocate('default');
  const initial: SessionRecord = {
    ...record('/workspace'),
    sessionId: handle.id,
    nextTurn: 7,
    transcript: largeContextTranscript(),
  };
  const persistence = createSessionPersistence(handle, '/workspace', 'default');
  persistence.commit(initial.transcript, initial.nextTurn, initial.updatedAt);
  const session = new AgentSession(
    { generate: () => ({ kind: 'final' as const, text: 'unused' }) },
    new Registry([]),
    {
      initialRecord: initial,
      persistence,
      sourceProfileId: 'profile-v1',
      summarizeContext: () => {
        throw new CancellationCleanupError();
      },
    },
  );
  assert(session.contextCompactionPreview().useful);
  let cleanupFailed = false;
  try {
    await session.compactContext();
  } catch (error) {
    cleanupFailed = error instanceof CancellationCleanupError;
  }
  assert(cleanupFailed);
  assertEquals(session.isAvailable(), false);
  let unavailable = false;
  try {
    await session.submit('must not reuse');
  } catch (error) {
    unavailable = error instanceof Error && error.message === AGENT_SESSION_UNAVAILABLE;
  }
  assert(unavailable);
  await session.close();
});

Deno.test('session identity projection, root precedence and bounded display are deterministic', async () => {
  assertEquals(
    selectStateRoot({ XDG_STATE_HOME: '/one', HOME: '/two' }),
    '/one/henji-harness',
  );
  assertEquals(
    selectStateRoot({ XDG_STATE_HOME: '', HOME: '/two' }),
    '/two/.local/state/henji-harness',
  );
  assertEquals(
    selectStateRoot({ XDG_STATE_HOME: '   ', HOME: '/two' }),
    '/two/.local/state/henji-harness',
  );
  const spacedRoot = '/tmp/ state with spaces ';
  assertEquals(
    selectStateRoot({ XDG_STATE_HOME: spacedRoot, HOME: '/two' }),
    `${spacedRoot}/henji-harness`,
  );
  let rejected = false;
  try {
    selectStateRoot({ XDG_STATE_HOME: 'relative', HOME: '/two' });
  } catch (error) {
    rejected = error instanceof SessionStoreError;
  }
  assert(rejected);
  assertEquals((await workspaceDigest('/tmp/workspace')).length, 64);
  assertEquals(metadataFromRecord(record()), {
    id,
    agent: 'default',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:01.000Z',
    turnCount: 1,
    messageCount: 2,
  });
  const long = 'x'.repeat(MAX_RESTORED_DISPLAY_BYTES + 1);
  const restored = restoredMessages([
    transcript[0],
    {
      role: 'assistant' as const,
      content: { kind: 'text' as const, text: long },
    },
  ]);
  assertEquals(restored.messages.length, 0);
  assertEquals(restored.omitted, 2);

  const sizedMessage = (text: string) => ({
    role: 'user' as const,
    content: { kind: 'text' as const, text },
  });
  const newest = sizedMessage('tail');
  const emptyMessageBytes = new TextEncoder().encode(JSON.stringify(sizedMessage(''))).byteLength;
  const newestBytes = new TextEncoder().encode(JSON.stringify(newest)).byteLength;
  const first = sizedMessage(
    'x'.repeat(MAX_RESTORED_DISPLAY_BYTES - newestBytes - emptyMessageBytes),
  );
  const exact = restoredMessages([sizedMessage('older'), first, newest]);
  assertEquals(exact.messages, [first, newest]);
  assertEquals(exact.omitted, 1);
});

Deno.test('invalid calendar timestamps are rejected by codec, list, and resume', async () => {
  const invalidId = '22222222-2222-4222-8222-222222222222';
  const invalid = {
    ...record('/tmp/workspace'),
    sessionId: invalidId,
    createdAt: '2026-99-99T00:00:00.000Z',
  };
  await expectStoreError(
    () => Promise.resolve().then(() => decodeSessionRecord(bytes(`${JSON.stringify(invalid)}\n`))),
    'session_invalid',
  );

  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-date-',
  });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  const paths = await store.pathsPromise;
  await Deno.mkdir(paths.sessions, { recursive: true, mode: 0o700 });
  await Deno.mkdir(paths.locks, { recursive: true, mode: 0o700 });
  await Deno.mkdir(`${paths.sessions}/${invalidId}`, { mode: 0o700 });
  const invalidPath = `${paths.sessions}/${invalidId}/session.json`;
  await Deno.writeFile(
    invalidPath,
    bytes(`${JSON.stringify({ ...invalid, workspaceRoot: workspace })}\n`),
  );
  await Deno.chmod(invalidPath, 0o600);
  const listed = await store.list();
  assertEquals(listed.sessions, []);
  assertEquals(listed.skippedInvalid, 1);
  await expectStoreError(
    () => store.openExisting(invalidId),
    'session_invalid',
  );
  await Deno.remove(root, { recursive: true });
});

Deno.test('session file lstat enforces zero, exact, and over-limit byte boundaries', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-file-boundary-',
  });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  await store.list();
  const paths = await store.pathsPromise;
  const exactId = '33333333-3333-4333-8333-333333333333';
  const zeroId = '44444444-4444-4444-8444-444444444444';
  const oversizedId = '55555555-5555-4555-8555-555555555555';
  const writeSessionFile = async (
    sessionId: string,
    content: Uint8Array,
  ): Promise<void> => {
    const directory = `${paths.sessions}/${sessionId}`;
    await Deno.mkdir(directory, { mode: 0o700 });
    const path = `${directory}/session.json`;
    await Deno.writeFile(path, content);
    await Deno.chmod(path, 0o600);
  };

  const emptySize = encodeSessionRecord(sizedRecord(exactId, workspace, '')).byteLength;
  let lower = 0;
  let upper = MAX_SESSION_FILE_BYTES;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    let size = MAX_SESSION_FILE_BYTES + 1;
    try {
      size = encodeSessionRecord(
        sizedRecord(exactId, workspace, 'x'.repeat(candidate)),
      ).byteLength;
    } catch (error) {
      assert(
        error instanceof SessionStoreError && error.code === 'session_limit',
      );
    }
    if (size <= MAX_SESSION_FILE_BYTES) lower = candidate;
    else upper = candidate - 1;
  }
  const exactBytes = encodeSessionRecord(
    sizedRecord(exactId, workspace, 'x'.repeat(lower)),
  );
  assertEquals(exactBytes.byteLength, MAX_SESSION_FILE_BYTES);
  assert(emptySize < MAX_SESSION_FILE_BYTES);
  await writeSessionFile(exactId, exactBytes);
  assertEquals((await store.read(exactId)).sessionId, exactId);

  await writeSessionFile(zeroId, new Uint8Array());
  await expectStoreError(() => store.read(zeroId), 'session_invalid');
  await writeSessionFile(
    oversizedId,
    new Uint8Array(MAX_SESSION_FILE_BYTES + 1),
  );
  await expectStoreError(() => store.read(oversizedId), 'session_invalid');
  await Deno.remove(root, { recursive: true });
});

Deno.test('Deno store reserves without an empty JSON, commits atomically, rolls back and deletes', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-store-',
  });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  const handle = await store.allocate('default');
  let activeDeleteRejected = false;
  try {
    await store.delete(handle.id);
  } catch (error) {
    activeDeleteRejected = error instanceof SessionStoreError &&
      error.code === 'session_busy';
  }
  assert(activeDeleteRejected);
  const secondReservation = await store.allocate('default');
  assert(handle.id !== secondReservation.id);
  const paths = await store.pathsPromise;
  assertEquals(
    [...Deno.readDirSync(`${paths.sessions}/${handle.id}`)].map((entry) => entry.name),
    [],
  );
  const persistence = createSessionPersistence(handle, workspace, 'default');
  const committed: SessionRecord = {
    ...record(workspace),
    sessionId: handle.id,
    createdAt: '2026-08-27T00:00:01.000Z',
  };
  persistence.commit(
    committed.transcript,
    committed.nextTurn,
    committed.updatedAt,
  );
  const loaded = await store.read(handle.id);
  assertEquals(loaded, committed);
  persistence.rollback();
  let missing = false;
  try {
    await store.read(handle.id);
  } catch (error) {
    missing = error instanceof SessionStoreError &&
      error.code === 'session_not_found';
  }
  assert(missing);
  const listed = await store.list();
  assertEquals(listed.sessions.length, 0);
  assertEquals(listed.skippedInvalid, 0);
  const orphanId = '22222222-2222-4222-8222-222222222222';
  await Deno.mkdir(`${paths.sessions}/${orphanId}`, { mode: 0o700 });
  const replacement = await store.allocate('default');
  let orphanGone = false;
  try {
    await Deno.lstat(`${paths.sessions}/${orphanId}`);
  } catch (error) {
    orphanGone = error instanceof Deno.errors.NotFound;
  }
  assert(orphanGone);
  await replacement.close();
  await persistence.close();
  await secondReservation.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('Deno store validates profiles, cleans bounded orphan contexts, and counts malformed companions', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-context-index-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace, { sourceProfileId: 'selected-profile' });
  const handle = await store.allocate('default');
  const twoTurns: SessionRecord = {
    ...record(workspace),
    sessionId: handle.id,
    nextTurn: 3,
    transcript: [
      { role: 'user', content: { kind: 'text', text: 'one' } },
      { role: 'assistant', content: { kind: 'text', text: 'answer one' } },
      { role: 'user', content: { kind: 'text', text: 'two' } },
      { role: 'assistant', content: { kind: 'text', text: 'answer two' } },
    ],
  };
  const persistence = createSessionPersistence(handle, workspace, 'default');
  persistence.commit(twoTurns.transcript, twoTurns.nextTurn, twoTurns.updatedAt);
  const checkpoint = {
    contextSchemaVersion: 1 as const,
    sessionId: handle.id,
    createdAt: '2026-08-30T00:00:00.000Z',
    sourceProfileId: 'selected-profile',
    coveredThroughTurn: 1,
    retainedFromTurn: 2,
    summary: 'safe summary',
  };
  persistence.installCheckpoint(checkpoint);
  await persistence.close();
  assertEquals((await store.readCheckpoint(handle.id))?.sourceProfileId, 'selected-profile');
  const paths = await store.pathsPromise;
  const checkpointPath = `${paths.contexts}/${handle.id}.json`;
  await Deno.chmod(checkpointPath, 0o640);
  await expectStoreError(() => store.readCheckpoint(handle.id), 'session_invalid');
  const permissionListed = await store.list();
  assertEquals(permissionListed.sessions.length, 0);
  assertEquals(permissionListed.skippedInvalid, 1);
  await Deno.chmod(checkpointPath, 0o600);
  const orphanId = '77777777-7777-4777-8777-777777777777';
  const orphan = { ...checkpoint, sessionId: orphanId };
  await Deno.writeFile(
    `${paths.contexts}/${orphanId}.json`,
    encodeSemanticContextCheckpoint(orphan),
    { mode: 0o600 },
  );
  await Deno.writeFile(
    `${paths.contexts}/malformed.json`,
    bytes('{"not":"a checkpoint"}\n'),
    { mode: 0o600 },
  );
  const wrongProfile = { ...checkpoint, sourceProfileId: 'other-profile' };
  await Deno.writeFile(
    `${paths.contexts}/${handle.id}.json`,
    encodeSemanticContextCheckpoint(wrongProfile),
    { mode: 0o600 },
  );
  const listed = await store.list();
  assertEquals(listed.sessions.length, 0);
  assertEquals(listed.skippedInvalid, 2);
  let orphanRemoved = false;
  try {
    await Deno.lstat(`${paths.contexts}/${orphanId}.json`);
  } catch (error) {
    orphanRemoved = error instanceof Deno.errors.NotFound;
  }
  assert(orphanRemoved);
  await expectStoreError(() => store.openExisting(handle.id), 'session_invalid');
  await Deno.remove(root, { recursive: true });
});

Deno.test('Deno store bounds the context companion namespace at the shared scan ceiling', async () => {
  const root = await Deno.makeTempDir({ dir: '/tmp', prefix: 'henji-session-context-scan-' });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  await store.list();
  const paths = await store.pathsPromise;
  for (let index = 0; index < MAX_WORKSPACE_DIRECTORY_ENTRIES + 1; index += 1) {
    await Deno.writeFile(`${paths.contexts}/invalid-${index}.json`, bytes('{}\n'), { mode: 0o600 });
  }
  await expectStoreError(() => store.list(), 'session_limit');
  await Deno.remove(root, { recursive: true });
});

Deno.test('first-turn rollback propagates a non-NotFound remove failure and leaves ghost JSON', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-rollback-',
  });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(state, workspace);
  const handle = await store.allocate('default');
  const persistence = createSessionPersistence(handle, workspace, 'default');
  persistence.commit(transcript, 2, '2026-08-27T00:00:01.000Z');
  const paths = await store.pathsPromise;
  const sessionFile = `${paths.sessions}/${handle.id}/session.json`;
  await Deno.remove(sessionFile);
  await Deno.mkdir(sessionFile, { mode: 0o700 });
  await Deno.writeTextFile(`${sessionFile}/ghost`, 'preserve');
  await expectStoreError(
    () => Promise.resolve().then(() => persistence.rollback()),
    'session_io_failure',
  );
  assert((await Deno.lstat(sessionFile)).isDirectory);
  await persistence.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('AgentSession poisons after first durable install rollback failure and preserves ghost JSON', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-agent-rollback-',
  });
  const workspace = `${root}/workspace`;
  const state = `${root}/state`;
  await Deno.mkdir(workspace);
  let removeAttempted = false;
  const store = new DenoSessionStore(state, workspace, {
    removeSync: () => {
      removeAttempted = true;
      throw new Error('injected remove failure');
    },
  });
  const handle = await store.allocate('default');
  const persistence = createSessionPersistence(handle, workspace, 'default');
  const session = new AgentSession(
    {
      generate(request: ModelRequest) {
        const task = request.transcript.at(-1);
        return {
          kind: 'final' as const,
          text: task?.role === 'user' ? `answer:${task.content.text}` : 'answer',
        };
      },
    },
    new Registry([]),
    {
      persistence,
      eventSink(event) {
        if (event.kind === 'turn_end') {
          throw new Error('injected turn_end failure');
        }
      },
    },
  );
  let firstFailed = false;
  try {
    await session.submit('first');
  } catch (error) {
    firstFailed = error instanceof Error &&
      error.message === EVENT_DELIVERY_ERROR;
  }
  assert(firstFailed);
  assert(removeAttempted);
  const ghost = await store.read(handle.id);
  assertEquals(ghost.transcript, [
    { role: 'user', content: { kind: 'text', text: 'first' } },
    { role: 'assistant', content: { kind: 'text', text: 'answer:first' } },
  ]);
  let unavailable = false;
  try {
    await session.submit('second');
  } catch (error) {
    unavailable = error instanceof Error &&
      error.message === AGENT_SESSION_UNAVAILABLE;
  }
  assert(unavailable);
  await session.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('same-session lock rejects a second opener and releases after close', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-lock-',
  });
  const workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  const store = new DenoSessionStore(`${root}/state`, workspace);
  const first = await store.allocate('default');
  const persistence = createSessionPersistence(first, workspace, 'default');
  persistence.commit(transcript, 2, '2026-08-27T00:00:01.000Z');
  await persistence.close();
  const second = await store.openExisting(first.id);
  await second.close();
  await Deno.remove(root, { recursive: true });
});

Deno.test('every indexed operation bounds sessions and locks independently at 512 entries', async () => {
  const operations = ['list', 'allocate', 'resume', 'delete'] as const;
  const namespaces = ['sessions', 'locks'] as const;
  for (const operation of operations) {
    for (const namespace of namespaces) {
      for (
        const count of [
          MAX_WORKSPACE_DIRECTORY_ENTRIES - 1,
          MAX_WORKSPACE_DIRECTORY_ENTRIES,
          MAX_WORKSPACE_DIRECTORY_ENTRIES + 1,
        ]
      ) {
        const root = await Deno.makeTempDir({
          dir: '/tmp',
          prefix: 'henji-session-scan-',
        });
        const workspace = `${root}/workspace`;
        const state = `${root}/state`;
        await Deno.mkdir(workspace);
        const store = new DenoSessionStore(state, workspace);
        await store.list();
        const paths = await store.pathsPromise;
        const extras = namespace === 'locks' ? count - 1 : count;
        for (let index = 0; index < extras; index += 1) {
          if (namespace === 'sessions') {
            await Deno.mkdir(`${paths.sessions}/invalid-${index}`, {
              mode: 0o700,
            });
          } else {
            const path = `${paths.locks}/invalid-${index}`;
            await Deno.writeFile(path, new Uint8Array());
            await Deno.chmod(path, 0o600);
          }
        }
        const expected = count > MAX_WORKSPACE_DIRECTORY_ENTRIES ? 'session_limit' : undefined;
        if (operation === 'list') {
          if (expected === undefined) {
            const listed = await store.list();
            assertEquals(listed.sessions, []);
            assertEquals(
              listed.skippedInvalid,
              namespace === 'sessions' ? extras : 0,
            );
          } else await expectStoreError(() => store.list(), expected);
        } else if (operation === 'allocate') {
          if (count < MAX_WORKSPACE_DIRECTORY_ENTRIES) {
            const handle = await store.allocate('default');
            await handle.close();
          } else {
            await expectStoreError(
              () => store.allocate('default'),
              'session_limit',
            );
            assertEquals(
              [...Deno.readDirSync(
                namespace === 'sessions' ? paths.sessions : paths.locks,
              )].length,
              count,
            );
          }
        } else if (operation === 'resume') {
          if (expected === undefined) {
            await expectStoreError(
              () => store.openExisting('66666666-6666-4666-8666-666666666666'),
              'session_not_found',
            );
          } else {
            await expectStoreError(
              () => store.openExisting('66666666-6666-4666-8666-666666666666'),
              expected,
            );
          }
        } else if (expected === undefined) {
          await expectStoreError(
            () => store.delete('66666666-6666-4666-8666-666666666666'),
            'session_not_found',
          );
        } else {
          await expectStoreError(
            () => store.delete('66666666-6666-4666-8666-666666666666'),
            expected,
          );
        }
        await Deno.remove(root, { recursive: true });
      }
    }
  }
});

Deno.test('durable turn_end failure restores the exact prior record in the same session', async () => {
  const store = new FakeSessionStore('/workspace');
  const handle = await store.allocate('default');
  let rejectEnd = false;
  const events: AgentEvent[] = [];
  const session = new AgentSession(
    {
      generate(request: ModelRequest) {
        const task = request.transcript.at(-1);
        return {
          kind: 'final' as const,
          text: task?.role === 'user' ? `answer:${task.content.text}` : 'answer',
        };
      },
    },
    new Registry([]),
    {
      persistence: createSessionPersistence(handle, '/workspace', 'default'),
      eventSink(event) {
        events.push(event);
        if (rejectEnd && event.kind === 'turn_end') {
          throw new Error('toggle sink');
        }
      },
    },
  );
  const first = await session.submit('first');
  assert(first.ok);
  const before = await store.read(handle.id);
  const contextBefore = session.contextSnapshot();
  rejectEnd = true;
  let failed = false;
  try {
    await session.submit('second');
  } catch {
    failed = true;
  }
  assert(failed);
  assertEquals(await store.read(handle.id), before);
  assertEquals(session.transcriptSnapshot(), before.transcript);
  assertEquals(session.contextSnapshot(), contextBefore);
  await session.close();
});

Deno.test('persistent canonical transcript excludes live progress events', async () => {
  const store = new FakeSessionStore('/workspace');
  const progressHandle = await store.allocate('default');
  const plainHandle = await store.allocate('default');
  const model = {
    generate: (request: ModelRequest) =>
      request.transcript.length === 1
        ? {
          kind: 'tool_calls' as const,
          calls: [{
            callId: 'progress',
            name: 'progress',
            arguments: { value: 'x' },
          }],
        }
        : { kind: 'final' as const, text: 'done' },
  };
  const registry = new Registry([{
    name: 'progress',
    description: 'progress',
    inputSchema: {},
    execute(_arguments, context) {
      const report = context && 'reportProgress' in context ? context.reportProgress : undefined;
      report?.('live-only');
      return 'result';
    },
  }]);
  const run = async (
    handle: typeof progressHandle,
    eventSink?: (event: AgentEvent) => void,
  ) => {
    const session = new AgentSession(
      model,
      registry,
      {
        persistence: createSessionPersistence(handle, '/workspace', 'default'),
        ...(eventSink === undefined ? {} : { eventSink }),
      },
    );
    const result = await session.submit('persistent');
    assert(result.ok);
    await session.close();
    return { result, record: await store.read(handle.id) };
  };
  const events: AgentEvent[] = [];
  const withProgress = await run(progressHandle, (event) => events.push(event));
  const withoutProgress = await run(plainHandle);
  assert(events.some((event) => event.kind === 'tool_progress'));
  assertEquals(
    withProgress.result.transcript,
    withoutProgress.result.transcript,
  );
  assertEquals(withProgress.record.transcript, withProgress.result.transcript);
  assertEquals(
    withProgress.record.transcript,
    withoutProgress.record.transcript,
  );
  assertEquals(
    JSON.stringify(withProgress.record).includes('tool_progress'),
    false,
  );
  const fixedRecord = (value: SessionRecord): SessionRecord => ({
    ...value,
    sessionId: id,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:01.000Z',
  });
  assertEquals(
    Array.from(encodeSessionRecord(fixedRecord(withProgress.record))),
    Array.from(encodeSessionRecord(fixedRecord(withoutProgress.record))),
  );
  const restored = restoredMessages(withProgress.record.transcript);
  assertEquals(restored.messages, withProgress.record.transcript);
  assertEquals(restored.omitted, 0);
  const resumedHandle = await store.openExisting(progressHandle.id);
  assert(resumedHandle.record !== undefined);
  const replayEvents: AgentEvent[] = [];
  const replayRequests: ModelRequest[] = [];
  const resumed = new AgentSession(
    {
      generate(request) {
        replayRequests.push(request);
        return { kind: 'final' as const, text: 'resumed' };
      },
    },
    new Registry([]),
    {
      persistence: createSessionPersistence(
        resumedHandle,
        '/workspace',
        'default',
        resumedHandle.record,
      ),
      initialRecord: resumedHandle.record,
      eventSink: (event) => replayEvents.push(event),
    },
  );
  assertEquals(replayEvents, []);
  const resumedResult = await resumed.submit('resumed task');
  assert(resumedResult.ok);
  assertEquals(replayEvents.map((event) => event.kind), [
    'turn_start',
    'user_message',
    'assistant_message',
    'turn_end',
  ]);
  assertEquals(
    replayEvents.filter((event) => event.kind === 'tool_progress'),
    [],
  );
  assertEquals(replayRequests[0].transcript, [
    ...withProgress.record.transcript,
    { role: 'user', content: { kind: 'text', text: 'resumed task' } },
  ]);
  await resumed.close();
});

Deno.test('fake reservation accounting is bounded at 256 without writing empty records', async () => {
  const store = new FakeSessionStore('/workspace');
  const handles = [];
  for (let index = 0; index < MAX_VALID_SESSIONS_PER_WORKSPACE; index += 1) {
    handles.push(await store.allocate('default'));
  }
  let limited = false;
  try {
    await store.allocate('default');
  } catch (error) {
    limited = error instanceof SessionStoreError &&
      error.code === 'session_limit';
  }
  assert(limited);
  for (const handle of handles) await handle.close();
  assertEquals((await store.list()).sessions, []);
});

Deno.test('resume hydrates the complete parent transcript while preserving current startup context', async () => {
  const root = await Deno.makeTempDir({
    dir: '/tmp',
    prefix: 'henji-session-resume-',
  });
  const workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  const state = `${root}/state`;
  const response = (text: string): Response =>
    new Response(
      `data: ${
        JSON.stringify({
          id: 'offline-session-stream',
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: text },
            finish_reason: null,
          }],
        })
      }\n\n` +
        `data: ${
          JSON.stringify({
            id: 'offline-session-stream',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })
        }\n\n` +
        'data: [DONE]\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  const requests: Request[] = [];
  const fetcher: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(response(`answer-${requests.length}`));
  };
  const store = new DenoSessionStore(state, workspace);
  const firstHandle = await store.allocate('default');
  const firstPersistence = createSessionPersistence(
    firstHandle,
    workspace,
    'default',
  );
  const firstRuntime = await createRuntimeSession(
    () => {},
    { workspaceRoot: workspace, fetcher, credential: 'offline-dummy' },
    DEFAULT_AGENT_SELECTION,
    { persistence: firstPersistence },
  );
  await firstRuntime.session.submit('first task');
  await firstRuntime.session.close();
  const firstRecord = await store.read(firstHandle.id);
  assertEquals(firstRecord.transcript.length, 2);

  const resumedHandle = await store.openExisting(firstHandle.id);
  const resumedPersistence = createSessionPersistence(
    resumedHandle,
    workspace,
    'default',
    resumedHandle.record,
  );
  const resumedRuntime = await createRuntimeSession(
    () => {},
    { workspaceRoot: workspace, fetcher, credential: 'offline-dummy' },
    DEFAULT_AGENT_SELECTION,
    { persistence: resumedPersistence, initialRecord: resumedHandle.record },
  );
  const second = await resumedRuntime.session.submit('second task');
  assert(second.ok);
  const body = JSON.parse(await requests.at(-1)!.clone().text()) as {
    messages: readonly unknown[];
  };
  assertEquals(body.messages.length, 3);
  await resumedRuntime.session.close();
  await Deno.remove(root, { recursive: true });
});
