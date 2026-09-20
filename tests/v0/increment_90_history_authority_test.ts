import { DatabaseSync } from 'node:sqlite';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import {
  addHistoryLogicalCost,
  assertCompleteV5AuthorityInventory,
  emptyHistoryLogicalCost,
} from '../../v0/agent/history/history_authority.ts';
import {
  decodeExactBytePlan,
  encodeExactBytePlan,
  exactByteDigest,
  ExactBytePlanBuilder,
  materializeExactBytePlan,
  validatedExactByteObjectRef,
} from '../../v0/agent/history/exact_byte_plan.ts';
import {
  decodeHistoryLogicalRecord,
  encodeHistoryLogicalRecord,
  type HistoryLogicalRecord,
} from '../../v0/agent/history/history_record_codec.ts';
import { PersistentSequenceStore } from '../../v0/agent/history/persistent_sequence.ts';
import {
  decodeHistorySegment,
  encodeHistorySegment,
} from '../../v0/agent/history/history_segment_codec.ts';
import { benchmarkHistorySegments } from '../../v0/agent/history/history_storage_benchmark.ts';
import {
  measureV5History,
  measureV5HistoryOperation,
} from '../../v0/agent/history/v5_history_metrics.ts';
import {
  type HistoryV6FaultPhase,
  SqliteHistoryV6Store,
} from '../../v0/agent/history/sqlite_history_v6_store.ts';
import { IsolatedV6HistoryPipeline } from '../../v0/agent/history/v6_history_pipeline.ts';
import {
  OpenRouterAgentModel,
  type OpenRouterAgentProfile,
} from '../../v0/agent/provider/openrouter_model.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { OpenAIResponsesModel } from '../../v0/agent/provider/openai_responses_model.ts';
import {
  type ContextModelRequestDelta,
  contextOccurrenceDigest,
  type ContextOccurrenceInput,
  contextRevisionDigest,
} from '../../v0/agent/history/context_attribution.ts';
import {
  benchmarkV6RepeatedContext,
  benchmarkV6SessionLengthDelta,
  benchmarkV6UniquePayloadScaling,
} from '../../v0/agent/history/v6_history_capacity_benchmark.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
};

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const concatenate = (...values: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
};

const v6Record = (
  executionId: string,
  ordinal: number,
  options: {
    readonly kind?: HistoryLogicalRecord['kind'];
    readonly authority?: HistoryLogicalRecord['authority'];
    readonly objectRefs?: readonly string[];
    readonly byteRanges?: HistoryLogicalRecord['byteRanges'];
    readonly causes?: HistoryLogicalRecord['causes'];
  } = {},
): HistoryLogicalRecord => ({
  schemaVersion: 1,
  recordId: `${executionId}:record:${ordinal}`,
  executionId,
  ordinal,
  authority: options.authority ?? 'contemporaneous_interpretation',
  kind: options.kind ?? 'runtime_event',
  observedAt: `2026-09-20T00:00:${String(ordinal).padStart(2, '0')}.000Z`,
  payload: { ordinal, text: `record-${ordinal}` },
  objectRefs: options.objectRefs ?? [],
  byteRanges: options.byteRanges ?? [],
  causes: options.causes ?? [],
  attribution: [{ resourceKind: 'build', logicalIdentity: 'increment-90-test' }],
});

Deno.test('Increment 90 classifies every v5 application table and measures aggregates read-only', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i90-metrics-' });
  const workspace = `${root}/workspace`;
  await Deno.mkdir(workspace);
  const state = `${root}/state`;
  await new SqliteHistoryStore(state, workspace).initialize();
  const paths = await sessionPaths(state, workspace);
  const databasePath = `${paths.root}/history-v5.sqlite3`;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let tables: string[];
  try {
    tables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
  assertCompleteV5AuthorityInventory(tables);
  const report = await measureV5History(databasePath);
  assert(report.totalFileBytes >= report.files[0].bytes);
  assert(report.objects.some((entry) => entry.name === 'execution_observations'));
  assertEquals(report.requestBodyBytes, 0);
  const operation = await measureV5HistoryOperation(
    databasePath,
    () => Promise.resolve(emptyHistoryLogicalCost()),
    0,
  );
  assert(operation.peakTotalFileBytes >= operation.before.totalFileBytes);
  assertEquals(operation.logicalCost, emptyHistoryLogicalCost());
});

Deno.test('Increment 90 cost contract rejects negative counters and preserves named dimensions', () => {
  const cost = addHistoryLogicalCost(emptyHistoryLogicalCost(), {
    unreferencedInputBytes: 8,
    logicalRecords: 2,
    validatedFragmentRefs: 1,
    wireBytes: 13,
  });
  assertEquals(cost.unreferencedInputBytes, 8);
  assertEquals(cost.preexistingPayloadBytesDecoded, 0);
  let rejected = false;
  try {
    addHistoryLogicalCost(cost, { logicalRecords: -1 });
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test('Increment 90 exact-byte plan reconstructs adapter output without a post-hoc capture pass', async () => {
  const prefix = bytes('{"messages":[');
  const reusable = bytes('{"role":"system","content":"stable"}');
  const suffix = bytes(']}');
  const ref = validatedExactByteObjectRef(reusable);
  const builder = new ExactBytePlanBuilder(
    'openai-responses:http-body-v1',
    'synthetic-json-writer-v1',
  );
  builder.appendLiteral(prefix);
  builder.appendValidatedRef(ref, reusable);
  builder.appendLiteral(suffix);
  const { plan, metrics } = builder.finish();
  const emitted = concatenate(prefix, reusable, suffix);
  const decoded = decodeExactBytePlan(encodeExactBytePlan(plan));
  assertEquals(await materializeExactBytePlan(decoded, () => reusable), emitted);
  assertEquals(plan.digest, exactByteDigest(emitted));
  assertEquals(metrics, {
    wireBytes: emitted.byteLength,
    unreferencedInputBytes: prefix.byteLength + suffix.byteLength,
    validatedFragmentRefs: 1,
    capturePasses: 1,
    postHocFullBodyPasses: 0,
  });
});

Deno.test('Increment 90 typed interpretation record is canonical and lossless', () => {
  const record: HistoryLogicalRecord = {
    schemaVersion: 1,
    recordId: 'record:17',
    executionId: 'execution:1',
    ordinal: 17,
    authority: 'contemporaneous_interpretation',
    kind: 'parser_transition',
    observedAt: '2026-09-20T00:00:00.000Z',
    payload: { kind: 'event', detail: { delta: 'hello' } },
    objectRefs: [],
    byteRanges: [{ streamId: 'response:3', start: 41, end: 58 }],
    causes: [{ relation: 'interprets', recordId: 'transport:16' }],
    attribution: [{
      resourceKind: 'parser',
      logicalIdentity: 'openai-responses-sse',
      contentDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }],
  };
  const encoded = encodeHistoryLogicalRecord(record);
  const decoded = decodeHistoryLogicalRecord(encoded);
  assertEquals(decoded.payload, { detail: { delta: 'hello' }, kind: 'event' });
  assertEquals(decoded.byteRanges[0].start, 41);
  assertEquals(decoded.causes[0].recordId, 'transport:16');
  assertEquals(decoded.attribution[0].logicalIdentity, 'openai-responses-sse');
  assertEquals(encodeHistoryLogicalRecord(decoded), encoded);
});

Deno.test('Increment 90 persistent sequence edits from its root without replaying lineage', () => {
  const store = new PersistentSequenceStore();
  const original = Array.from({ length: 16_384 }, (_, index) => `occurrence:${index}`);
  const root = store.fromValues(original);
  const beforeNodes = store.nodeCount;
  const revision = store.splice(root, 8_000, 3, ['new:a', 'new:b']);
  const growth = store.nodeCount - beforeNodes;
  assertEquals(revision.parentRoot, root);
  assertEquals(store.materialize(revision.root), [
    ...original.slice(0, 8_000),
    'new:a',
    'new:b',
    ...original.slice(8_003),
  ]);
  assert(store.height(revision.root) < 32, `unexpected tree height ${store.height(revision.root)}`);
  assert(growth < 200, `splice copied ${growth} nodes`);
});

Deno.test('Increment 90 persistent sequence preserves arbitrary splice semantics', () => {
  const store = new PersistentSequenceStore();
  const expected = Array.from({ length: 256 }, (_, index) => `base:${index}`);
  let root = store.fromValues(expected);
  let state = 90;
  const random = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state;
  };
  for (let edit = 0; edit < 500; edit += 1) {
    const start = random() % (expected.length + 1);
    const deleted = Math.min(random() % 5, expected.length - start);
    const inserted = Array.from({ length: random() % 4 }, (_, index) => `edit:${edit}:${index}`);
    expected.splice(start, deleted, ...inserted);
    root = store.splice(root, start, deleted, inserted).root;
    assertEquals(store.materialize(root), expected);
    const logarithmicHeightBound = expected.length === 0
      ? 0
      : 2 * Math.ceil(Math.log2(expected.length + 1));
    assert(store.height(root) <= logarithmicHeightBound);
  }
});

Deno.test('Increment 90 separates segment logical and representation digests and records policy evidence', () => {
  const records = [
    bytes('same-prefix '.repeat(400)),
    bytes('same-prefix '.repeat(400)),
    bytes('tail'),
  ];
  const segment = encodeHistorySegment(records, 'gzip-6');
  assert(segment.logicalDigest !== segment.representationDigest);
  assertEquals(decodeHistorySegment(segment), records);

  const benchmark = benchmarkHistorySegments({
    turns: 200,
    repeatedPrefixBytes: 64_000,
    newFactBytesPerTurn: 256,
  }, [
    { maxUncompressedBytes: 16_384, maxRecords: 16, maxFlushLatencyMs: 5 },
    { maxUncompressedBytes: 65_536, maxRecords: 64, maxFlushLatencyMs: 20 },
  ], ['identity', 'gzip-1', 'gzip-6', 'gzip-9']);
  assertEquals(benchmark.results.length, 8);
  assertEquals(benchmark.logicalCost.logicalRecords, 200);
  assertEquals(benchmark.logicalCost.validatedFragmentRefs, 200);
  assertEquals(benchmark.sharedObjectBytes, 64_000);
  assert(
    benchmark.results.some((result) =>
      result.codec === 'gzip-6' && result.encodedBytes < benchmark.encodedAuthorityBytes
    ),
  );
  assert(
    benchmark.results.every((result) =>
      result.maxDetailDecodeBytes <= result.policy.maxUncompressedBytes + 1_024
    ),
  );
});

Deno.test('Increment 90 isolated v6 store atomically reads exact authority and adopts canonical state', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i90-v6-' });
  const path = `${root}/history-v6.sqlite3`;
  const store = new SqliteHistoryV6Store(path);
  const executionId = 'execution-v6-complete';
  const sessionId = 'session-v6-complete';
  store.beginExecution(executionId, sessionId, 1, 'generation-v6');

  const shared = bytes('{"role":"system","content":"stable exact bytes"}');
  const ref = validatedExactByteObjectRef(shared);
  const prefix = bytes('{"input":[');
  const suffix = bytes(']}');
  const builder = new ExactBytePlanBuilder('provider-adapter:http-body-v1', 'writer-v1');
  builder.appendLiteral(prefix);
  builder.appendValidatedRef(ref, shared);
  builder.appendLiteral(suffix);
  const { plan } = builder.finish();
  const streamId = 'stream-v6-request-1';

  const sequence = new PersistentSequenceStore();
  const sequenceRoot = sequence.fromValues(['occurrence:system', 'occurrence:user']);
  const records = [
    v6Record(executionId, 1, {
      kind: 'transport_request',
      authority: 'transport_observation',
      objectRefs: [ref.digest],
      byteRanges: [{ streamId, start: 0, end: plan.byteLength }],
    }),
    v6Record(executionId, 2, {
      kind: 'parser_transition',
      causes: [{ relation: 'interprets', recordId: `${executionId}:record:1` }],
    }),
    v6Record(executionId, 3, {
      kind: 'execution_decision',
      authority: 'host_decision',
      causes: [{ relation: 'settles', recordId: `${executionId}:record:2` }],
    }),
  ];
  const receipt = store.append({
    executionId,
    expectedLatestOrdinal: 0,
    objects: [{ bytes: shared, logicalDigest: ref.digest }],
    byteStreams: [{ streamId, plan }],
    sequenceRevisions: [{
      revisionId: 'request-sequence-1',
      root: sequenceRoot,
      parentRoot: null,
      itemCount: 2,
      nodes: sequence.exportNodes(sequenceRoot),
    }],
    records,
    terminalRecordId: records[2].recordId,
    projections: [{
      projectionKind: 'human_summary',
      projectionKey: 'execution',
      sourceThroughOrdinal: 3,
      text: 'three durable records',
    }],
    searchDocuments: [{ recordId: records[1].recordId, text: 'parser transition record' }],
  });
  assertEquals(receipt.latestOrdinal, 3);
  assertEquals(receipt.unresolvedReferenceCount, 0);
  assertEquals(receipt.cost.preexistingPayloadBytesDecoded, 0);
  assertEquals(store.listRecordMetadata(executionId).map((record) => record.ordinal), [1, 2, 3]);
  assertEquals(
    encodeHistoryLogicalRecord(store.readRecord(records[1].recordId)),
    encodeHistoryLogicalRecord(records[1]),
  );
  assertEquals(
    await store.readByteStream(streamId),
    concatenate(prefix, shared, suffix),
  );
  assertEquals(store.readSequence('request-sequence-1', executionId), [
    'occurrence:system',
    'occurrence:user',
  ]);
  const settled = store.settleExecution(executionId, {
    latestOrdinal: receipt.latestOrdinal,
    recordCount: receipt.recordCount,
    orderedRoot: receipt.orderedRoot,
    terminalRecordId: records[2].recordId,
  }, 'completed');
  assertEquals(settled.lifecycle, 'settled');
  assertEquals(store.adoptExecution(executionId, 1), 2);
  assertEquals(store.readLedger(executionId).adoption, 'canonical');

  const secondExecution = 'execution-v6-shared-object';
  const secondStream = 'stream-v6-request-2';
  store.beginExecution(secondExecution, 'session-v6-shared-object', 1, 'generation-v6');
  store.append({
    executionId: secondExecution,
    expectedLatestOrdinal: 0,
    byteStreams: [{ streamId: secondStream, plan }],
    records: [v6Record(secondExecution, 1, {
      kind: 'transport_request',
      authority: 'transport_observation',
      objectRefs: [ref.digest],
      byteRanges: [{ streamId: secondStream, start: 0, end: plan.byteLength }],
    })],
  });
  assertEquals(await store.readByteStream(secondStream), concatenate(prefix, shared, suffix));
  store.close();

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const object = db.prepare(`
      SELECT logical_digest, representation_digest FROM exact_objects
    `).get() as { logical_digest: string; representation_digest: string };
    assert(object.logical_digest !== object.representation_digest);
    assertEquals(
      Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
      6,
    );
    assertEquals(
      Number(
        (db.prepare('SELECT COUNT(*) AS count FROM canonical_turns').get() as { count: number })
          .count,
      ),
      1,
    );
    assertEquals(
      Number(
        (db.prepare('SELECT COUNT(*) AS count FROM exact_objects').get() as { count: number })
          .count,
      ),
      1,
    );
    assertEquals(
      Number(
        (db.prepare('SELECT COUNT(*) AS count FROM record_search').get() as { count: number })
          .count,
      ),
      1,
    );
  } finally {
    db.close();
  }
});

Deno.test('Increment 90 v6 settlement rejects unresolved causes and resolves them incrementally', () => {
  const root = Deno.makeTempDirSync({ prefix: 'henji-i90-v6-ref-' });
  const store = new SqliteHistoryV6Store(`${root}/history-v6.sqlite3`);
  const executionId = 'execution-v6-references';
  store.beginExecution(executionId, 'session-v6-references', 1, 'generation-v6');
  const first = v6Record(executionId, 1, {
    causes: [{ relation: 'future', recordId: `${executionId}:record:2` }],
  });
  const firstReceipt = store.append({ executionId, expectedLatestOrdinal: 0, records: [first] });
  assertEquals(firstReceipt.unresolvedReferenceCount, 1);
  let rejected = false;
  try {
    store.settleExecution(executionId, {
      latestOrdinal: 1,
      recordCount: 1,
      orderedRoot: firstReceipt.orderedRoot,
      terminalRecordId: first.recordId,
    }, 'completed');
  } catch {
    rejected = true;
  }
  assert(rejected, 'settlement accepted an unresolved causal reference');
  const terminal = v6Record(executionId, 2, {
    kind: 'execution_decision',
    authority: 'host_decision',
  });
  const secondReceipt = store.append({
    executionId,
    expectedLatestOrdinal: 1,
    records: [terminal],
    terminalRecordId: terminal.recordId,
  });
  assertEquals(secondReceipt.unresolvedReferenceCount, 0);
  let postTerminalRejected = false;
  try {
    store.append({
      executionId,
      expectedLatestOrdinal: 2,
      records: [v6Record(executionId, 3)],
    });
  } catch {
    postTerminalRejected = true;
  }
  assert(postTerminalRejected, 'append after terminal record was accepted');
  assertEquals(
    store.settleExecution(executionId, {
      latestOrdinal: 2,
      recordCount: 2,
      orderedRoot: secondReceipt.orderedRoot,
      terminalRecordId: terminal.recordId,
    }, 'completed').lifecycle,
    'settled',
  );
  store.close();
});

Deno.test('Increment 90 v6 crash points expose only the last committed ordinal prefix', () => {
  const phases: readonly HistoryV6FaultPhase[] = [
    'before_transaction',
    'after_objects',
    'after_segments',
    'after_catalog',
    'before_commit',
    'after_commit',
  ];
  for (const phase of phases) {
    const root = Deno.makeTempDirSync({ prefix: `henji-i90-v6-${phase}-` });
    const path = `${root}/history-v6.sqlite3`;
    let armed = false;
    const store = new SqliteHistoryV6Store(path, {
      fault: (current) => {
        if (armed && current === phase) throw new Error(`injected:${phase}`);
      },
    });
    const executionId = `execution-${phase}`;
    store.beginExecution(executionId, `session-${phase}`, 1, 'generation-v6');
    store.append({ executionId, expectedLatestOrdinal: 0, records: [v6Record(executionId, 1)] });
    const objectBytes = bytes(`crash-object:${phase}`);
    const objectRef = validatedExactByteObjectRef(objectBytes);
    const streamBuilder = new ExactBytePlanBuilder('crash-test:http-body-v1', 'writer-v1');
    streamBuilder.appendValidatedRef(objectRef, objectBytes);
    const crashPlan = streamBuilder.finish().plan;
    const crashStream = `stream-${phase}`;
    armed = true;
    let failed = false;
    try {
      store.append({
        executionId,
        expectedLatestOrdinal: 1,
        objects: [{ bytes: objectBytes, logicalDigest: objectRef.digest }],
        byteStreams: [{ streamId: crashStream, plan: crashPlan }],
        records: [v6Record(executionId, 2, {
          kind: 'transport_request',
          authority: 'transport_observation',
          objectRefs: [objectRef.digest],
          byteRanges: [{ streamId: crashStream, start: 0, end: objectBytes.byteLength }],
        })],
      });
    } catch (error) {
      failed = String(error).includes(`injected:${phase}`);
    }
    assert(failed, `fault ${phase} did not fire`);
    store.close();

    const reopened = new SqliteHistoryV6Store(path);
    const expectedCount = phase === 'after_commit' ? 2 : 1;
    const ledger = reopened.readLedger(executionId);
    assertEquals(ledger.latestOrdinal, expectedCount);
    assertEquals(ledger.recordCount, expectedCount);
    assertEquals(reopened.listRecordMetadata(executionId).length, expectedCount);
    reopened.close();

    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const segments = Number(
        (db.prepare('SELECT COUNT(*) AS count FROM history_segments').get() as { count: number })
          .count,
      );
      const anchors = Number(
        (db.prepare('SELECT COUNT(*) AS count FROM record_anchors').get() as { count: number })
          .count,
      );
      const objects = Number(
        (db.prepare('SELECT COUNT(*) AS count FROM exact_objects').get() as { count: number })
          .count,
      );
      const streams = Number(
        (db.prepare('SELECT COUNT(*) AS count FROM byte_streams').get() as { count: number }).count,
      );
      assertEquals(segments, expectedCount);
      assertEquals(anchors, expectedCount);
      assertEquals(objects, phase === 'after_commit' ? 1 : 0);
      assertEquals(streams, phase === 'after_commit' ? 1 : 0);
    } finally {
      db.close();
    }
  }
});

Deno.test('Increment 90 isolated v6 store refuses an older schema instead of migrating it', () => {
  const root = Deno.makeTempDirSync({ prefix: 'henji-i90-v6-version-' });
  const path = `${root}/history-v6.sqlite3`;
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE legacy(value TEXT); PRAGMA user_version = 5;');
  legacy.close();
  let rejected = false;
  try {
    new SqliteHistoryV6Store(path);
  } catch (error) {
    rejected = String(error).includes('unsupported isolated history schema: 5');
  }
  assert(rejected, 'isolated v6 store accepted or migrated schema v5');
  const verify = new DatabaseSync(path, { readOnly: true });
  try {
    assertEquals(
      Number(
        (verify.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ),
      5,
    );
    assertEquals(
      Number(
        (verify.prepare('SELECT COUNT(*) AS count FROM legacy').get() as { count: number }).count,
      ),
      0,
    );
  } finally {
    verify.close();
  }
});

Deno.test('Increment 90 provider seam sends and retains one identical exact request byte object', async () => {
  const root = Deno.makeTempDirSync({ prefix: 'henji-i90-v6-pipeline-' });
  const store = new SqliteHistoryV6Store(`${root}/history-v6.sqlite3`);
  const executionId = 'execution-v6-provider-seam';
  store.beginExecution(executionId, 'session-v6-provider-seam', 1, 'generation-v6');
  const pipeline = new IsolatedV6HistoryPipeline(store, executionId, {
    now: () => '2026-09-20T12:00:00.000Z',
  });
  const recorder = new ProviderEvidenceRecorder(
    '90909090-9090-4090-8090-909090909090',
    1,
    '2026-09-20T12:00:00.000Z',
    undefined,
    pipeline.observeProviderObservation,
  );
  const profile: OpenRouterAgentProfile = {
    id: 'increment-90-exact-byte-test',
    model: 'test/exact-byte-model',
    origin: 'https://provider.invalid',
    path: '/chat/completions',
    method: 'POST',
    secretEnv: 'HENJI_INCREMENT_90_TEST_KEY',
    maxCompletionTokens: 128,
    stream: false,
  };
  const sse = `data: ${
    JSON.stringify({
      id: 'increment-90-stream',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'retained' },
        finish_reason: 'stop',
      }],
    })
  }\n\ndata: [DONE]\n\n`;
  let observedBytes: Uint8Array | undefined;
  let fetchedBytes: Uint8Array | undefined;
  const model = new OpenRouterAgentModel({
    profile,
    responseMode: 'sse',
    credential: 'test-credential-not-retained',
    fetcher: (_input, init) => {
      assert(init?.body instanceof Uint8Array, 'exact observer did not place bytes on fetch');
      fetchedBytes = init.body;
      return Promise.resolve(
        new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    },
  });
  const result = await model.generate({
    transcript: [{
      role: 'user',
      content: { kind: 'text', text: 'unique body text retained only as exact bytes' },
    }],
    tools: [],
  }, {
    providerEvidence: recorder,
    providerExactRequestObserver: (observation) => {
      observedBytes = observation.bytes;
      pipeline.observeExactRequest(observation);
    },
  });
  assertEquals(result, { kind: 'final', text: 'retained' });
  assert(observedBytes !== undefined);
  assert(fetchedBytes === observedBytes, 'fetch did not receive the observed Uint8Array instance');
  assertEquals(recorder.snapshot().requests[0].request.requestBody, '');
  assertEquals(recorder.snapshot().requests[0].request.requestBodyBytes, 0);
  pipeline.flush();

  const metadata = store.listRecordMetadata(executionId);
  assert(metadata.length >= 6, `only ${metadata.length} provider facts were retained`);
  const records = metadata.map((entry) => store.readRecord(entry.recordId));
  const requestRecord = records[0];
  assertEquals(requestRecord.kind, 'transport_request');
  assertEquals(requestRecord.objectRefs.length, 1);
  assert(
    !JSON.stringify(requestRecord.payload).includes('unique body text'),
    'logical request record duplicated the exact request body',
  );
  assertEquals(await store.readByteStream(requestRecord.byteRanges[0].streamId), observedBytes);
  assert(records.some((record) => record.kind === 'transport_response_chunk'));
  assert(records.some((record) => record.kind === 'sse_event'));
  assert(records.some((record) => record.kind === 'parser_transition'));
  assertEquals(pipeline.logicalCost.wireBytes, observedBytes.byteLength);
  assertEquals(pipeline.logicalCost.postHocFullBodyPasses, 0);
  assertEquals(pipeline.logicalCost.preexistingPayloadBytesDecoded, 0);
  assertEquals(pipeline.logicalCost.preexistingPayloadBytesRehashed, 0);
  assertEquals(pipeline.logicalCost.preexistingPayloadBytesReencoded, 0);
  assertEquals(pipeline.logicalCost.oldSegmentLogicalRewrites, 0);
  store.close();
});

Deno.test('Increment 92 replay keeps missing and reordered exact capture invalid', async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      new URL('./fixtures/increment_92/missing_aux_exact_capture.json', import.meta.url),
    ),
  ) as {
    root: { body: string; endpoint: string; modelStep: number };
    auxiliary: { endpoint: string; modelStep: number; contextRequestOrdinal: number };
  };
  for (const order of ['missing', 'reordered'] as const) {
    const root = Deno.makeTempDirSync({ prefix: `henji-i92-${order}-capture-` });
    const store = new SqliteHistoryV6Store(`${root}/history-v6.sqlite3`);
    try {
      const executionId = `execution-i92-${order}`;
      store.beginExecution(executionId, 'session-i92-capture', 1, 'generation-i92');
      const pipeline = new IsolatedV6HistoryPipeline(store, executionId);
      const recorder = new ProviderEvidenceRecorder(
        order === 'missing'
          ? '92000000-0000-4000-8000-000000000094'
          : '92000000-0000-4000-8000-000000000095',
        1,
        '2026-09-21T00:00:00.000Z',
        undefined,
        pipeline.observeProviderObservation,
      );
      const metadata = { provider: 'openrouter-chat' } as const;
      pipeline.observeExactRequest({
        bytes: bytes(fixture.root.body),
        captureBoundary: 'openrouter-chat:http-body-v1',
        serializerVersion: 'json-stringify-v1',
        endpoint: fixture.root.endpoint,
        method: 'POST',
        lane: 'parent',
        phase: 'user_turn',
        modelStep: fixture.root.modelStep,
        requestMetadata: metadata,
        monolithicFallback: true,
      });
      if (order === 'missing') {
        recorder.startRequestMetadata({
          lane: 'parent',
          phase: 'user_turn',
          modelStep: fixture.root.modelStep,
          endpoint: fixture.root.endpoint,
          method: 'POST',
          requestMetadata: metadata,
        });
      }
      let rejected = false;
      try {
        recorder.setContextRequestOrdinal(fixture.auxiliary.contextRequestOrdinal);
        recorder.startRequestMetadata({
          lane: 'parent',
          phase: 'user_turn',
          modelStep: fixture.auxiliary.modelStep,
          endpoint: fixture.auxiliary.endpoint,
          method: 'POST',
          requestMetadata: { origin: 'web_search' },
        });
      } catch (error) {
        rejected = String(error).includes(
          'provider request evidence does not match exact byte capture',
        );
      }
      assert(rejected, `${order} capture replay was accepted`);
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test('Increment 90 OpenAI Responses seam passes its observed SDK body bytes to fetch', async () => {
  const response = {
    id: 'resp_increment_90',
    object: 'response',
    created_at: 1_790_000_000,
    status: 'completed',
    model: 'gpt-test',
    output: [{
      id: 'msg_increment_90',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done', annotations: [], logprobs: [] }],
    }],
    output_text: 'done',
  };
  let observedBytes: Uint8Array | undefined;
  let fetchedBytes: Uint8Array | undefined;
  const model = new OpenAIResponsesModel({
    selection: {
      provider: 'openai-responses',
      api: 'openai-responses',
      authProfile: 'openai-api-key',
      modelId: 'gpt-test',
      effort: 'medium',
    },
    credentialSource: () => Promise.resolve('test-credential-not-retained'),
    fetcher: (_input, init) => {
      assert(init?.body instanceof Uint8Array, 'SDK body was not passed as exact bytes');
      fetchedBytes = init.body;
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    },
  });
  const result = await model.generate({
    transcript: [{ role: 'user', content: { kind: 'text', text: 'SDK exact body' } }],
    tools: [],
  }, {
    providerExactRequestObserver: (observation) => {
      observedBytes = observation.bytes;
    },
  });
  assertEquals(result.kind, 'final');
  assert(observedBytes !== undefined);
  assert(fetchedBytes === observedBytes, 'SDK fetch did not receive the observed byte instance');
  assert(new TextDecoder().decode(observedBytes).includes('SDK exact body'));
});

Deno.test('Increment 90 applies Increment 89 deltas from the current root without replaying history', async () => {
  const root = Deno.makeTempDirSync({ prefix: 'henji-i90-v6-context-' });
  const store = new SqliteHistoryV6Store(`${root}/history-v6.sqlite3`);
  const executionId = 'execution-v6-context-delta';
  store.beginExecution(executionId, 'session-v6-context-delta', 1, 'generation-v6');
  const pipeline = new IsolatedV6HistoryPipeline(store, executionId, {
    now: () => '2026-09-20T13:00:00.000Z',
  });
  const shared = bytes('shared context object');
  const sharedRef = validatedExactByteObjectRef(shared);
  const descriptor = {
    digest: sharedRef.digest,
    byteLength: sharedRef.byteLength,
    mediaType: 'text/plain; charset=utf-8' as const,
  };
  const occurrence = async (
    index: number,
    includeBytes: boolean,
  ): Promise<ContextOccurrenceInput> => {
    const value = {
      occurrenceId: `context-occurrence-${index}`,
      kind: 'message' as const,
      content: descriptor,
      sourceRelations: [],
    };
    return {
      ...value,
      occurrenceDigest: await contextOccurrenceDigest(value),
      ...(includeBytes ? { bytesBase64: shared.toBase64() } : {}),
    };
  };
  const initialOccurrences = await Promise.all(
    Array.from({ length: 256 }, (_, index) => occurrence(index, index === 0)),
  );
  const initialShape = {
    lane: 'parent' as const,
    purpose: 'user_turn' as const,
    resultItemCount: initialOccurrences.length,
    splices: [{
      start: 0,
      deleteCount: 0,
      insertions: initialOccurrences.map((item) => ({
        occurrenceId: item.occurrenceId,
        occurrenceDigest: item.occurrenceDigest,
      })),
    }],
  };
  const initial: ContextModelRequestDelta = {
    schemaVersion: 2,
    requestOrdinal: 1,
    modelStep: 1,
    ...initialShape,
    revisionDigest: await contextRevisionDigest(initialShape),
    occurrences: initialOccurrences,
  };
  await pipeline.observeContextDelta(initial);
  const firstCost = pipeline.logicalCost;

  const suffix = await occurrence(256, false);
  const suffixShape = {
    lane: 'parent' as const,
    purpose: 'user_turn' as const,
    baseRevisionDigest: initial.revisionDigest,
    resultItemCount: 257,
    splices: [{
      start: 256,
      deleteCount: 0,
      insertions: [{
        occurrenceId: suffix.occurrenceId,
        occurrenceDigest: suffix.occurrenceDigest,
      }],
    }],
  };
  const second: ContextModelRequestDelta = {
    schemaVersion: 2,
    requestOrdinal: 2,
    modelStep: 2,
    ...suffixShape,
    revisionDigest: await contextRevisionDigest(suffixShape),
    occurrences: [suffix],
  };
  await pipeline.observeContextDelta(second);
  const secondCost = pipeline.logicalCost;
  assertEquals(store.readSequence(initial.revisionDigest, executionId).length, 256);
  const current = store.readSequence(second.revisionDigest, executionId);
  assertEquals(current.length, 257);
  assertEquals(current.at(-1), suffix.occurrenceId);
  assert(
    secondCost.indexOperations - firstCost.indexOperations < 64,
    'suffix delta persisted the prior sequence again',
  );
  assertEquals(secondCost.preexistingPayloadBytesDecoded, 0);
  assertEquals(secondCost.preexistingPayloadBytesRehashed, 0);
  assertEquals(secondCost.preexistingPayloadBytesReencoded, 0);
  const initialRecord = store.readRecord(`${executionId}:record:1`);
  assert(!JSON.stringify(initialRecord.payload).includes('bytesBase64'));
  store.close();
});

Deno.test('Increment 90 v6 pipeline commits success failure and cancellation terminal facts', () => {
  const outcomes = ['final', 'contract_failure', 'cancelled'] as const;
  for (const [index, outcome] of outcomes.entries()) {
    const root = Deno.makeTempDirSync({ prefix: `henji-i90-v6-${outcome}-` });
    const store = new SqliteHistoryV6Store(`${root}/history-v6.sqlite3`);
    const executionId = `execution-v6-${outcome}`;
    store.beginExecution(executionId, `session-v6-${outcome}`, 1, 'generation-v6');
    const pipeline = new IsolatedV6HistoryPipeline(store, executionId, {
      now: () => `2026-09-20T14:00:0${index}.000Z`,
    });
    const recorder = new ProviderEvidenceRecorder(
      `91919191-9191-4191-8191-91919191919${index}`,
      1,
      '2026-09-20T14:00:00.000Z',
      undefined,
      pipeline.observeProviderObservation,
    );
    recorder.recordOutcome(outcome);
    const ledger = store.readLedger(executionId);
    assertEquals(ledger.latestOrdinal, 1);
    assertEquals(ledger.terminalRecordId, `${executionId}:record:1`);
    const terminal = store.readRecord(ledger.terminalRecordId!);
    assertEquals(terminal.authority, 'host_decision');
    assertEquals(terminal.kind, 'execution_decision');
    assertEquals(
      (terminal.payload as { event?: { outcome?: string } }).event?.outcome,
      outcome,
    );
    assertEquals(
      store.settleExecution(executionId, {
        latestOrdinal: ledger.latestOrdinal,
        recordCount: ledger.recordCount,
        orderedRoot: ledger.orderedRoot,
        terminalRecordId: ledger.terminalRecordId!,
      }, outcome === 'final' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed')
        .lifecycle,
      'settled',
    );
    store.close();
  }
});

Deno.test('Increment 90 v6 reads projects audits backs up and isolates corrupt segment impact', async () => {
  const root = Deno.makeTempDirSync({ prefix: 'henji-i90-v6-read-' });
  const path = `${root}/history-v6.sqlite3`;
  const backupPath = `${root}/history-v6.backup.sqlite3`;
  const store = new SqliteHistoryV6Store(path);
  const executionId = 'execution-v6-read-contract';
  store.beginExecution(executionId, 'session-v6-read-contract', 4, 'generation-v6');
  const exact = bytes('{"exact":"request"}');
  const ref = validatedExactByteObjectRef(exact);
  const builder = new ExactBytePlanBuilder('test:http-body-v1', 'test-writer-v1');
  builder.appendValidatedRef(ref, exact);
  const plan = builder.finish().plan;
  const streamId = 'execution-v6-read-contract:request-stream:1';
  const records = [
    v6Record(executionId, 1, {
      kind: 'transport_request',
      authority: 'transport_observation',
      objectRefs: [ref.digest],
      byteRanges: [{ streamId, start: 0, end: exact.byteLength }],
    }),
    v6Record(executionId, 2, {
      kind: 'parser_transition',
      causes: [{ relation: 'interprets', recordId: `${executionId}:record:1` }],
    }),
    v6Record(executionId, 3, {
      kind: 'execution_decision',
      authority: 'host_decision',
      causes: [{ relation: 'settles', recordId: `${executionId}:record:2` }],
    }),
  ];
  const receipt = store.append({
    executionId,
    expectedLatestOrdinal: 0,
    objects: [{ bytes: exact, validatedRef: ref }],
    byteStreams: [{ streamId, plan }],
    records,
    terminalRecordId: records[2].recordId,
    projections: [{
      projectionKind: 'human_history',
      projectionKey: 'turn-1',
      sourceThroughOrdinal: 3,
      text: 'projected history text',
    }],
    searchDocuments: [{
      recordId: records[1].recordId,
      text: 'parser transition searchable document',
    }],
  });

  const firstPage = store.pageRecordMetadata(executionId, { limit: 2 });
  assertEquals(firstPage.records.map((record) => record.ordinal), [1, 2]);
  assertEquals(firstPage.nextAfterOrdinal, 2);
  assertEquals(
    store.pageRecordMetadata(executionId, {
      afterOrdinal: firstPage.nextAfterOrdinal,
      limit: 2,
    }).records.map((record) => record.ordinal),
    [3],
  );
  assertEquals(
    store.pageRecordMetadata(executionId, { limit: 10, authority: 'host_decision' }).records.map(
      (record) => record.ordinal,
    ),
    [3],
  );
  assertEquals(
    store.searchRecords(executionId, 'parser searchable', 10)[0].recordId,
    records[1].recordId,
  );
  assertEquals(store.readProjection(executionId, 'human_history', 'turn-1'), {
    sourceThroughOrdinal: 3,
    text: 'projected history text',
  });
  const detail = await store.readRecordDetail(records[0].recordId);
  assertEquals(detail.objects[ref.digest], exact);
  assertEquals(detail.byteStreams[streamId], exact);
  const exported = [...store.exportNormalizedRecords(executionId)];
  assertEquals(exported.length, 3);
  assertEquals(
    exported.map((line) => JSON.parse(new TextDecoder().decode(line).trim()) as { ordinal: number })
      .map((record) => record.ordinal),
    [1, 2, 3],
  );
  const exactExport: { readonly kind: string; readonly bytes: Uint8Array }[] = [];
  for await (const entry of store.exportExactExecution(executionId)) exactExport.push(entry);
  assertEquals(
    exactExport.map((entry) => entry.kind),
    ['record', 'object', 'byte_stream', 'record', 'record'],
  );
  assertEquals(
    exactExport.find((entry) => entry.kind === 'byte_stream')?.bytes,
    exact,
  );
  assertEquals(await store.audit(), {
    integrity: 'ok',
    executions: 1,
    records: 3,
    segments: 1,
    exactObjects: 1,
    byteStreams: 1,
    sequenceRevisions: 0,
  });
  const backup = await store.backupTo(backupPath);
  assertEquals(backup.records, 3);
  assertEquals(SqliteHistoryV6Store.verifyBackup(backupPath).integrity, 'ok');

  const segmentId = firstPage.records[0].segmentId;
  const tamper = new DatabaseSync(path);
  tamper.prepare(`
    UPDATE history_segments SET encoded_bytes = ? WHERE segment_id = ?
  `).run(new Uint8Array([0]), segmentId);
  tamper.close();
  assertEquals(store.pageRecordMetadata(executionId, { limit: 10 }).records.length, 3);
  assertEquals(store.searchRecords(executionId, 'parser', 10).length, 1);
  const impact = store.identifySegmentImpact(segmentId);
  assertEquals(
    [impact.executionId, impact.firstOrdinal, impact.lastOrdinal, impact.recordCount],
    [executionId, 1, 3, 3],
  );
  let detailFailed = false;
  try {
    store.readRecord(records[0].recordId);
  } catch {
    detailFailed = true;
  }
  assert(detailFailed, 'corrupt segment remained readable');
  const settled = store.settleExecution(executionId, {
    latestOrdinal: receipt.latestOrdinal,
    recordCount: receipt.recordCount,
    orderedRoot: receipt.orderedRoot,
    terminalRecordId: records[2].recordId,
  }, 'completed');
  assertEquals(settled.lifecycle, 'settled');
  assertEquals(store.adoptExecution(executionId, 1), 5);
  let auditFailed = false;
  try {
    await store.audit();
  } catch {
    auditFailed = true;
  }
  assert(auditFailed, 'explicit audit accepted a corrupt segment');
  store.close();
});

Deno.test('Increment 90 restart reconciliation appends one terminal decision from the durable tail', () => {
  const root = Deno.makeTempDirSync({ prefix: 'henji-i90-v6-reconcile-' });
  const store = new SqliteHistoryV6Store(`${root}/history-v6.sqlite3`);
  const executionId = 'execution-v6-reconcile';
  store.beginExecution(executionId, 'session-v6-reconcile', 1, 'generation-v6');
  store.append({
    executionId,
    expectedLatestOrdinal: 0,
    records: [v6Record(executionId, 1)],
  });
  const resumed = new IsolatedV6HistoryPipeline(store, executionId, {
    now: () => '2026-09-20T15:00:00.000Z',
  });
  assertEquals(resumed.recordInterrupted('host restart'), 2);
  const terminal = store.readRecord(`${executionId}:record:2`);
  assertEquals(terminal.causes, [{ recordId: `${executionId}:record:1`, relation: 'follows' }]);
  const ledger = store.readLedger(executionId);
  assertEquals(ledger.terminalRecordId, terminal.recordId);
  assertEquals(
    store.settleExecution(executionId, {
      latestOrdinal: ledger.latestOrdinal,
      recordCount: ledger.recordCount,
      orderedRoot: ledger.orderedRoot,
      terminalRecordId: terminal.recordId,
    }, 'interrupted').outcome,
    'interrupted',
  );
  store.close();
});

Deno.test('Increment 90 capacity benchmark reports steady physical logical and maintenance dimensions', async () => {
  const root = Deno.makeTempDirSync({ prefix: 'henji-i90-v6-capacity-small-' });
  const repeated = await benchmarkV6RepeatedContext({
    databasePath: `${root}/repeated.sqlite3`,
    targetCumulativeTokens: 50_000,
    tokenBytes: 4,
    fixedPrefixBytes: 1_024,
    newFactBytesPerTurn: 512,
  });
  assert(repeated.cumulativeTokens >= 50_000);
  assert(repeated.peak.totalBytes >= repeated.postMaintenance.totalBytes);
  assert(repeated.authorityEncodedBytes > 0);
  assertEquals(repeated.logicalCost.wireBytes, repeated.cumulativeWireBytes);
  assertEquals(repeated.logicalCost.preexistingPayloadBytesDecoded, 0);
  assertEquals(repeated.logicalCost.preexistingPayloadBytesRehashed, 0);
  assertEquals(repeated.logicalCost.preexistingPayloadBytesReencoded, 0);
  assertEquals(repeated.logicalCost.oldSegmentLogicalRewrites, 0);

  await Deno.mkdir(`${root}/length`);
  const lengths = await benchmarkV6SessionLengthDelta(`${root}/length`, [10, 100, 1_000]);
  assertEquals(
    lengths.map((sample) => sample.logicalCost),
    [lengths[0].logicalCost, lengths[0].logicalCost, lengths[0].logicalCost],
  );
  await Deno.mkdir(`${root}/unique`);
  const unique = await benchmarkV6UniquePayloadScaling(
    `${root}/unique`,
    [4_096, 16_384, 65_536],
  );
  assert(unique[2].steadyPhysicalIncrementBytes > unique[0].steadyPhysicalIncrementBytes);
  assert(unique.every((sample) => sample.physicalPerInputByte < 20));
});
