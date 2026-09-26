import { WorkerHostSession } from '../../v0/agent/worker/worker_host_session.ts';
import { bundledToolDefinitionLoadRequests } from '../../v0/agent/worker/worker_definition_revision.ts';
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store_contract.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { WorkerCapsule } from '../../v0/agent/worker/worker_capsule.ts';
import { WorkerProcessOwner } from '../../v0/agent/worker/worker_process_owner.ts';
import { WorkerProcessExecutor } from '../../v0/agent/worker/worker_process_executor.ts';
import { createBashTool } from '../../v0/agent/tools/bash_tool.ts';
import { createBashOutputStore } from '../../v0/agent/tools/bash_output.ts';

const assert = (value: unknown, message = 'assertion failed'): void => {
  if (!value) throw new Error(message);
};
const equal = (actual: unknown, expected: unknown): void => {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
  );
};
const handle = (): WorkerSessionHandle => ({
  id: crypto.randomUUID(),
  commit: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});
const open = async (root: string, events: AgentEvent[] = [], onProcessStart?: () => void) =>
  await WorkerHostSession.open({
    handle: handle(),
    agent: 'default',
    definition: {
      schemaVersion: 1,
      resourceKind: 'agent-definition',
      resourceId: 'test/bash-lifetime',
      revision: { algorithm: 'sha256', digest: 'b'.repeat(64) },
    },
    modulePath: new URL('./fixtures/increment_133_bash_definition.ts', import.meta.url).pathname,
    workspaceRoot: root,
    physicalIoMode: 'provider-free',
    toolDefinitions: await bundledToolDefinitionLoadRequests(),
    cancelSettlementGraceMs: 2_000,
    eventSink: (event) => {
      events.push(event);
    },
    ...(onProcessStart === undefined ? {} : {
      capsuleFactory: (url: URL) => {
        const capsule = new WorkerCapsule(url);
        capsule.subscribe((message) => {
          if (message.kind === 'process_request' && message.request.action === 'start') {
            onProcessStart();
          }
        });
        return capsule;
      },
    }),
  });
const submit = async (session: WorkerHostSession, command: string, timeoutMs?: number) => {
  const outcome = await session.submit(
    JSON.stringify({
      name: 'bash',
      arguments: { command, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    }),
  );
  assert(outcome.ok, JSON.stringify(outcome));
  return JSON.parse(outcome.finalText!);
};
const waitFile = async (root: string, name: string): Promise<string> => {
  for (let i = 0; i < 300; i++) {
    try {
      const value = await Deno.readTextFile(`${root}/${name}`);
      if (value.length > 0) return value;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`command did not create ${name}`);
};
const alive = async (pid: string): Promise<boolean> =>
  (await new Deno.Command('/bin/bash', {
    args: [
      '-c',
      'if read -r stat < /proc/$1/stat; then rest=${stat##*) }; [[ ${rest%% *} != Z ]]; else exit 1; fi',
      'probe',
      pid,
    ],
    stdout: 'null',
    stderr: 'null',
  }).output()).success;
const resistant =
  "trap '' TERM; bash -c 'trap \"\" TERM; while :; do sleep 10; done' & printf '%s' $! > descendant; printf '%s' $$ > command; while :; do sleep 10; done";

Deno.test('bundled bash keeps fresh shell/status/output and later-turn bash_output readback', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-bash-' });
  const session = await open(root);
  try {
    const first = await submit(
      session,
      'export LOCAL=value; cd /; printf explicit-143; printf separate >&2; exit 143',
    );
    equal([first.stdout, first.stderr, first.exitCode, first.signal, first.timedOut], [
      'explicit-143',
      'separate',
      143,
      null,
      false,
    ]);
    const fresh = await submit(
      session,
      'pwd; printf "env=%s/%s/%s/local=%s/home=%s" "$PATH" "$LANG" "$LC_ALL" "${LOCAL-unset}" "${HOME-unset}"',
    );
    equal(
      fresh.stdout,
      `${root}\nenv=/usr/local/bin:/usr/bin:/bin/C.UTF-8/C.UTF-8/local=unset/home=unset`,
    );
    const signal = await submit(session, 'kill -TERM $$');
    equal([signal.exitCode, signal.signal], [null, 'SIGTERM']);
    const large = await submit(session, "printf '%05000d' 0");
    assert(large.stdoutTruncated && typeof large.outputId === 'string');
    const read = await session.submit(
      JSON.stringify({
        name: 'bash_output',
        arguments: { outputId: large.outputId, stream: 'stdout', offset: 4096 },
      }),
    );
    assert(read.ok, JSON.stringify(read));
    const window = JSON.parse(read.finalText!);
    equal([window.text.length, window.complete], [904, true]);
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('bundled bash stops capture/progress after return and retains background writers until close', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-bash-background-' });
  const events: AgentEvent[] = [];
  const session = await open(root, events);
  try {
    const result = await submit(
      session,
      '(sleep .6; head -c 1048576 /dev/zero; printf done > done; sleep 60) & printf "%s" $! > background; printf initial',
    );
    equal([result.stdout, result.exitCode], ['initial', 0]);
    const progress = events.filter((event) => event.kind === 'tool_progress').length;
    await waitFile(root, 'done');
    equal(events.filter((event) => event.kind === 'tool_progress').length, progress);
    const background = await waitFile(root, 'background');
    assert(await alive(background));
    await session.close();
    assert(!await alive(background), 'close retained background group');
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('bundled bash timeout cleans TERM-resistant command and descendants before returning status', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-bash-timeout-' });
  const session = await open(root);
  try {
    const result = await submit(session, resistant, 500);
    equal([result.timedOut, result.exitCode, result.signal], [true, null, 'SIGKILL']);
    assert(!await alive(await waitFile(root, 'command')));
    assert(!await alive(await waitFile(root, 'descendant')));
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('bundled bash cancellation settles after command/group cleanup', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-bash-cancel-' });
  const session = await open(root);
  try {
    const submitted = session.submit(
      JSON.stringify({ name: 'bash', arguments: { command: resistant, timeoutMs: 5_000 } }),
    );
    const command = await waitFile(root, 'command');
    const descendant = await waitFile(root, 'descendant');
    session.cancelActiveTurn();
    const outcome = await submitted;
    assert(!outcome.ok && outcome.stopReason === 'cancelled', JSON.stringify(outcome));
    assert(!await alive(command));
    assert(!await alive(descendant));
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('bundled bash cancellation at process start permits the next turn and preserves prior background work', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-bash-start-cancel-' });
  let cancelStart = false;
  const session = await open(root, [], () => {
    if (!cancelStart) return;
    cancelStart = false;
    queueMicrotask(() => session.cancelActiveTurn());
  });
  try {
    await submit(session, 'sleep 60 & printf %s $! > background; printf ready');
    const background = await waitFile(root, 'background');
    cancelStart = true;
    const outcome = await session.submit(
      JSON.stringify({ name: 'bash', arguments: { command: 'sleep 10' } }),
    );
    assert(!outcome.ok && outcome.stopReason === 'cancelled', JSON.stringify(outcome));
    assert(await alive(background), 'early cancellation stopped prior background work');
    equal((await submit(session, 'printf next')).stdout, 'next');
  } finally {
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('cancelled bash calls release Host records while prior background work remains owned', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-bash-records-' });
  const correlation = {
    session: 'records',
    instanceCorrelation: 'records',
    workerGeneration: 'records',
    command: 'turn',
    baseStateRevision: 1,
  };
  let executionId = 'background';
  const owner = new WorkerProcessOwner((reply) => queueMicrotask(() => proxy.receive(reply)));
  const proxy = new WorkerProcessExecutor((message) => {
    void owner.handle(message);
  }, () => ({ correlation, executionId }));
  const store = createBashOutputStore();
  const tool = createBashTool({ root }, proxy, store);
  // Inspect the actual ownership records without adding a test-only production API.
  const records = (owner as unknown as { operations: Map<string, unknown> }).operations;
  try {
    await tool.execute({ command: 'sleep 60 & printf %s $! > background' });
    const background = await waitFile(root, 'background');
    equal(records.size, 1);
    for (let index = 0; index < 3; index++) {
      executionId = `cancel-${index}`;
      const controller = new AbortController();
      const result = Promise.resolve(tool.execute({
        command: `printf ready > ready-${index}; sleep 10`,
      }, { signal: controller.signal, callId: executionId })).catch((error) => error.name);
      await waitFile(root, `ready-${index}`);
      const cleanup = owner.cancelExecution(executionId);
      controller.abort();
      equal(await result, 'TurnCancelledError');
      await cleanup;
      owner.finishExecution(executionId);
      equal(records.size, 1);
      assert(await alive(background));
    }
    await owner.close();
    equal(records.size, 0);
    assert(!await alive(background));
  } finally {
    await proxy.close();
    await owner.close();
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('a rejected process cleanup still releases the Session busy state', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-i133-bash-cleanup-rejection-' });
  const session = await open(root);
  const supervisor = (session as unknown as {
    coordinator: { supervisor: { waitForProcessCleanup(id?: string): Promise<void> } };
  }).coordinator.supervisor;
  const originalWait = supervisor.waitForProcessCleanup.bind(supervisor);
  try {
    // Reproduce the rejected cleanup wait observed in the start-cancel review probe.
    // Physical cleanup still completes; only its reported result is replaced.
    supervisor.waitForProcessCleanup = async (id) => {
      await originalWait(id);
      throw new Error('observed process cleanup rejection');
    };
    let rejected = false;
    try {
      await submit(session, 'printf first');
    } catch (error) {
      rejected = error instanceof Error && error.message === 'observed process cleanup rejection';
    }
    assert(rejected);
    supervisor.waitForProcessCleanup = originalWait;
    equal((await submit(session, 'printf next')).stdout, 'next');
  } finally {
    supervisor.waitForProcessCleanup = originalWait;
    await session.close();
    await Deno.remove(root, { recursive: true });
  }
});
