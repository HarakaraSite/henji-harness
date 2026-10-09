import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createApplicationService } from '../../v0/agent/host/application_service.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';

type Application = Awaited<ReturnType<typeof createApplicationService>>;

const writeJson = async (path: string, value: unknown) => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value));
};
const readLog = async (path: string): Promise<Record<string, unknown>[]> =>
  (await Deno.readTextFile(path)).trim().split('\n').map((line) => JSON.parse(line));
const complete = async (service: Application, task: string) => {
  const admission = await service.tasks.admit(task, crypto.randomUUID());
  const outcome = await admission.completion;
  strictEqual(outcome.outcome, 'final');
  const deadline = Date.now() + 3_000;
  while (service.tasks.isBusy()) {
    if (Date.now() > deadline) throw new Error('completed task remained busy');
    await new Promise((accept) => setTimeout(accept, 10));
  }
  strictEqual(
    (await service.data.executionRead(admission.executionId)).execution.outcome,
    'completed',
  );
  return admission.executionId;
};

const configure = async (root: string, delayMs: number) => {
  const configRoot = `${root}/config`;
  const logPath = `${root}/hook-events.ndjson`;
  const workerErrors: string[] = [];
  await writeJson(`${configRoot}/agents.json`, {
    schemaVersion: 1,
    default: 'agents/root.json',
    agents: {},
  });
  await writeJson(`${configRoot}/agents/root.json`, {
    name: 'root',
    instruction: 'checkpoint fixture',
    tools: [],
    agents: [],
  });
  await writeJson(`${configRoot}/hooks.json`, {
    schemaVersion: 1,
    default: ['checkpoint', 'observer'],
    hooks: {
      checkpoint: 'hooks/checkpoint.ts',
      observer: 'hooks/observer.ts',
    },
  });
  await Deno.mkdir(`${configRoot}/hooks`, { recursive: true });
  const record = `const record = (value) => Deno.writeTextFile(${JSON.stringify(logPath)},
    JSON.stringify(value) + '\\n', { append: true });\n`;
  await Deno.writeTextFile(
    `${configRoot}/hooks/checkpoint.ts`,
    record + `export default () => ({
      before_turn: ({ runtime, context }) => record({
        phase: 'before_turn', turn: runtime.turnNumber,
        nextTurn: context.transcript.nextTurn, messageCount: context.transcript.messageCount,
        range: context.transcript.range,
        checkpoint: context.checkpoint,
        turns: context.transcript.turns.map((turn) => turn.turn),
        retained: context.projectedContext.retainedTurns.map((turn) => turn.turn),
      }),
      after_turn: async ({ runtime, outcome, settlement, context }) => {
        const retained = context.projectedContext.retainedTurns;
        let mutationRejected = false;
        try { outcome.transcript.pop(); } catch { mutationRejected = true; }
        await record({
          phase: 'after_turn', turn: runtime.turnNumber, settlement,
          turns: context.transcript.turns.map((turn) => turn.turn),
          finalText: outcome.finalText,
          contextText: JSON.stringify(context.transcript.turns),
          frozen: Object.isFrozen(context) && Object.isFrozen(context.transcript.turns),
          outcomeFrozen: Object.isFrozen(outcome.transcript), mutationRejected,
          shared: retained.every((turn) => {
            const canonical = context.transcript.turns.find((item) => item.turn === turn.turn);
            return turn.messages.every((message, index) => canonical.messages[index] === message);
          }),
        });
        if (runtime.turnNumber === 2) {
          await new Promise((accept) => setTimeout(accept, ${delayMs}));
          return { checkpoint: { summary: 'SUMMARY_A', coveredThroughTurn: 1 } };
        }
      },
      runtime_stop: ({ context }) => record({
        phase: 'runtime_stop', contextText: JSON.stringify(context.transcript.turns),
      }),
    });\n`,
  );
  await Deno.writeTextFile(
    `${configRoot}/hooks/observer.ts`,
    record + `export default () => ({
      after_turn: async ({ runtime, context }) => {
        if (runtime.turnNumber === 2) {
          await record({ phase: 'observer', checkpoint: context.checkpoint,
            retained: context.projectedContext.retainedTurns.map((turn) => turn.turn),
            shared: context.projectedContext.retainedTurns.every((turn) => {
              const canonical = context.transcript.turns.find((item) => item.turn === turn.turn);
              return turn.messages.every((message, index) => canonical.messages[index] === message);
            }) });
          return { checkpoint: { summary: 'SUMMARY_B', coveredThroughTurn: 1 } };
        }
        if (runtime.turnNumber === 3) throw new Error('after_turn failure marker');
      },
    });\n`,
  );
  return {
    logPath,
    workerErrors,
    options: {
      workspaceRoot: root,
      stateRoot: `${root}/state`,
      dataRoot: `${root}/data`,
      configRoot,
      physicalIoMode: 'provider-free' as const,
      capsuleFactory: (url: URL) => {
        const capsule = new WorkerCapsule(url);
        return {
          send: capsule.send.bind(capsule),
          terminate: capsule.terminate.bind(capsule),
          subscribe: (listener: Parameters<WorkerCapsule['subscribe']>[0]) =>
            capsule.subscribe((message) => {
              if (message.kind === 'worker_error') workerErrors.push(message.message);
              listener(message);
            }),
        };
      },
    },
  };
};

Deno.test('Increment 189 root after_turn waits for durable checkpoints and restores projection', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-checkpoint-' });
  const { options, logPath, workerErrors } = await configure(root, 5_150);
  let service: Application | undefined;
  try {
    service = await createApplicationService({ ...options, persistence: 'new' });
    const sessionId = service.currentSession().sessionId;
    await complete(service, 'FIRST');
    const started = Date.now();
    await complete(service, 'SECOND');
    ok(Date.now() - started >= 5_000, 'normal after_turn was not awaited');
    const log = await readLog(logPath);
    const after = log.filter((event) => event.phase === 'after_turn');
    strictEqual(after.length, 2);
    deepStrictEqual(after[1].turns, [1, 2]);
    ok(after[1].frozen);
    ok(after.every((event) => event.outcomeFrozen && event.mutationRejected));
    ok(after[1].shared);
    ok(String(after[1].contextText).includes('worker answer: SECOND'));
    strictEqual(after[1].finalText, 'worker answer: SECOND');
    deepStrictEqual(after[1].settlement, {
      accepted: true,
      adopted: true,
      durable: true,
      terminalOutcome: { ok: true, outcome: 'final', stopReason: 'final' },
      stateRevision: (await service.data.sessionDescriptor(sessionId)).stateRevision,
    });
    const observer = log.find((event) => event.phase === 'observer')!;
    strictEqual((observer.checkpoint as { summary: string }).summary, 'SUMMARY_A');
    deepStrictEqual(observer.retained, [2]);
    ok(observer.shared);
    const checkpoint = JSON.parse(new TextDecoder().decode(
      (await service.data.contextRead(sessionId)).bytes,
    )).context.checkpoint;
    ok(checkpoint, `checkpoint missing: ${workerErrors.join('; ')}`);
    strictEqual(checkpoint.summary, 'SUMMARY_B');
    await complete(service, 'THIRD');
    const third = (await readLog(logPath)).find((event) =>
      event.phase === 'before_turn' && event.turn === 3
    )!;
    deepStrictEqual(third.turns, [2]);
    deepStrictEqual(third.retained, [2]);
    strictEqual(third.nextTurn, 3);
    strictEqual(third.messageCount, 4);
    strictEqual((third.checkpoint as { summary: string }).summary, 'SUMMARY_B');
    const history = JSON.parse(new TextDecoder().decode(
      (await service.data.historyRead({
        sessionRef: sessionId,
        view: 'detail',
      })).bytes,
    )).text as string;
    ok(history.includes('worker answer: FIRST'));
    ok(history.includes('worker answer: SECOND'));
    ok(history.includes('after_turn failure marker'));
    await service.close();
    ok(
      String(
        (await readLog(logPath)).find((event) => event.phase === 'runtime_stop')!
          .contextText,
      ).includes('worker answer: THIRD'),
    );
    service = await createApplicationService({ ...options, persistence: 'session', sessionId });
    await complete(service, 'REOPENED');
    const reopened = (await readLog(logPath)).find((event) =>
      event.phase === 'before_turn' && event.turn === 4
    )!;
    deepStrictEqual(reopened.turns, [2, 3]);
    deepStrictEqual(reopened.retained, [2, 3]);
    strictEqual((reopened.checkpoint as { summary: string }).summary, 'SUMMARY_B');
  } finally {
    await service?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 189 headless root adopts its own context despite noncanonical settlement', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i189-headless-checkpoint-' });
  const { options, logPath, workerErrors } = await configure(root, 0);
  let service: Application | undefined;
  try {
    service = await createApplicationService({ ...options, persistence: 'none' });
    await complete(service, 'FIRST');
    await complete(service, 'SECOND');
    await complete(service, 'THIRD');
    const log = await readLog(logPath);
    const after = log.find((event) => event.phase === 'after_turn' && event.turn === 2)!;
    deepStrictEqual(after.settlement, {
      accepted: true,
      adopted: false,
      durable: true,
      terminalOutcome: { ok: true, outcome: 'final', stopReason: 'final' },
      stateRevision: (log.find((event) => event.phase === 'after_turn' && event.turn === 1)!
        .settlement as { stateRevision: number }).stateRevision + 1,
    });
    ok(after.outcomeFrozen && after.mutationRejected);
    const third = log.find((event) => event.phase === 'before_turn' && event.turn === 3)!;
    ok(third.checkpoint, `checkpoint missing: ${workerErrors.join('; ')}`);
    strictEqual((third.checkpoint as { summary: string }).summary, 'SUMMARY_B');
    deepStrictEqual(third.turns, [2]);
    deepStrictEqual(third.retained, [2]);
    strictEqual(third.nextTurn, 3);
    strictEqual(third.messageCount, 4);
  } finally {
    await service?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('Increment 218 restores a large saved checkpoint without spending the conversation budget', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-218-checkpoint-budget-' });
  const { options, logPath } = await configure(root, 0);
  const summary = 's'.repeat(12_000);
  await Deno.writeTextFile(
    `${options.configRoot}/hooks/observer.ts`,
    `export default () => ({ after_turn: ({ runtime }) => runtime.turnNumber === 2
      ? { checkpoint: { summary: ${JSON.stringify(summary)}, coveredThroughTurn: 1 } }
      : undefined });`,
  );
  await writeJson(`${options.configRoot}/context-budget.json`, {
    defaults: { historyTokens: 2000, inputTokens: 65_536 },
  });
  let service: Application | undefined;
  try {
    service = await createApplicationService({ ...options, persistence: 'new' });
    const sessionId = service.currentSession().sessionId;
    await complete(service, 'FIRST');
    await complete(service, 'SECOND');
    await service.close();
    service = await createApplicationService({ ...options, persistence: 'session', sessionId });
    await complete(service, 'REOPENED');
    const reopened = (await readLog(logPath)).find((event) =>
      event.phase === 'before_turn' && event.turn === 3
    )!;
    strictEqual((reopened.checkpoint as { summary: string }).summary, summary);
    deepStrictEqual(reopened.turns, [2]);
    const canonical = JSON.parse(new TextDecoder().decode(
      (await service.data.historyRead({ sessionRef: sessionId, view: 'canonical' })).bytes,
    )).text as string;
    ok(canonical.includes('worker answer: REOPENED'));
  } finally {
    await service?.close();
    await Deno.remove(root, { recursive: true });
  }
});
