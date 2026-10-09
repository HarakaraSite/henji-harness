import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Message } from '../../v0/agent/core/contracts.ts';
import { createAgentDataPortClient } from '../../v0/agent/data/agent_data_client.ts';
import { createDataClient } from '../../v0/agent/data/client.ts';
import type {
  DataCommandReceipt,
  DataExecutionCompletionControl,
} from '../../v0/agent/data/data_contract.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { sessionPaths } from '../../v0/agent/session/session_store_paths.ts';
import type { WorkerCorrelation } from '../../v0/agent/worker/worker_protocol.ts';
import { workerConfigurationFixture } from './helpers/worker_configuration_fixture.ts';

const messagePair = (turn: number): readonly Message[] => [
  { role: 'user', content: { kind: 'text', text: `task ${turn}` } },
  { role: 'assistant', content: { kind: 'text', text: `answer ${turn}` } },
];

const correlationFor = (sessionId: string, turn: number): WorkerCorrelation => ({
  session: sessionId,
  instanceCorrelation: `increment-218-instance-${turn}`,
  workerGeneration: `increment-218-generation-${turn}`,
  baseStateRevision: turn,
  command: `increment-218-command-${turn}`,
});

Deno.test('Increment 218 Data reads one whole turn from canonical or runtime history', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-data-range-' });
  const workspaceRoot = `${root}/workspace`;
  const stateRoot = `${root}/state`;
  await Deno.mkdir(workspaceRoot);
  const data = await createDataClient({ stateRoot, workspaceRoot });
  const ports: ReturnType<typeof createAgentDataPortClient>[] = [];
  let persistentId: string | undefined;
  const runtimeIds: string[] = [];
  const runtimeLatestExecutionIds = new Map<string, string>();

  const runTurn = async (
    sessionId: string,
    turn: number,
    persistence: 'new' | 'none',
  ) => {
    const correlation = correlationFor(sessionId, turn);
    const port = createAgentDataPortClient(
      await data.attachGeneration(sessionId, correlation),
    );
    ports.push(port);
    await port.ready({
      kind: 'ready',
      correlation,
      configuration: workerConfigurationFixture(),
      manifest: {
        role: 'parent',
        maxSteps: 128,
        profileId: 'increment-218-data-range',
        resources: [],
        rootModel: ROOT_DEFAULT_MODEL_SELECTION,
      },
    });
    const basis = await port.generationContext(correlation);
    deepStrictEqual(basis.initialTranscript, []);
    strictEqual(basis.nextTurn, turn);
    strictEqual(basis.stateRevision, turn);
    strictEqual(basis.canonicalMessageCount, (turn - 1) * 2);
    strictEqual(
      basis.historySource,
      persistence === 'new' ? 'canonical' : 'runtime',
    );
    const executionId = crypto.randomUUID().toLowerCase();
    await data.executionAdmit(sessionId, {
      executionId,
      taskId: crypto.randomUUID().toLowerCase(),
      task: `task ${turn}`,
      correlation,
    });
    port.beginExecution(executionId, correlation);
    port.observation({
      kind: 'provider_observation',
      correlation,
      sequence: 1,
      turn,
      observation: {
        kind: 'request_start',
        request: {
          ordinal: 1,
          lane: 'parent',
          modelStep: 1,
          contextRequestOrdinal: 1,
          endpoint: 'https://provider.invalid/chat',
          method: 'POST',
          requestMetadata: {
            provider: 'fixture-provider',
            modelId: 'fixture-model',
            api: 'openai-chat-completions',
          },
        },
      },
    });
    port.observation({
      kind: 'provider_observation',
      correlation,
      sequence: 2,
      turn,
      observation: {
        kind: 'request_usage',
        requestOrdinal: 1,
        usage: {
          inputTokens: 130,
          outputTokens: 14,
          totalTokens: 144,
          estimatedInputTokens: 123,
          inputEstimateDifference: 7,
        },
      },
    });
    const proposal = port.sendProposal({
      kind: 'commit_proposal',
      correlation,
      transcript: messagePair(turn),
      nextTurn: turn + 1,
    });
    const token = await data.prepareProposal(sessionId, {
      executionId,
      proposalId: proposal.proposalId,
      finalDataSequence: proposal.finalDataSequence,
    });
    const terminal = await data.authorizeCommit(sessionId, token, { accepted: true });
    strictEqual(terminal.canonical, persistence === 'new');
    return { correlation, executionId, port };
  };

  try {
    const persistent = await data.openSession({
      persistence: 'new',
      agent: 'default',
      agentChoice: {},
      initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
    });
    persistentId = persistent.id;
    await runTurn(persistent.id, 1, 'new');
    const second = await runTurn(persistent.id, 2, 'new');
    const persistentControl: DataExecutionCompletionControl = {
      executionId: second.executionId,
      sessionId: persistent.id,
      submittedByCommandId: 'increment-218-persistent-command',
      processSettlement: 'complete',
    };
    await data.saveExecutionCompletionControl(persistentControl);
    strictEqual(
      (await data.sessionDescriptor(persistent.id)).latestExecution
        ?.submittedByCommandId,
      persistentControl.submittedByCommandId,
    );
    const firstTurn = await second.port.readContextTurn(second.correlation, 2);
    const latestTurn = await second.port.readContextTurn(second.correlation, 3);
    strictEqual(firstTurn?.source, 'canonical');
    strictEqual(firstTurn?.turn, 1);
    strictEqual(firstTurn?.messageStart, 0);
    strictEqual(latestTurn?.turn, 2);
    strictEqual(latestTurn?.messageStart, 2);
    deepStrictEqual(firstTurn?.messages, messagePair(1));
    deepStrictEqual(latestTurn?.messages, messagePair(2));
    strictEqual(await second.port.readContextTurn(second.correlation, 1), null);
    // Repeat the child correlation lifecycle. These non-UUID runtime locators are
    // the Session keys used by WorkerHostChildren for persistence:none Sessions.
    for (let childIndex = 0; childIndex < 5; childIndex += 1) {
      const runtimeId = `parent:${crypto.randomUUID()}:child:${crypto.randomUUID()}`;
      runtimeIds.push(runtimeId);
      await data.openSession({
        persistence: 'none',
        sessionId: runtimeId,
        agent: 'default',
        agentChoice: {},
        initialModelSelection: ROOT_DEFAULT_MODEL_SELECTION,
      });
      const runtimeFirst = await runTurn(runtimeId, 1, 'none');
      const runtimeSecond = await runTurn(runtimeId, 2, 'none');
      runtimeLatestExecutionIds.set(runtimeId, runtimeSecond.executionId);
      const runtimeTurn = await runtimeSecond.port.readContextTurn(
        runtimeSecond.correlation,
        3,
      );
      strictEqual(runtimeTurn?.source, 'runtime');
      strictEqual(runtimeTurn?.turn, 2);
      strictEqual(runtimeTurn?.messageStart, 2);
      deepStrictEqual(runtimeTurn?.messages, messagePair(2));

      // A previous turn's correlation remains usable during a later hook phase.
      const oldCorrelationTurn = await runtimeFirst.port.readContextTurn(
        runtimeFirst.correlation,
        3,
      );
      strictEqual(oldCorrelationTurn?.turn, 2);

      await data.closeSession(runtimeId);
      await rejects(() => data.sessionDescriptor(runtimeId));
      strictEqual(
        (await data.executionRead(runtimeSecond.executionId)).execution.outcome,
        'completed',
      );
      const completion: DataExecutionCompletionControl = {
        executionId: runtimeSecond.executionId,
        sessionId: runtimeId,
        submittedByCommandId: `increment-218-parent-command-${runtimeIds.length}`,
        processSettlement: 'complete',
      };
      await data.saveExecutionCompletionControl(completion);
      const updatedExecution = (await data.executionRead(runtimeSecond.executionId)).execution;
      strictEqual(updatedExecution.submittedByCommandId, completion.submittedByCommandId);
      strictEqual(updatedExecution.processSettlement, 'complete');
      const receipt: DataCommandReceipt = {
        coreEpoch: 'increment-218-core-epoch',
        commandId: `increment-218-command-receipt-${runtimeIds.length}`,
        operation: 'task.submit',
        signatureDigest: `sha256:${runtimeIds.length}`,
        result: {
          kind: 'accepted',
          commandId: `increment-218-command-receipt-${runtimeIds.length}`,
          target: { kind: 'session', sessionId: runtimeId },
          value: { executionId: runtimeSecond.executionId },
        },
        completedAt: new Date().toISOString(),
      };
      await data.commandReceiptSave(receipt);
      deepStrictEqual(
        await data.commandReceiptRead(receipt.coreEpoch, receipt.commandId),
        receipt,
      );
    }
  } finally {
    for (const port of ports) port.close();
    await data.close();
  }

  const store = new SqliteHistoryStore(stateRoot, workspaceRoot);
  const paths = await sessionPaths(stateRoot, workspaceRoot);
  const database = new DatabaseSync(`${paths.root}/history.sqlite3`, {
    readOnly: true,
  });
  try {
    await store.initialize();
    strictEqual(
      (await store.readWorker(persistentId!)).transcript.length,
      4,
      'human history remains the complete canonical transcript',
    );
    for (const runtimeId of runtimeIds) {
      const runtimeHistory = store.readSessionHistory(runtimeId);
      strictEqual(runtimeHistory.length, 2);
      deepStrictEqual(runtimeHistory.flatMap((item) => item.messages), [
        ...messagePair(1),
        ...messagePair(2),
      ]);
      const providerFacts = store.readExecutionRequestFacts(
        runtimeLatestExecutionIds.get(runtimeId)!,
        1,
      );
      deepStrictEqual(providerFacts.map((event) => event.kind), [
        'provider_request_start',
        'provider_request_usage',
      ]);
      const usage = providerFacts.at(-1)!.payload as {
        readonly observation: {
          readonly usage: {
            readonly inputTokens: number;
            readonly outputTokens: number;
            readonly totalTokens: number;
            readonly estimatedInputTokens: number;
            readonly inputEstimateDifference: number;
          };
        };
      };
      deepStrictEqual(usage.observation.usage, {
        inputTokens: 130,
        outputTokens: 14,
        totalTokens: 144,
        estimatedInputTokens: 123,
        inputEstimateDifference: 7,
      });
    }
    const cursorRows = database.prepare(`
      SELECT cut, store_revision, descriptor_sequence, anchor_json,
        latest_execution_id, session_correlation
      FROM data_session_read_cursors
    `).all() as Record<string, string | number | null>[];
    strictEqual(cursorRows.length, runtimeIds.length + 1);
    const runtimeCursorRows = cursorRows.filter((cursor) =>
      runtimeIds.includes(String(cursor.session_correlation))
    );
    strictEqual(runtimeCursorRows.length, runtimeIds.length);
    const persistentCursor = cursorRows.find((cursor) =>
      cursor.session_correlation === persistentId
    );
    ok(persistentCursor, 'closing Data saves the persistent session cursor');
    const persistentAnchor = JSON.parse(String(persistentCursor.anchor_json)) as {
      readonly persistence: string;
    };
    strictEqual(persistentAnchor.persistence, 'persistent');
    for (const cursor of runtimeCursorRows) {
      const runtimeId = String(cursor.session_correlation);
      ok(runtimeIds.includes(runtimeId));
      ok(Number(cursor.cut) > 0);
      ok(Number(cursor.store_revision) > 0);
      ok(Number(cursor.descriptor_sequence) > 0);
      strictEqual(
        cursor.latest_execution_id,
        runtimeLatestExecutionIds.get(runtimeId),
      );
      const anchor = JSON.parse(String(cursor.anchor_json)) as {
        readonly persistence: string;
        readonly nextTurn: number;
        readonly session: { readonly messageCount: number };
      };
      strictEqual(anchor.persistence, 'none');
      strictEqual(anchor.nextTurn, 3);
      strictEqual(anchor.session.messageCount, 4);
      const executionId = runtimeLatestExecutionIds.get(runtimeId)!;
      deepStrictEqual(
        store.readExecutionCompletionControl(executionId),
        {
          executionId,
          sessionId: runtimeId,
          submittedByCommandId: `increment-218-parent-command-${runtimeIds.indexOf(runtimeId) + 1}`,
          processSettlement: 'complete',
        },
      );
    }
  } finally {
    database.close();
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
