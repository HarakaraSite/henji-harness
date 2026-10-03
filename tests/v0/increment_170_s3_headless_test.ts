import { ok, strictEqual } from 'node:assert';
import { resolveBuiltinAgent } from '../../v0/agent/definitions/agent_catalog.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { runHeadlessWorker } from '../../v0/agent/worker/worker_headless_runner.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';

Deno.test('Increment 170 headless production Worker closes Data after terminal persistence and delivers requested events', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i170-headless-' });
  const stateRoot = `${root}/state`;
  const events: AgentEvent[] = [];
  const reader = new SqliteHistoryV7ProductionStore(stateRoot, root, { readOnly: true });
  try {
    const result = await runHeadlessWorker('answer briefly', resolveBuiltinAgent(), {
      workspaceRoot: root,
      stateRoot,
      configRoot: `${root}/config`,
      dataRoot: `${root}/resources`,
      physicalIoMode: 'provider-free',
      eventSink: (event) => events.push(event),
    });
    ok(result.outcome.ok, JSON.stringify(result.outcome));
    strictEqual(result.outcome.stopReason, 'final');
    strictEqual(result.requestCount, 0);
    ok(typeof result.outcome.finalText === 'string');
    ok(!('transcript' in result.outcome), 'full model transcript returned through Core');
    await reader.initialize();
    const rows = reader.listExecutions();
    strictEqual(rows.length, 1);
    strictEqual(rows[0].lifecycle, 'settled');
    strictEqual(rows[0].outcome, 'completed');
    strictEqual(rows[0].adoption, 'non_canonical');
    const artifacts = await reader.executionArtifacts.list();
    strictEqual(artifacts.length, 1);
    strictEqual(artifacts[0].storeResult, 'committed');
    ok(events.some((event) => event.kind === 'turn_start'));
    ok(events.some((event) => event.kind === 'assistant_message'));
  } finally {
    reader.close();
    await Deno.remove(root, { recursive: true });
  }
});
