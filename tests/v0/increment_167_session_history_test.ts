import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import type { SessionSnapshot } from '../../v0/api/contract.ts';
import { decodeSessionStreamFrame } from '../../v0/api/codec.ts';
import {
  diffSessionSnapshots,
  initialSessionClientState,
  reduceSessionStreamFrame,
} from '../../v0/api/reducer.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { RemoteSystemNotices } from '../../v0/tui/system_notices.ts';
import { createHistoryProbe, waitForHistory } from './helpers/increment_167_history_probe.ts';

Deno.test('Increment 167 entire history survives cancel, recall, later commits, SSE and Core restart', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i167-' });
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previousEnv = Object.keys(env).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const probe = await createHistoryProbe(root);
  const projector = new SnapshotConversationProjector();
  const notices = new RemoteSystemNotices();
  let previous = await probe.client.sessionRead(probe.sessionId);
  let state = initialSessionClientState(previous);
  let revision = previous.cursor.revision;
  const observe = (snapshot: SessionSnapshot) => {
    // Exercise the real wire codec and stream reducer as well as direct snapshots.
    const after = { ...snapshot, cursor: { ...snapshot.cursor, revision: ++revision } };
    state = reduceSessionStreamFrame(
      state,
      decodeSessionStreamFrame(JSON.parse(JSON.stringify({
        kind: 'session.update',
        cursor: after.cursor,
        previousRevision: revision - 1,
        changes: diffSessionSnapshots(previous, after),
      }))),
    );
    deepStrictEqual(state.snapshot, after);
    previous = after;
    return notices.merge(after, projector.project(after, 'scope').entries);
  };
  const submit = async (text: string, cancel = false) => {
    probe.hold(cancel);
    const result = await probe.client.taskSubmit(probe.sessionId, {
      commandId: crypto.randomUUID(),
      text,
    });
    strictEqual(result.kind, 'accepted');
    if (result.kind !== 'accepted') throw new Error('task rejected');
    const executionId = result.value.executionId;
    if (cancel) {
      await waitForHistory(async () =>
        (await probe.client.sessionRead(probe.sessionId)).conversation.requests.some((item) =>
          item.text === 'CANCELLED_PARTIAL'
        )
      );
      observe(await probe.client.sessionRead(probe.sessionId));
      strictEqual(
        (await probe.client.executionCancel(probe.sessionId, executionId, {
          commandId: crypto.randomUUID(),
        })).kind,
        'accepted',
      );
    }
    await waitForHistory(async () =>
      (await probe.client.executionRead(executionId)).execution.processSettlement === 'complete'
    );
    const snapshot = await probe.client.sessionRead(probe.sessionId);
    strictEqual(
      snapshot.runtime.execution?.outcome,
      cancel ? 'cancelled' : 'completed',
      JSON.stringify(snapshot.runtime.execution),
    );
    return { executionId, snapshot, entries: observe(snapshot) };
  };
  try {
    const first = await submit('BASELINE');
    const cancelled = await submit('CANCEL_ATTEMPT', true);
    const cancelledRows = cancelled.entries.filter((entry) =>
      entry.executionId === cancelled.executionId
    );
    deepStrictEqual(cancelledRows.map((entry) => entry.kind), [
      'user',
      'thinking',
      'assistant',
      'tool',
      'assistant',
      'system',
    ]);
    strictEqual(cancelledRows.at(-1)?.text, 'CANCELLED');
    strictEqual(cancelledRows[0].label, 'user>');
    strictEqual(cancelledRows[2].label, 'assistant note>');
    const recall = await probe.client.recall(probe.sessionId, {
      commandId: crypto.randomUUID(),
      action: 'prepare',
      executionId: cancelled.executionId,
    });
    strictEqual(recall.kind, 'accepted');
    observe(await probe.client.sessionRead(probe.sessionId));
    notices.retain(probe.sessionId, 'recall-receipt', 'RECALL PREPARED');
    const continued = await submit('CONTINUE');
    const next = await submit('NEXT_TASK');
    strictEqual(
      cancelled.snapshot.runtime.execution?.turn,
      continued.snapshot.conversation.executions.find((item) =>
        item.executionId === continued.executionId
      )?.turn,
    );
    const order = [
      first.executionId,
      cancelled.executionId,
      continued.executionId,
      next.executionId,
    ];
    deepStrictEqual(next.snapshot.conversation.executions.map((item) => item.executionId), order);
    deepStrictEqual([
      ...new Set(
        next.entries.filter((entry) => entry.executionId).map((entry) => entry.executionId),
      ),
    ], order);
    deepStrictEqual(
      next.entries.filter((entry) => entry.executionId === cancelled.executionId),
      cancelledRows,
    );
    const recallIndex = next.entries.findIndex((entry) => entry.text === 'RECALL PREPARED');
    const cancelIndex = next.entries.findIndex((entry) => entry.text === 'CANCELLED');
    const continuedIndex = next.entries.findIndex((entry) =>
      entry.executionId === continued.executionId
    );
    strictEqual(recallIndex, cancelIndex + 1);
    strictEqual(continuedIndex, recallIndex + 1);
    for (const result of ['RESULT 1', 'RESULT 3', 'RESULT 4']) {
      strictEqual(next.entries.filter((entry) => entry.text === result).length, 1);
    }
    strictEqual(next.entries.filter((entry) => entry.kind === 'tool').length, 4);
    strictEqual(new Set(next.entries.map((entry) => entry.id)).size, next.entries.length);
    for (const item of next.snapshot.conversation.messages.filter((item) => item.role === 'user')) {
      strictEqual(next.entries.find((entry) => entry.text === item.text)?.label, 'user>');
    }
    ok(
      JSON.stringify(probe.inputs[4]).includes('CANCEL_ATTEMPT'),
      'recall must pass explicitly selected evidence',
    );
    const lastInput = JSON.stringify(probe.inputs[6]);
    ok(!lastInput.includes('CANCEL_ATTEMPT'));
    ok(!lastInput.includes('CANCELLED_PARTIAL'));
    ok(lastInput.includes('BASELINE'));
    ok(lastInput.includes('CONTINUE'));
    const beforeRestart = next.snapshot;
    const resumed = await probe.restart();
    deepStrictEqual(resumed.conversation.messages, beforeRestart.conversation.messages);
    deepStrictEqual(resumed.conversation.tools, beforeRestart.conversation.tools);
    deepStrictEqual(resumed.conversation.thinking, beforeRestart.conversation.thinking);
    // Fresh TUI restores persisted outcomes; local recall receipt is deliberately UI-local.
    const freshEntries = new RemoteSystemNotices().merge(
      resumed,
      new SnapshotConversationProjector().project(resumed, 'resumed').entries,
    );
    deepStrictEqual(
      freshEntries.filter((entry) => entry.executionId === cancelled.executionId),
      cancelledRows,
    );
    strictEqual(
      freshEntries.findIndex((entry) => entry.text === 'CANCELLED') + 1,
      freshEntries.findIndex((entry) => entry.executionId === continued.executionId),
    );
    strictEqual(probe.inputs.length, 8);
  } finally {
    await probe.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 167 stopped thinking stays at its execution boundary after later answers', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i167-thinking-' });
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
  };
  const previousEnv = Object.keys(env).map((key) => [key, Deno.env.get(key)] as const);
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  const probe = await createHistoryProbe(root);
  try {
    probe.hold(true, true);
    const submitted = await probe.client.taskSubmit(probe.sessionId, {
      commandId: crypto.randomUUID(),
      text: 'THINKING_CANCEL',
    });
    if (submitted.kind !== 'accepted') throw new Error('task rejected');
    const executionId = submitted.value.executionId;
    await waitForHistory(async () =>
      (await probe.client.sessionRead(probe.sessionId)).conversation.thinking.some((item) =>
        item.text === 'STOPPED_THOUGHT'
      )
    );
    await probe.client.executionCancel(probe.sessionId, executionId, {
      commandId: crypto.randomUUID(),
    });
    await waitForHistory(async () =>
      (await probe.client.executionRead(executionId)).execution.processSettlement === 'complete'
    );
    probe.hold(false);
    const next = await probe.client.taskSubmit(probe.sessionId, {
      commandId: crypto.randomUUID(),
      text: 'AFTER_THINKING_CANCEL',
    });
    if (next.kind !== 'accepted') throw new Error('next task rejected');
    await waitForHistory(async () =>
      (await probe.client.executionRead(next.value.executionId)).execution.processSettlement ===
        'complete'
    );
    const snapshot = await probe.client.sessionRead(probe.sessionId);
    const entries = new RemoteSystemNotices().merge(
      snapshot,
      new SnapshotConversationProjector().project(snapshot, 'scope').entries,
    );
    const index = entries.findIndex((entry) => entry.text === 'STOPPED_THOUGHT');
    ok(index >= 0);
    strictEqual(entries[index].executionId, executionId);
    strictEqual(entries[index + 1].text, 'CANCELLED');
    strictEqual(entries[index + 2].executionId, next.value.executionId);
    strictEqual(entries.at(-1)?.text, 'RESULT 2');
  } finally {
    await probe.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
