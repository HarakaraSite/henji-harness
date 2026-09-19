import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { DenoHumanHistoryExporter } from '../../v0/agent/history/human_history_export.ts';
import type { HumanHistoryReadPort } from '../../v0/agent/history/human_history.ts';
import type { StoredSessionRecord } from '../../v0/agent/session/session_store_contract.ts';
import { sessionPaths } from '../../v0/agent/session/session_store.ts';
import { createTuiPresentationAdapter } from '../../v0/presentation/adapter.ts';

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

const sessionId = '43000000-0000-4000-8000-000000000001';
const createdAt = '2026-09-13T00:00:00.000Z';
const definition = {
  schemaVersion: 1 as const,
  resourceKind: 'agent-definition' as const,
  resourceId: 'builtin/default',
  revision: { algorithm: 'sha256' as const, digest: '4'.repeat(64) },
};
const build = buildManifest();

const executionInput = (
  ordinal: number,
  task: string,
  workspaceRoot: string,
  first = false,
  boundSessionId = sessionId,
) => {
  const suffix = ordinal.toString(16).padStart(12, '0');
  const input = {
    taskId: `43000000-0000-4000-8001-${suffix}`,
    executionId: `43000000-0000-4000-8002-${suffix}`,
    createdAt: `2026-09-13T00:00:${String(ordinal).padStart(2, '0')}.000Z`,
    sessionCorrelation: boundSessionId,
    canonicalSessionId: boundSessionId,
    sessionMode: 'persistent' as const,
    turn: 1,
    task,
    baseStateRevision: 1,
    agent: 'default' as const,
    model: ROOT_DEFAULT_MODEL_SELECTION,
    build,
    definition,
  };
  if (!first) return input;
  const record: StoredSessionRecord = {
    schemaVersion: 6,
    sessionId: boundSessionId,
    workspaceRoot,
    agent: 'default',
    createdAt,
    updatedAt: createdAt,
    title: null,
    stateRevision: 1,
    nextTurn: 1,
    transcript: [],
    definition,
    activeModel: ROOT_DEFAULT_MODEL_SELECTION,
    modelChanges: [{
      effectiveFromTurn: 1,
      changedAt: createdAt,
      selection: ROOT_DEFAULT_MODEL_SELECTION,
    }],
    turnModels: [],
    turnExecutions: [],
  };
  return { ...input, sessionRecord: record };
};

const cancelledOutcome = (task: string) => ({
  ok: false,
  task,
  outcome: 'cancelled' as const,
  stopReason: 'cancelled' as const,
  error: 'cancelled',
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

Deno.test('Increment 43 projects attempts, pages, exact detail, and literal search read-only', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i43-read-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  try {
    await store.initialize();
    const failed = executionInput(
      1,
      'failed attempt nonce-[literal]',
      workspaceRoot,
      true,
    );
    await store.beginExecution(failed);
    store.appendExecutionEvent({
      executionId: failed.executionId,
      direction: 'worker_to_host',
      source: 'worker',
      kind: 'runtime_event',
      workerSequence: 1,
      payload: {
        kind: 'runtime_event',
        correlation: {
          session: sessionId,
          instanceCorrelation: 'instance-43',
          workerGeneration: 'generation-43',
          baseStateRevision: 1,
          command: 'turn-43',
        },
        sequence: 1,
        event: {
          kind: 'agent_event',
          event: {
            kind: 'assistant_progress',
            turn: 1,
            text: 'partial nonce-[literal]',
          },
        },
      },
    });
    const providerCorrelation = {
      session: sessionId,
      instanceCorrelation: 'instance-43',
      workerGeneration: 'generation-43',
      baseStateRevision: 1,
      command: 'turn-43',
    };
    for (
      const [sequence, event] of [
        [
          2,
          {
            kind: 'model_result',
            result: { kind: 'final', text: 'unified provider answer' },
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          },
        ],
        [
          3,
          {
            kind: 'tool_call',
            call: {
              callId: 'call-43',
              name: 'read_file',
              arguments: { path: 'README.md' },
            },
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          },
        ],
        [
          4,
          {
            kind: 'tool_result',
            result: {
              kind: 'tool_result',
              callId: 'call-43',
              name: 'read_file',
              text: 'unified tool output',
              outcome: 'success',
            },
            modelStep: 1,
            lane: 'parent',
            requestOrdinal: 1,
          },
        ],
      ] as const
    ) {
      store.appendExecutionEvent({
        executionId: failed.executionId,
        direction: 'worker_to_host',
        source: 'worker',
        kind: 'runtime_event',
        workerSequence: sequence,
        payload: {
          kind: 'provider_observation',
          correlation: providerCorrelation,
          sequence,
          turn: 1,
          observation: { kind: 'runtime_event', requestOrdinal: 1, event },
        },
      });
    }
    store.settleNonCanonicalExecution({
      ...failed,
      outcome: cancelledOutcome(failed.task),
    });

    const canonical = executionInput(2, 'canonical attempt', workspaceRoot);
    await store.beginExecution(canonical);
    if (!('sessionRecord' in failed)) throw new Error('missing initial record');
    const transcript = [
      {
        role: 'user' as const,
        content: { kind: 'text' as const, text: canonical.task },
      },
      {
        role: 'assistant' as const,
        content: { kind: 'text' as const, text: 'canonical answer' },
      },
    ];
    const record: StoredSessionRecord = {
      ...failed.sessionRecord,
      updatedAt: canonical.createdAt,
      stateRevision: 2,
      nextTurn: 2,
      transcript,
      turnModels: [{ turn: 1, selection: ROOT_DEFAULT_MODEL_SELECTION }],
      turnExecutions: [{ turn: 1, build, definition }],
    };
    store.commitCanonicalTurn({
      ...canonical,
      record,
      outcome: {
        ok: true,
        task: canonical.task,
        outcome: 'final',
        stopReason: 'final',
        finalText: 'canonical answer',
        steps: 1,
        toolCallCount: 0,
        toolResultCount: 0,
        transcript,
      },
    });

    const one = store.readHumanHistoryPage({
      sessionId,
      direction: 'oldest',
      executionLimit: 1,
    });
    assertEquals(one.executionCount, 1);
    assert(!one.atNewest);
    assert(one.newerCursor !== undefined);
    assertEquals(one.entries[0].attempt, 1);
    const unifiedAssistant = one.entries.find((entry) =>
      entry.label === 'assistant>' && entry.text === 'unified provider answer'
    );
    assert(unifiedAssistant !== undefined);
    assert(
      one.entries.some((entry) => entry.text.includes('unified tool output')),
    );
    const unifiedDetail = store.readHumanHistoryDetail(
      sessionId,
      unifiedAssistant.detailId,
    );
    assert(unifiedDetail.text.includes('unified provider answer'));
    assert(
      store.searchHumanHistory({
        sessionId,
        query: 'unified provider answer',
        direction: 'next',
      })?.entryId === unifiedAssistant.id,
    );

    const two = store.readHumanHistoryPage({
      sessionId,
      direction: 'newer',
      cursor: one.newerCursor,
      executionLimit: 1,
    });
    assertEquals(two.entries[0].attempt, 2);
    assert(two.entries.some((entry) => entry.text === 'canonical answer'));
    assert(two.atNewest);

    const hit = store.searchHumanHistory({
      sessionId,
      query: 'nonce-[literal]',
      direction: 'next',
      fromEntryId: two.entries.at(-1)?.id,
    });
    assert(hit !== undefined);
    assert(hit.wrapped);
    assert(hit.entryId.startsWith('task:') || hit.entryId.startsWith('event:'));
    assertEquals(
      store.searchHumanHistory({
        sessionId,
        query: 'NONCE-[literal]',
        direction: 'next',
      }),
      undefined,
    );

    const detail = store.readHumanHistoryDetail(sessionId, hit.detailId);
    assert(detail.text.includes('nonce-[literal]'));
    assertEquals(detail.scalarOffset, 0);
    const longInput = {
      ...executionInput(
        4,
        `long ${'界'.repeat(20_000)} deep-detail-nonce gap deep-detail-nonce`,
        workspaceRoot,
      ),
      turn: 2,
      baseStateRevision: 2,
    };
    await store.beginExecution(longInput);
    store.settleNonCanonicalExecution({
      ...longInput,
      outcome: {
        ...cancelledOutcome(longInput.task),
        transcript: [
          ...transcript,
          { role: 'user', content: { kind: 'text', text: longInput.task } },
        ],
      },
    });
    const longDetail = store.readHumanHistoryDetail(
      sessionId,
      `task:${longInput.executionId}`,
    );
    assert(longDetail.nextOffset !== undefined);
    const longTail = store.readHumanHistoryDetail(
      sessionId,
      longDetail.detailId,
      longDetail.nextOffset,
    );
    assertEquals(longDetail.text + longTail.text, longInput.task);
    const firstLongHit = store.searchHumanHistory({
      sessionId,
      query: 'deep-detail-nonce',
      direction: 'next',
    });
    assert(
      firstLongHit?.detail !== undefined,
      'summary-external match did not open detail',
    );
    assert(firstLongHit.detail.text.includes('deep-detail-nonce'));
    assert(firstLongHit.detailMatchScalarOffset !== undefined);
    const secondLongHit = store.searchHumanHistory({
      sessionId,
      query: 'deep-detail-nonce',
      direction: 'next',
      fromEntryId: firstLongHit.entryId,
      fromSourceScalarOffset: firstLongHit.sourceScalarOffset,
    });
    assertEquals(secondLongHit?.entryId, firstLongHit.entryId);
    assert(
      (secondLongHit?.sourceScalarOffset ?? 0) >
        firstLongHit.sourceScalarOffset,
      'next did not advance to the second occurrence in one entry',
    );

    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const checkpointDb = new DatabaseSync(`${paths.root}/history-v5.sqlite3`);
    try {
      checkpointDb.prepare(`INSERT INTO semantic_checkpoints(
        session_id, created_at, covered_turn, retained_turn, source_profile_id, summary
      ) VALUES (?, ?, ?, ?, ?, ?)`).run(
        sessionId,
        canonical.createdAt,
        1,
        1,
        'increment-43-profile',
        'increment 43 checkpoint',
      );
    } finally {
      checkpointDb.close();
    }
    const exportRecords = [...store.streamHumanHistoryExport(sessionId)];
    assert(exportRecords.some((item) => item.kind === 'store_metadata'));
    assert(exportRecords.some((item) => item.kind === 'session_model_change'));
    assert(exportRecords.some((item) => item.kind === 'semantic_checkpoint'));
    const fallbackMessage = exportRecords.find((item) =>
      item.kind === 'execution_message' &&
      (item.value as { readonly content_digest?: unknown }).content_digest !==
        null
    );
    assert(fallbackMessage !== undefined);
    const fallbackDigest = String(
      (fallbackMessage.value as { readonly content_digest: unknown })
        .content_digest,
    );
    assert(
      exportRecords.some((item) =>
        item.kind === 'context_blob' &&
        item.identity === `content:${fallbackDigest}`
      ),
    );

    const db = new DatabaseSync(`${paths.root}/history-v5.sqlite3`);
    try {
      db.prepare(`
        INSERT INTO execution_artifacts(
          artifact_id, execution_id, settled_at, command_session,
          command_instance_correlation, command_worker_generation,
          command_base_revision, command_id, store_result, acknowledgement,
          settlement, lifecycle, normalized_outcome, adoption, context_capture,
          link_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        '43000000-0000-4000-8004-000000000001',
        longInput.executionId,
        longInput.createdAt,
        sessionId,
        'instance-43',
        'generation-43',
        longInput.baseStateRevision,
        'turn-43-invalid-artifact',
        'not_attempted',
        'not_sent',
        'unknown',
        'settled',
        'unknown',
        'non_canonical',
        'partial',
        'linked',
      );
    } finally {
      db.close();
    }
    const artifactEntry = store.readHumanHistoryPage({
      sessionId,
      direction: 'latest',
    }).entries.find((entry) => entry.kind === 'artifact');
    assert(artifactEntry !== undefined);
    let invalidDetail = false;
    try {
      store.readHumanHistoryDetail(sessionId, artifactEntry.detailId);
    } catch (error) {
      invalidDetail = error instanceof Error &&
        error.message === 'history_invalid';
    }
    assert(
      invalidDetail,
      'tampered artifact detail did not fail through the existing codec',
    );
    assertEquals(await store.readWorker(sessionId), record);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 43 streams deterministic Session-scoped JSONL with matching receipt', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i43-export-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  try {
    await store.initialize();
    const input = executionInput(
      3,
      'export cancelled execution',
      workspaceRoot,
      true,
    );
    await store.beginExecution(input);
    store.settleNonCanonicalExecution({
      ...input,
      outcome: cancelledOutcome(input.task),
    });
    const secondSessionId = '43000000-0000-4000-8000-000000000002';
    let writer: Promise<number> | undefined;
    const concurrentReader: HumanHistoryReadPort = {
      readHumanHistoryPage: (request) => store.readHumanHistoryPage(request),
      readHumanHistoryDetail: (id, detail, offset) =>
        store.readHumanHistoryDetail(id, detail, offset),
      searchHumanHistory: (request) => store.searchHumanHistory(request),
      *streamHumanHistoryExport(id) {
        let first = true;
        for (const record of store.streamHumanHistoryExport(id)) {
          yield record;
          if (first) {
            first = false;
            writer = (async () => {
              const started = performance.now();
              const other = executionInput(
                5,
                'concurrent Session writer',
                workspaceRoot,
                true,
                secondSessionId,
              );
              await store.beginExecution(other);
              store.settleNonCanonicalExecution({
                ...other,
                outcome: cancelledOutcome(other.task),
              });
              return performance.now() - started;
            })();
          }
        }
      },
    };
    const exporter = new DenoHumanHistoryExporter(
      stateRoot,
      workspaceRoot,
      concurrentReader,
      {
        uuid: () => '43000000-0000-4000-8003-000000000001',
      },
    );
    const before = await store.readWorker(sessionId);
    const adapter = createTuiPresentationAdapter(
      {
        submit: () => Promise.resolve(cancelledOutcome('unused')),
        currentPosition: () => ({
          sessionId,
          createdAt,
          agent: 'default',
          committedTurn: 0,
          messageCount: 0,
        }),
      },
      undefined,
      undefined,
      {
        humanHistoryReader: concurrentReader,
        humanHistoryExporter: exporter,
        historySessionMode: 'durable',
      },
    );
    const opened = await adapter.dispatch({ kind: 'human_history_open' });
    assertEquals(opened.kind, 'human_history_page');
    const exported = await adapter.dispatch({ kind: 'history_export_all' });
    if (exported.kind !== 'history_export_all') {
      throw new Error('full export rejected');
    }
    const receipt = exported;
    const bytes = await Deno.readFile(receipt.path);
    const lines = new TextDecoder().decode(bytes).trimEnd().split('\n').map((
      line,
    ) =>
      JSON.parse(line) as {
        readonly kind: string;
        readonly value: Record<string, unknown>;
      }
    );
    assertEquals(lines[0].kind, 'header');
    assertEquals(lines[1].kind, 'session');
    assertEquals(lines.filter((line) => line.kind === 'execution').length, 1);
    assert(lines.some((line) => line.kind === 'event'));
    assertEquals(receipt.executionCount, 1);
    assertEquals(receipt.byteLength, bytes.byteLength);
    assertEquals(
      receipt.sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    assert(writer !== undefined);
    assert(
      await writer < 250,
      'separate Session writer exceeded the 250 ms contract',
    );
    assertEquals(
      store.readHumanHistoryPage({
        sessionId: secondSessionId,
        direction: 'latest',
      }).executionCount,
      1,
    );
    assertEquals(await store.readWorker(sessionId), before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 89 list and normalized export do not hydrate unrelated request blobs', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i89-metadata-read-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  try {
    await store.initialize();
    const input = executionInput(
      5,
      'metadata-only request',
      workspaceRoot,
      true,
    );
    await store.beginExecution(input);
    store.settleNonCanonicalExecution({
      ...input,
      outcome: cancelledOutcome(input.task),
    });
    const paths = await sessionPaths(stateRoot, workspaceRoot);
    const db = new DatabaseSync(`${paths.root}/history-v5.sqlite3`);
    const contentDigest = `sha256:${'a'.repeat(64)}`;
    const occurrenceDigest = `sha256:${'b'.repeat(64)}`;
    const revisionDigest = `sha256:${'c'.repeat(64)}`;
    try {
      db.prepare(
        `INSERT INTO context_blobs(digest, byte_length, media_type, raw_bytes)
        VALUES (?, 3, 'application/vnd.henji.message+json', ?)`,
      )
        .run(contentDigest, new TextEncoder().encode('bad'));
      db.prepare(`INSERT INTO context_occurrences(
        execution_id, occurrence_id, kind, content_digest, occurrence_digest
      ) VALUES (?, 'corrupt-occurrence', 'message', ?, ?)`)
        .run(input.executionId, contentDigest, occurrenceDigest);
      db.prepare(`INSERT INTO context_sequence_revisions(
        execution_id, revision_digest, lane, sequence_kind,
        base_revision_digest, result_item_count
      ) VALUES (?, ?, 'parent', 'user_turn', NULL, 1)`)
        .run(input.executionId, revisionDigest);
      db.prepare(`INSERT INTO context_sequence_splices(
        execution_id, revision_digest, splice_ordinal, start_index, delete_count
      ) VALUES (?, ?, 1, 0, 0)`).run(input.executionId, revisionDigest);
      db.prepare(`INSERT INTO context_sequence_insertions(
        execution_id, revision_digest, splice_ordinal, insertion_ordinal,
        occurrence_id, occurrence_digest
      ) VALUES (?, ?, 1, 1, 'corrupt-occurrence', ?)`)
        .run(input.executionId, revisionDigest, occurrenceDigest);
      db.prepare(`INSERT INTO model_requests(
        execution_id, request_ordinal, observation_ordinal, lane,
        model_step, purpose, revision_digest
      ) VALUES (?, 1, NULL, 'parent', 1, 'user_turn', ?)`)
        .run(input.executionId, revisionDigest);
    } finally {
      db.close();
    }

    const page = store.readHumanHistoryPage({ sessionId, direction: 'latest' });
    const requestEntry = page.entries.find((entry) => entry.kind === 'request');
    assert(requestEntry !== undefined);
    assertEquals(requestEntry.text, 'parent · user_turn · step 1 · ""');
    const exported = [...store.streamHumanHistoryExport(sessionId)];
    assertEquals(
      exported.filter((record) =>
        record.kind === 'context_blob' &&
        record.identity === `content:${contentDigest}`
      ).length,
      1,
    );
    assertEquals(
      exported.filter((record) => record.kind === 'context_occurrence').length,
      1,
    );

    let detailRejected = false;
    try {
      store.readHumanHistoryDetail(sessionId, requestEntry.detailId);
    } catch (error) {
      detailRejected = error instanceof Error &&
        error.message === 'history_invalid';
    }
    assert(
      detailRejected,
      'single-request detail did not validate its referenced blob',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
