import {
  readWorkerModuleRevision,
  WorkerCapsule,
  workerTextByteLength,
} from '../../v0/agent/worker/worker_capsule.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerClosedMessage,
  WorkerCommitProposalMessage,
  WorkerErrorMessage,
  WorkerHostCommand,
  WorkerReadyMessage,
  WorkerRuntimeEventMessage,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import type { AssistantMessage, Message } from '../../v0/agent/core/contracts.ts';
import type {
  Model,
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
} from '../../v0/agent/core/contracts.ts';
import type { AgentEvent } from '../../v0/agent/core/events.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import {
  DenoSessionStore,
  sessionPaths,
  validateSessionRecordV6,
  type WorkerSessionHandle,
} from '../../v0/agent/session/session_store.ts';
import { FakeProviderEvidenceStore } from '../../v0/agent/provider/provider_evidence.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import {
  createWorkerTuiSession,
  readDefinitionRevision,
  workerBuiltinModulePath,
  type WorkerHostCapsule,
  WorkerHostSession,
} from '../../v0/agent/worker/worker_host.ts';
import { runHeadlessWorker } from '../../v0/agent/worker/worker_headless_runner.ts';
import { resolveBuiltinAgent } from '../../v0/agent/definitions/agent_catalog.ts';
import { main as runtimeCliMain } from '../../v0/agent/cli/runtime_cli.ts';
import { parseTuiInvocation } from '../../v0/agent/cli/tui_cli.ts';
import { createTuiPresentationAdapter } from '../../v0/presentation/adapter.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import {
  DenoWorkerExecutionArtifactStore,
  FakeWorkerExecutionArtifactStore,
} from '../../v0/agent/worker/worker_execution_artifact_store.ts';
import {
  main as failureDiagnosticMain,
  parseFailureDiagnosticArgs,
} from '../../v0/agent/cli/failure_diagnostic_cli.ts';
import {
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
} from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { OpenRouterAgentError } from '../../v0/agent/provider/openrouter_model.ts';
import { validateFailureDiagnostic } from '../../v0/agent/session/failure_diagnostic.ts';
import { presentationFailureReason } from '../../v0/tui/state.ts';
import { SqliteHistoryStore } from '../../v0/agent/history/sqlite_history_store.ts';

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

const workerUrl = new URL(
  '../../v0/agent/worker/worker_bootstrap.ts',
  import.meta.url,
);
const fixture = (name: string): string =>
  new URL(`../../v0/agent/worker/fixtures/${name}`, import.meta.url).pathname;

const correlation = (command: string) => ({
  session: 'worker-probe-session',
  instanceCorrelation: 'worker-probe-instance',
  workerGeneration: 'worker-probe-generation',
  baseStateRevision: 1,
  command,
});
const compactionCorrelation = (command: string) => ({
  session: '11111111-1111-4111-8111-111111111111',
  instanceCorrelation: '22222222-2222-4222-8222-222222222222',
  workerGeneration: '33333333-3333-4333-8333-333333333333',
  baseStateRevision: 1,
  command,
});

const isReady = (message: WorkerToHostMessage): message is WorkerReadyMessage =>
  message.kind === 'ready';
const isRuntime = (
  message: WorkerToHostMessage,
): message is WorkerRuntimeEventMessage => message.kind === 'runtime_event';
const isClosed = (
  message: WorkerToHostMessage,
): message is WorkerClosedMessage => message.kind === 'closed';
const isError = (message: WorkerToHostMessage): message is WorkerErrorMessage =>
  message.kind === 'worker_error';
const isCommitProposal = (
  message: WorkerToHostMessage,
): message is WorkerCommitProposalMessage => message.kind === 'commit_proposal';
const isTerminalAgentRuntime = (
  message: WorkerToHostMessage,
): message is WorkerRuntimeEventMessage =>
  message.kind === 'runtime_event' && message.event.kind === 'agent_event' &&
  message.event.event.kind === 'turn_end';
type TextAssistantMessage = AssistantMessage & {
  readonly content: { readonly kind: 'text'; readonly text: string };
};
const isTextAssistant = (message: Message): message is TextAssistantMessage =>
  message.role === 'assistant' && !Array.isArray(message.content);

const start = async (
  capsule: WorkerCapsule,
  command = 'start',
): Promise<WorkerReadyMessage> => {
  const readyPromise = capsule.waitForMessage(isReady);
  capsule.send({ kind: 'start', correlation: correlation(command) });
  return await readyPromise;
};

const textStream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const successfulHeadlessRun = (task: string) =>
  Promise.resolve({
    outcome: {
      ok: true as const,
      task,
      outcome: 'final' as const,
      stopReason: 'final' as const,
      finalText: 'headless answer',
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    },
    requestCount: 1,
  });

Deno.test('Slice 1 starts a module Worker and preserves protocol ordering and clone isolation', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    await start(capsule);
    const original = { nested: { value: 'host-owned' } };
    capsule.send({
      kind: 'echo',
      correlation: correlation('echo'),
      payload: original,
    });
    const echo = await capsule.waitForMessage(isRuntime);
    assert(echo.event.kind === 'echo');
    assertEquals(original, { nested: { value: 'host-owned' } });
    assertEquals(echo.event.payload, {
      nested: { value: 'host-owned' },
      workerMutated: true,
    });

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      capsule.send({
        kind: 'ordered',
        correlation: correlation(`ordered-${sequence}`),
        sequence,
      });
    }
    const observed: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const event = await capsule.waitForMessage(isRuntime);
      assert(event.event.kind === 'ordered');
      observed.push(event.event.sequence);
    }
    assertEquals(observed, [1, 2, 3, 4, 5]);
  } finally {
    capsule.terminate();
  }
});

Deno.test('Slice 1 proves pre-read/hash, digest-query relative import, import-map alias, and default export', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    const revision = await readWorkerModuleRevision(
      fixture('external_definition.ts'),
    );
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: correlation('module-start'),
      module: revision,
    });
    const preRead = await capsule.waitForMessage(isRuntime);
    assert(preRead.event.kind === 'module_pre_read');
    assertEquals(
      { bytes: preRead.event.sourceBytes, digest: preRead.event.entrySha256 },
      { bytes: revision.sourceBytes, digest: revision.entrySha256 },
    );
    const importStart = await capsule.waitForMessage(isRuntime);
    assert(importStart.event.kind === 'module_import_start');
    const imported = await capsule.waitForMessage(isRuntime);
    assert(imported.event.kind === 'module_imported');
    const ready = await readyPromise;
    assertEquals(ready.module, {
      canonicalSpecifier: revision.canonicalSpecifier,
      entrySha256: revision.entrySha256,
      sourceBytes: revision.sourceBytes,
      defaultExport: 'function',
      probe: 'slice1-data-only-v1:relative-import-ok',
    });
  } finally {
    capsule.terminate();
  }
});

Deno.test('headless runner commits one real Worker turn and closes the generation', async () => {
  const artifacts = new FakeWorkerExecutionArtifactStore();
  let closed = false;
  const result = await runHeadlessWorker(
    'read worker protocol',
    resolveBuiltinAgent(),
    {
      physicalIoMode: 'provider-free',
      executionArtifactStore: artifacts,
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        return {
          send: (command) => capsule.send(command),
          subscribe: (listener) =>
            capsule.subscribe((message) => {
              if (message.kind === 'closed') closed = true;
              listener(message);
            }),
          terminate: () => capsule.terminate(),
        };
      },
    },
  );
  assert(result.outcome.ok);
  assertEquals(result.outcome.stopReason, 'final');
  assertEquals(result.requestCount, 0);
  assertEquals(closed, true);
  const written = await artifacts.list();
  assertEquals(written.length, 1);
  assertEquals(written[0]?.storeResult, 'committed');
  assertEquals(written[0]?.acknowledgement, 'accepted_sent');
  assert(
    written[0]?.protocolTrace.some((entry) => entry.semanticSubtype === 'module_pre_read'),
  );
  assert(
    written[0]?.protocolTrace.some((entry) => entry.semanticSubtype === 'commit_proposal'),
  );
});

Deno.test('headless Worker model receives each active tool guideline once', async () => {
  const result = await runHeadlessWorker(
    'return active tool guidelines',
    resolveBuiltinAgent(),
    { physicalIoMode: 'provider-free' },
  );
  assert(result.outcome.ok);
  const instruction = result.outcome.finalText ?? '';
  assert(instruction.includes('## Active tool guidelines'));
  for (const tool of ['bash_output', 'read', 'web_search']) {
    assertEquals(instruction.match(new RegExp(`- ${tool}:`, 'g'))?.length, 1);
  }
});

Deno.test('headless runner persists execution evidence without a Session transcript', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-headless-state-' });
  await Deno.chmod(stateRoot, 0o700);
  try {
    const result = await runHeadlessWorker(
      'headless artifact turn',
      resolveBuiltinAgent(),
      { physicalIoMode: 'provider-free', stateRoot },
    );
    assert(result.outcome.ok);
    assertEquals(result.outcome.executionArtifactDurability, 'yes');
    const paths = await sessionPaths(stateRoot, Deno.cwd());
    let sessionDirectoryExists = true;
    try {
      await Deno.lstat(paths.sessions);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      sessionDirectoryExists = false;
    }
    assertEquals(sessionDirectoryExists, false);
    const artifacts = await new DenoWorkerExecutionArtifactStore(stateRoot, Deno.cwd()).list();
    assertEquals(artifacts.length, 1);
    assertEquals(artifacts[0]?.settlement, 'committed');
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('runtime CLI preserves argv/stdin selection and final-only channels', async () => {
  const observed: Array<{ task: string; agent: string }> = [];
  let stdout = '';
  let stderr = '';
  const argvExit = await runtimeCliMain(
    ['--agent', 'planner', '--task', '  plan this  '],
    {
      stdinIsTerminal: () => true,
      run: (task, selection) => {
        observed.push({ task, agent: selection.id });
        return successfulHeadlessRun(task);
      },
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    },
  );
  assertEquals({ argvExit, stdout, stderr }, {
    argvExit: 0,
    stdout: 'headless answer\n',
    stderr: '',
  });

  stdout = '';
  const stdinExit = await runtimeCliMain([], {
    stdinIsTerminal: () => false,
    stdin: textStream('  stdin task\n'),
    run: (task, selection) => {
      observed.push({ task, agent: selection.id });
      return successfulHeadlessRun(task);
    },
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(stdinExit, 0);
  assertEquals(stdout, 'headless answer\n');
  assertEquals(observed, [
    { task: 'plan this', agent: 'planner' },
    { task: 'stdin task', agent: 'default' },
  ]);
});

Deno.test('runtime CLI preserves max-step failure JSON and exit code', async () => {
  let stdout = '';
  let stderr = '';
  const exit = await runtimeCliMain(['--task', 'bounded task'], {
    stdinIsTerminal: () => true,
    run: (task) =>
      Promise.resolve({
        outcome: {
          ok: false,
          task,
          outcome: 'max_steps',
          stopReason: 'max_steps',
          error: 'maximum model steps reached',
          steps: 64,
          toolCallCount: 63,
          toolResultCount: 63,
          transcript: [],
        },
        requestCount: 64,
      }),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  assertEquals(exit, 1);
  assertEquals(stdout, '');
  assertEquals(JSON.parse(stderr), {
    ok: false,
    outcome: 'max_steps',
    stopReason: 'max_steps',
    steps: 64,
    toolCallCount: 63,
    toolResultCount: 63,
    requestCount: 64,
    error: { code: 'max_steps', message: 'agent request limit reached' },
  });
});

Deno.test('headless development task uses the unified TypeScript entry', async () => {
  const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
    readonly tasks: Record<string, string>;
  };
  const task = config.tasks['agent:run'];
  assert(task.includes('v0/agent/cli/henji_cli.ts run'));
  assert(task.includes('--unstable-worker-options'));
  assert(task.includes('--allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME'));
  assert(!task.includes('runtime_cli_launcher.sh'));
  assert(!task.includes('HENJI_SESSION_STATE_ROOT'));
});

Deno.test('Slice 1 rejects a non-function default export and reports a Worker command error', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    const revision = await readWorkerModuleRevision(
      fixture('invalid_default.ts'),
    );
    const errorPromise = capsule.waitForMessage(isError);
    capsule.send({
      kind: 'start',
      correlation: correlation('invalid-default'),
      module: revision,
    });
    const error = await errorPromise;
    assertEquals(
      { stage: error.stage, message: error.message },
      {
        stage: 'module_validation',
        message: 'module default export must be a function',
      },
    );
  } finally {
    capsule.terminate();
  }
});

Deno.test('Slice 1 transfers 300 KiB regression data and a 1 MiB data-only payload', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    await start(capsule);
    for (const size of [300_000, 1_048_576]) {
      const payload = 'x'.repeat(size);
      capsule.send({
        kind: 'large_transfer',
        correlation: correlation(`large-${size}`),
        payload,
      });
      const message = await capsule.waitForMessage(isRuntime);
      assert(message.event.kind === 'large_transfer');
      assertEquals(message.event.byteLength, workerTextByteLength(payload));
      assertEquals(message.event.payload.length, payload.length);
    }
  } finally {
    capsule.terminate();
  }
});

Deno.test('Slice 1 observes DataCloneError, Worker-originated error, cooperative close, and forced terminate', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    await start(capsule);
    let cloneError: unknown;
    try {
      capsule.postRawForProbe(() => 'not cloneable');
    } catch (error) {
      cloneError = error;
    }
    assert(cloneError instanceof DOMException);
    assertEquals((cloneError as DOMException).name, 'DataCloneError');

    const errorPromise = capsule.waitForMessage(isError);
    capsule.send({
      kind: 'worker_error',
      correlation: correlation('worker-error'),
    });
    const error = await errorPromise;
    assertEquals(error.stage, 'worker_command');

    const closedPromise = capsule.waitForMessage(isClosed);
    capsule.send({ kind: 'close', correlation: correlation('close') });
    const closed = await closedPromise;
    assertEquals(closed.correlation.command, 'close');
    assertEquals(capsule.status, 'closed');
  } finally {
    capsule.terminate();
  }

  const forced = new WorkerCapsule(workerUrl);
  try {
    await start(forced, 'forced-start');
    forced.terminate();
    assertEquals(forced.status, 'terminated');
  } finally {
    forced.terminate();
  }
});

Deno.test('Slice 1 observes Worker permission narrowing without changing the production launcher', async () => {
  const capsule = new WorkerCapsule(workerUrl, { permissions: 'none' });
  try {
    await start(capsule, 'permission-start');
    capsule.send({
      kind: 'permission',
      correlation: correlation('permission'),
      readSpecifier: new URL('../../v0/agent/worker/worker_protocol.ts', import.meta.url).href,
      envKey: 'HOME',
    });
    const message = await capsule.waitForMessage(isRuntime);
    assert(message.event.kind === 'permission');
    assertEquals(
      { read: message.event.read, environment: message.event.environment },
      { read: 'denied', environment: 'denied' },
    );
  } finally {
    capsule.terminate();
  }
});

Deno.test('Slice 1 reports an uncaught Worker error through the Host bridge', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    await start(capsule, 'uncaught-start');
    const errorPromise = capsule.waitForMessage(isError);
    capsule.send({
      kind: 'uncaught_error',
      correlation: correlation('uncaught'),
    });
    const error = await errorPromise;
    assertEquals(error.stage, 'uncaught');
    assert(error.message.includes('Worker'));
  } finally {
    capsule.terminate();
  }
});

const runCompositionTurn = async (
  definitionFile: string,
  expectedMaxSteps: number,
  rootMaxSteps?: number,
): Promise<WorkerReadyMessage> => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    const definitionPath = definitionFile === 'worker_builtin_definition.ts'
      ? new URL('../../v0/agent/worker/worker_builtin_definition.ts', import.meta.url)
        .pathname
      : fixture(definitionFile);
    const revision = await readWorkerModuleRevision(definitionPath);
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: correlation(`composition-${definitionFile}`),
      module: revision,
      workspaceRoot: Deno.cwd(),
      ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
    });
    const ready = await readyPromise;
    assert(ready.manifest !== undefined);
    assertEquals(ready.credentialAvailability, {
      authProfile: ready.manifest.rootModel.authProfile,
      status: 'unknown',
    });
    assertEquals(ready.manifest.maxSteps, expectedMaxSteps);
    assertEquals(ready.manifest.role, 'parent');

    capsule.send({
      kind: 'turn',
      correlation: correlation(`turn-${definitionFile}`),
      task: 'read worker protocol',
    });
    const proposal = await capsule.waitForMessage(isCommitProposal);
    assertEquals(proposal.transcript.at(-1)?.role, 'assistant');
    assert(
      proposal.transcript.some((message) =>
        isTextAssistant(message) &&
        message.content.kind === 'text' &&
        message.content.text.includes('worker answer: read worker protocol')
      ),
    );
    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: proposal.correlation,
      accepted: true,
    });
    const terminal = await capsule.waitForMessage(isTerminalAgentRuntime);
    assert(terminal.event.kind === 'agent_event');
    assertEquals(terminal.event.event.kind, 'turn_end');
    if (terminal.event.event.kind !== 'turn_end') {
      throw new Error('turn did not end');
    }
    assertEquals(terminal.event.event.committed, true);
    await capsule.close(correlation(`close-${definitionFile}`));
    return ready;
  } finally {
    capsule.terminate();
  }
};

Deno.test('Slices 2–3 run built-in and external Definitions through the same Worker composition path', async () => {
  const builtin = await runCompositionTurn('worker_builtin_definition.ts', 64);
  const external = await runCompositionTurn('external_definition.ts', 4);
  assert(builtin.manifest !== undefined && external.manifest !== undefined);
  assertEquals(builtin.manifest.resources, external.manifest.resources);
});

Deno.test('Worker applies a root maxSteps request to built-in and external Definitions', async () => {
  const builtin = await runCompositionTurn('worker_builtin_definition.ts', 12, 12);
  const external = await runCompositionTurn('external_definition.ts', 12, 12);
  assertEquals(builtin.manifest?.maxSteps, 12);
  assertEquals(external.manifest?.maxSteps, 12);

  const plannerCapsule = new WorkerCapsule(workerUrl);
  try {
    const revision = await readWorkerModuleRevision(workerBuiltinModulePath('planner'));
    const readyPromise = plannerCapsule.waitForMessage(isReady);
    plannerCapsule.send({
      kind: 'start',
      correlation: correlation('planner-root-override'),
      module: revision,
      workspaceRoot: Deno.cwd(),
      rootMaxSteps: 12,
    });
    const planner = await readyPromise;
    assertEquals(planner.manifest?.role, 'planner');
    assertEquals(planner.manifest?.maxSteps, 12);
  } finally {
    plannerCapsule.terminate();
  }
});

Deno.test('Worker uses the requested root maxSteps as the turn budget', async () => {
  const created = await createWorkerTuiSession({
    persistence: 'none',
    agent: 'default',
    rootMaxSteps: 1,
    physicalIoMode: 'provider-free',
  });
  try {
    const outcome = await created.session.submit('read worker protocol');
    assert(!outcome.ok);
    assertEquals({ stopReason: outcome.stopReason, steps: outcome.steps }, {
      stopReason: 'max_steps',
      steps: 1,
    });
  } finally {
    await created.close();
  }
});

Deno.test('Worker root request admission follows maxSteps beyond the former eight-step ceiling', async () => {
  const created = await createWorkerTuiSession({
    persistence: 'none',
    agent: 'default',
    rootMaxSteps: 10,
    physicalIoMode: 'provider-free',
  });
  try {
    const outcome = await created.session.submit('ten-step worker turn');
    assert(outcome.ok);
    assertEquals({ stopReason: outcome.stopReason, steps: outcome.steps }, {
      stopReason: 'final',
      steps: 10,
    });
  } finally {
    await created.close();
  }
});

Deno.test('root maxSteps override does not reduce the delegated planner 64-step budget', async () => {
  const created = await createWorkerTuiSession({
    persistence: 'none',
    agent: 'default',
    rootMaxSteps: 2,
    physicalIoMode: 'provider-free',
  });
  try {
    const outcome = await created.session.submit('delegate-long planner turn');
    assert(outcome.ok);
    assertEquals({ stopReason: outcome.stopReason, steps: outcome.steps }, {
      stopReason: 'final',
      steps: 2,
    });
  } finally {
    await created.close();
  }
});

Deno.test('Slice 3 keeps planner, effect, and cancellation semantics inside the Worker generation', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    const revision = await readWorkerModuleRevision(
      new URL('../../v0/agent/worker/worker_builtin_definition.ts', import.meta.url)
        .pathname,
    );
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: correlation('planner-start'),
      module: revision,
      workspaceRoot: Deno.cwd(),
    });
    await readyPromise;

    capsule.send({
      kind: 'turn',
      correlation: correlation('planner-turn'),
      task: 'delegate planner',
    });
    const effect = await capsule.waitForMessage((message): message is Extract<
      WorkerToHostMessage,
      { kind: 'effect_observation' }
    > => message.kind === 'effect_observation');
    assertEquals(effect.effect.kind, 'tool_call');
    if (effect.effect.kind !== 'tool_call') {
      throw new Error('expected tool call');
    }
    assertEquals(effect.effect.call.name, 'delegate_to_planner');
    const proposal = await capsule.waitForMessage(isCommitProposal);
    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: proposal.correlation,
      accepted: true,
    });
    await capsule.waitForMessage(isTerminalAgentRuntime);
    assert(
      proposal.transcript.some((message) =>
        message.role === 'tool' &&
        message.content.some((item) => item.text.includes('worker planner result'))
      ),
    );

    capsule.send({
      kind: 'turn',
      correlation: correlation('cancel-turn'),
      task: 'slow cancellation turn',
    });
    capsule.send({
      kind: 'cancel',
      correlation: correlation('cancel-command'),
    });
    const failed = await capsule.waitForMessage((message): message is Extract<
      WorkerToHostMessage,
      { kind: 'turn_failed' }
    > => message.kind === 'turn_failed');
    assertEquals(failed.outcome.stopReason, 'cancelled');
    assert(!failed.outcome.ok);
  } finally {
    capsule.terminate();
  }
});

Deno.test('Slice 3 sends long user turns directly to commit without checkpoint proposals', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  const sessionCorrelation = compactionCorrelation('compaction-start');
  try {
    const revision = await readWorkerModuleRevision(
      new URL('../../v0/agent/worker/worker_builtin_definition.ts', import.meta.url)
        .pathname,
    );
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: sessionCorrelation,
      module: revision,
      workspaceRoot: Deno.cwd(),
    });
    await readyPromise;

    const commitTurn = async (command: string, task: string): Promise<void> => {
      capsule.send({
        kind: 'turn',
        correlation: compactionCorrelation(command),
        task,
      });
      const proposal = await capsule.waitForMessage(isCommitProposal);
      capsule.send({
        kind: 'commit_acknowledgement',
        correlation: proposal.correlation,
        accepted: true,
      });
      const terminal = await capsule.waitForMessage(isTerminalAgentRuntime);
      assert(terminal.event.kind === 'agent_event');
      if (terminal.event.event.kind !== 'turn_end') {
        throw new Error('turn did not end');
      }
      assertEquals(terminal.event.event.committed, true);
    };
    await commitTurn('compaction-turn-1', `first ${'x'.repeat(30_000)}`);
    await commitTurn('compaction-turn-2', `second ${'y'.repeat(30_000)}`);

    const heldText = 'held user turn after checkpoint';
    capsule.send({
      kind: 'turn',
      correlation: compactionCorrelation('compaction-turn-3'),
      task: heldText,
    });
    const proposal = await capsule.waitForMessage(isCommitProposal);
    assert(
      proposal.transcript.some((message) =>
        isTextAssistant(message) && message.content.text.includes(heldText)
      ),
    );
    assert(
      proposal.transcript.some((message) =>
        message.role === 'user' && message.content.text.includes('x'.repeat(30_000))
      ),
    );
    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: proposal.correlation,
      accepted: true,
    });
    const terminal = await capsule.waitForMessage(isTerminalAgentRuntime);
    assert(terminal.event.kind === 'agent_event');
    if (terminal.event.event.kind !== 'turn_end') {
      throw new Error('turn did not end');
    }
    assertEquals(terminal.event.event.committed, true);
  } finally {
    capsule.terminate();
  }
});

Deno.test('Long Worker history records only the admitted user-turn request', async () => {
  type FailedTurn = {
    readonly outcome: import('../../v0/agent/core/contracts.ts').LoopOutcome;
    readonly evidence: import('../../v0/agent/provider/provider_evidence.ts').ProviderEvidenceV1;
  };
  const initialTranscript: Message[] = [];
  for (let turn = 1; turn <= 2; turn += 1) {
    initialTranscript.push({
      role: 'user',
      content: { kind: 'text', text: `old task ${turn}` },
    });
    initialTranscript.push({
      role: 'assistant',
      content: { kind: 'text', text: `${'old answer '.repeat(20_000)}${turn}` },
    });
  }

  const run = async (checkpointAccepted: boolean): Promise<{
    readonly proposal?: WorkerCommitProposalMessage;
    readonly failed?: FailedTurn;
    readonly checkpoint?: WorkerCheckpointProposalMessage;
    readonly requestCount: number;
  }> => {
    let requestCount = 0;
    let proposal: WorkerCommitProposalMessage | undefined;
    let failed: FailedTurn | undefined;
    let checkpoint: WorkerCheckpointProposalMessage | undefined;
    const model: Model = {
      generate(
        _request: ModelRequest,
        options: ModelGenerateOptions = {},
      ): ModelResult {
        requestCount += 1;
        options.providerEvidence?.startRequest({
          lane: options.providerEvidenceLane ?? 'parent',
          phase: options.providerEvidencePhase ?? 'user_turn',
          modelStep: options.modelStep ?? 1,
          endpoint: 'provider-free://counter-boundary',
          method: 'POST',
          requestBody: '{}',
          requestMetadata: {
            contentType: 'application/json',
            responseMode: 'json',
          },
        });
        return options.providerEvidencePhase === 'compaction'
          ? {
            kind: 'final',
            text: '{"schemaVersion":1,"summary":"retained context"}',
          }
          : { kind: 'final', text: 'user turn completed' };
      },
    };
    const composition = {
      role: 'parent',
      model,
      registry: new Registry([]),
      maxSteps: 2,
      systemInstruction: undefined,
      manifest: {
        role: 'parent',
        maxSteps: 2,
        profileId: 'provider-free-counter-boundary',
        resources: [],
      },
      resolved: {
        model: { profile: { id: 'provider-free-counter-boundary' } },
      },
    } as unknown as WorkerAgentComposition;
    const counter = {
      increment: () => {},
      count: () => requestCount,
    };
    const port: WorkerGenerationPort = {
      runtimeEvent: () => {},
      effectObservation: () => {},
      checkpointProposal: (_correlation, value) => {
        checkpoint = value;
        return Promise.resolve(checkpointAccepted);
      },
      commitProposal: (_correlation, value) => {
        proposal = value;
        return Promise.resolve(true);
      },
      turnFailed: (_correlation, outcome, evidence) => {
        if (evidence === undefined) {
          throw new Error('missing provider evidence');
        }
        failed = { outcome, evidence };
      },
    };
    const generation = new WorkerGeneration(
      composition,
      compactionCorrelation('counter-boundary-session').session,
      port,
      initialTranscript,
      3,
      undefined,
      counter,
    );
    await generation.runTurn(
      compactionCorrelation(`counter-boundary-${checkpointAccepted}`),
      'held user turn',
    );
    return { proposal, failed, checkpoint, requestCount };
  };

  const accepted = await run(true);
  assertEquals(accepted.checkpoint, undefined);
  assert(accepted.proposal?.outcome !== undefined);
  assertEquals(accepted.requestCount, 1);
  assertEquals(accepted.proposal.outcome.turnProviderRequestCount, 1);
  assertEquals(accepted.proposal.outcome.runtimeProviderRequestCount, 1);
  assertEquals(
    accepted.proposal.providerEvidence?.requests.map((record) => record.request.phase),
    ['user_turn'],
  );
});

Deno.test('Provider timeout on long history is attributed to the admitted user turn', async () => {
  const initialTranscript: Message[] = [];
  for (let turn = 1; turn <= 2; turn += 1) {
    initialTranscript.push({
      role: 'user',
      content: { kind: 'text', text: `old task ${turn}` },
    });
    initialTranscript.push({
      role: 'assistant',
      content: { kind: 'text', text: `${'old answer '.repeat(20_000)}${turn}` },
    });
  }

  let physicalRequests = 0;
  const counter = {
    increment: () => {
      physicalRequests += 1;
    },
    count: () => physicalRequests,
  };
  const model: Model = {
    generate(_request, options = {}) {
      counter.increment();
      options.providerEvidence?.startRequest({
        lane: options.providerEvidenceLane ?? 'parent',
        phase: options.providerEvidencePhase ?? 'user_turn',
        modelStep: options.modelStep ?? 1,
        endpoint: 'provider-free://compaction-timeout',
        method: 'POST',
        requestBody: '{}',
        requestMetadata: {
          contentType: 'application/json',
          responseMode: 'json',
        },
      });
      throw new OpenRouterAgentError(
        'provider_timeout',
        'provider deadline exceeded',
        1,
      );
    },
  };
  const composition = {
    role: 'parent',
    model,
    registry: new Registry([]),
    maxSteps: 2,
    systemInstruction: undefined,
    manifest: {
      role: 'parent',
      maxSteps: 2,
      profileId: 'provider-free-compaction-timeout',
      resources: [],
    },
    resolved: {
      model: { profile: { id: 'provider-free-compaction-timeout' } },
    },
  } as unknown as WorkerAgentComposition;
  let failed:
    | {
      readonly outcome: import('../../v0/agent/core/contracts.ts').LoopOutcome;
      readonly evidence: import('../../v0/agent/provider/provider_evidence.ts').ProviderEvidenceV1;
    }
    | undefined;
  const port: WorkerGenerationPort = {
    runtimeEvent: () => {},
    effectObservation: () => {},
    checkpointProposal: () => {
      throw new Error('timeout compaction must not propose a checkpoint');
    },
    commitProposal: () => {
      throw new Error('timeout compaction must not propose a turn commit');
    },
    turnFailed: (_correlation, outcome, evidence) => {
      if (evidence === undefined) throw new Error('missing provider evidence');
      failed = { outcome, evidence };
    },
  };
  const generation = new WorkerGeneration(
    composition,
    compactionCorrelation('compaction-timeout-session').session,
    port,
    initialTranscript,
    3,
    undefined,
    counter,
  );

  await generation.runTurn(
    compactionCorrelation('compaction-timeout-turn'),
    'held user turn',
  );

  assert(failed !== undefined);
  const diagnostic = failed.outcome.diagnostic;
  assert(diagnostic !== undefined);
  assert(validateFailureDiagnostic(diagnostic));
  assertEquals(diagnostic.stage, 'transport');
  assertEquals(diagnostic.code, 'provider_timeout');
  assertEquals(diagnostic.lane, 'parent');
  assertEquals(diagnostic.providerRequestCount, 1);
  assertEquals(diagnostic.retryCount, 0);
  assertEquals(diagnostic.modelStep, 1);
  assertEquals(failed.outcome.turnProviderRequestCount, 1);
  assertEquals(failed.outcome.runtimeProviderRequestCount, 1);
  assertEquals(presentationFailureReason(diagnostic), 'provider deadline exceeded');
  assertEquals(failed.evidence.requests.map((record) => record.request.phase), ['user_turn']);
  assertEquals(failed.evidence.diagnosticId, diagnostic.diagnosticId);
});

Deno.test('Slices 4–6 commit Worker proposals durably and reopen built-in bindings', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-host-' });
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocateWorker('default', definition);
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
    });
    const outcome = await host.submit('read worker protocol');
    assert(outcome.ok);
    assertEquals(host.currentPosition().committedTurn, 1);
    await host.close();
    const saved = await store.readWorker(handle.id);
    assert(saved.schemaVersion === 6);
    assertEquals(saved.definition, definition);
    assertEquals(saved.stateRevision, 2);
    const { buildId, ...identityBeforeBuildId } = saved.turnExecutions[0].build;
    assert(validateSessionRecordV6({
      ...saved,
      turnExecutions: [{
        ...saved.turnExecutions[0],
        build: { ...identityBeforeBuildId, buildId },
      }],
    }));

    const resumedHandle = await store.openExistingWorker(handle.id);
    const resumed = await WorkerHostSession.open({
      handle: resumedHandle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
    });
    const resumedOutcome = await resumed.submit('read worker protocol again');
    assert(resumedOutcome.ok);
    assertEquals(resumed.currentPosition().committedTurn, 2);
    await resumed.close();

    const planner = await createWorkerTuiSession({
      persistence: 'none',
      agent: 'planner',
      physicalIoMode: 'provider-free',
    });
    assert((await planner.session.submit('planner worker turn')).ok);
    await planner.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 28 renames the current durable Session and preserves its title', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-session-title-' });
  const store = new DenoSessionStore(stateRoot, Deno.cwd());
  let created: Awaited<ReturnType<typeof createWorkerTuiSession>> | undefined;
  let resumed: Awaited<ReturnType<typeof createWorkerTuiSession>> | undefined;
  try {
    created = await createWorkerTuiSession({
      stateRoot,
      workspaceRoot: Deno.cwd(),
      persistence: 'new',
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    const navigation = created.navigation;
    assert(navigation !== undefined);
    const sessionId = created.session.sessionId;
    const createdAt = navigation.currentPosition().createdAt;
    const adapter = createTuiPresentationAdapter(created.session, () => {}, navigation);
    assertEquals(
      await adapter.dispatch({ kind: 'rename_session', title: 'Release notes' }),
      { kind: 'session_title', status: 'renamed', title: 'Release notes' },
    );
    assertEquals(navigation.renameCurrent('  Release\nnotes  '), 'unchanged');
    const renamed = await store.readWorker(sessionId);
    assert(renamed.schemaVersion === 6);
    assertEquals(renamed.title, 'Release notes');
    assertEquals(renamed.createdAt, createdAt);
    assertEquals(renamed.stateRevision, 2);
    assertEquals(
      (await navigation.list()).sessions.find((row) => row.id === sessionId)?.title,
      'Release notes',
    );

    const activeTurn = created.session.submit('preserve title on commit');
    assertEquals(navigation.renameCurrent('Busy rename'), 'busy');
    assert((await activeTurn).ok);
    const committed = await store.readWorker(sessionId);
    assert(committed.schemaVersion === 6);
    assertEquals(committed.title, 'Release notes');
    assertEquals(committed.createdAt, createdAt);
    assertEquals(committed.stateRevision, 3);

    await created.close();
    created = undefined;
    resumed = await createWorkerTuiSession({
      stateRoot,
      workspaceRoot: Deno.cwd(),
      persistence: 'session',
      sessionId,
      agent: 'default',
      physicalIoMode: 'provider-free',
    });
    assertEquals(resumed.navigation?.renameCurrent('Release notes'), 'unchanged');
    assertEquals(resumed.navigation?.currentPosition().createdAt, createdAt);
    assertEquals(resumed.navigation?.currentPosition().title, 'Release notes');
    assertEquals(
      (await resumed.navigation?.list())?.sessions.find((row) => row.id === sessionId)?.title,
      'Release notes',
    );
  } finally {
    await created?.close();
    await resumed?.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Worker execution artifacts correlate built-in settlement and diagnostics readback', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-worker-execution-artifact-',
  });
  const artifacts = new DenoWorkerExecutionArtifactStore(stateRoot, Deno.cwd());
  const evidenceStore = new FakeProviderEvidenceStore();
  try {
    const builtin = await createWorkerTuiSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      rootMaxSteps: 12,
      physicalIoMode: 'provider-free',
      providerEvidenceStore: evidenceStore,
      executionArtifactStore: artifacts,
    });
    const builtinOutcome = await builtin.session.submit('read worker protocol');
    assert(builtinOutcome.ok);
    assertEquals({
      durability: builtinOutcome.executionArtifactDurability,
      error: builtinOutcome.executionArtifactPersistenceError,
    }, { durability: 'yes', error: undefined });
    await builtin.close();

    const listed = await artifacts.list();
    assertEquals(listed.length, 1);
    assertEquals(listed.map((artifact) => artifact.manifest.maxSteps), [12]);
    assertEquals(listed[0].definition.resourceId, 'builtin/default');
    for (const artifact of listed) {
      assertEquals(artifact.storeResult, 'committed');
      assertEquals(artifact.acknowledgement, 'accepted_sent');
      assertEquals(artifact.settlement, 'committed');
      assertEquals(artifact.effectCommitRelation, 'not_transactional');
      assertEquals(artifact.automaticReplay, false);
      assert(typeof artifact.providerEvidenceId === 'string');
      assertEquals(
        artifact.protocolTrace.map((entry) => `${entry.direction}:${entry.semanticSubtype}`).slice(
          0,
          4,
        ),
        [
          'host_to_worker:start',
          'worker_to_host:module_pre_read',
          'worker_to_host:module_import_start',
          'worker_to_host:module_imported',
        ],
      );
      assert(
        artifact.protocolTrace.some((entry) => entry.semanticSubtype === 'ready'),
      );
      assert(
        artifact.protocolTrace.some((entry) => entry.semanticSubtype === 'commit_proposal'),
      );
      assert(
        artifact.protocolTrace.some((entry) =>
          entry.semanticSubtype === 'commit_acknowledgement' &&
          entry.ackAccepted
        ),
      );
      assert(
        artifact.protocolTrace.some((entry) => entry.semanticSubtype === 'turn_end'),
      );
      assert(!JSON.stringify(artifact).toLowerCase().includes('authorization'));
    }

    const history = new SqliteHistoryStore(stateRoot, Deno.cwd());
    await history.initialize();
    const importedTaskId = crypto.randomUUID().toLowerCase();
    await history.beginExecution({
      taskId: importedTaskId,
      executionId: listed[0]!.executionId,
      createdAt: listed[0]!.createdAt,
      sessionCorrelation: listed[0]!.sessionId,
      sessionMode: 'no_session',
      turn: listed[0]!.turn,
      task: listed[0]!.command.task,
      baseStateRevision: listed[0]!.baseStateRevision,
      agent: listed[0]!.agent,
      model: listed[0]!.manifest.rootModel,
      build: listed[0]!.build,
      definition: listed[0]!.definition,
      manifest: listed[0]!.manifest,
      instanceCorrelation: listed[0]!.instanceCorrelation,
      workerGeneration: listed[0]!.workerGeneration,
    });
    history.settleNonCanonicalExecution({
      taskId: importedTaskId,
      executionId: listed[0]!.executionId,
      createdAt: listed[0]!.createdAt,
      sessionCorrelation: listed[0]!.sessionId,
      turn: listed[0]!.turn,
      task: listed[0]!.command.task,
      baseStateRevision: listed[0]!.baseStateRevision,
      agent: listed[0]!.agent,
      model: listed[0]!.manifest.rootModel,
      build: listed[0]!.build,
      definition: listed[0]!.definition,
      manifest: listed[0]!.manifest,
      instanceCorrelation: listed[0]!.instanceCorrelation,
      workerGeneration: listed[0]!.workerGeneration,
      outcome: builtinOutcome,
    });
    const imported = listed[0]!;
    if (imported.schemaVersion !== 5) throw new Error('expected v5 artifact');
    const { committedStateRevision: _committedRevision, ...nonCanonicalArtifact } = imported;
    history.recordPostCommitObservation({
      ...nonCanonicalArtifact,
      adoption: 'non_canonical',
    });

    assertEquals(parseFailureDiagnosticArgs(['executions', 'list']), {
      kind: 'execution_list',
    });
    const output: string[] = [];
    const status = await failureDiagnosticMain(['executions', 'list'], {
      stateRoot,
      workspaceRoot: Deno.cwd(),
      writeStdout: (text) => {
        output.push(text);
      },
    });
    assertEquals(status, 0);
    const payload = JSON.parse(output.join('')) as {
      readonly schemaVersion: number;
      readonly executions: readonly Record<string, unknown>[];
    };
    assertEquals(payload.schemaVersion, 2);
    assertEquals(payload.executions.length, 1);
    assertEquals(Object.keys(payload.executions[0]!), [
      'executionId',
      'taskId',
      'task',
      'sessionCorrelation',
      'turn',
      'createdAt',
      'settledAt',
      'lifecycle',
      'outcome',
      'outcomeJson',
      'adoption',
      'baseRevision',
      'agent',
      'model',
      'build',
      'definition',
      'manifest',
      'instanceCorrelation',
      'workerGeneration',
      'acknowledgement',
      'generationAvailability',
      'evidenceCapture',
      'diagnosticCapture',
      'artifactCapture',
      'contextCapture',
    ]);
    assertEquals(payload.executions.map((execution) => execution.turn), [1]);
    assertEquals(
      payload.executions.map((execution) =>
        (execution.definition as { readonly resourceId: string }).resourceId
      ),
      ['builtin/default'],
    );
    const showOutput: string[] = [];
    const showStatus = await failureDiagnosticMain([
      'executions',
      'show',
      '--id',
      listed[0]!.executionId,
    ], {
      stateRoot,
      workspaceRoot: Deno.cwd(),
      writeStdout: (text) => {
        showOutput.push(text);
      },
    });
    assertEquals(showStatus, 0);
    const shown = JSON.parse(showOutput.join('')) as Record<string, unknown>;
    assertEquals(shown.executionId, listed[0]!.executionId);
    assert(Array.isArray(shown.events));
    assert(Array.isArray(shown.effects));
    assert(typeof shown.definition === 'object' && shown.definition !== null);
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Worker TUI navigation reuses the invocation root maxSteps without session persistence', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-navigation-max-steps-' });
  const artifacts = new FakeWorkerExecutionArtifactStore();
  try {
    const first = await createWorkerTuiSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      rootMaxSteps: 12,
      physicalIoMode: 'provider-free',
      executionArtifactStore: artifacts,
    });
    const firstId = first.session.currentPosition().sessionId;
    assert((await first.session.submit('first invocation turn')).ok);
    await first.close();

    const second = await createWorkerTuiSession({
      stateRoot,
      persistence: 'new',
      agent: 'default',
      rootMaxSteps: 12,
      physicalIoMode: 'provider-free',
      executionArtifactStore: artifacts,
    });
    try {
      assert(second.navigation !== undefined);
      const switched = await second.navigation.switchTo(firstId);
      assert((await switched.session.submit('reopened invocation turn')).ok);
      const stored = await new DenoSessionStore(stateRoot, Deno.cwd()).readWorker(firstId);
      assert(!Object.hasOwn(stored, 'maxSteps'));
      assertEquals((await artifacts.list()).map((artifact) => artifact.manifest.maxSteps), [
        12,
        12,
      ]);
    } finally {
      await second.close();
    }
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Worker execution artifacts use turn-local sequences across one generation', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-execution-sequence-' });
  const artifacts = new DenoWorkerExecutionArtifactStore(stateRoot, Deno.cwd());
  const created = await createWorkerTuiSession({
    stateRoot,
    persistence: 'new',
    agent: 'default',
    physicalIoMode: 'provider-free',
    executionArtifactStore: artifacts,
  });
  try {
    const first = await created.session.submit('first Worker artifact turn');
    const second = await created.session.submit('second Worker artifact turn');
    assert(first.ok && second.ok);
    assertEquals(first.executionArtifactDurability, 'yes');
    assertEquals(second.executionArtifactDurability, 'yes');
    assertEquals(created.session.currentPosition().committedTurn, 2);

    const listed = await artifacts.list();
    assertEquals(listed.length, 2);
    assertEquals(listed.map((artifact) => artifact.turn).sort(), [1, 2]);
    assertEquals(listed.map((artifact) => artifact.storeResult), [
      'committed',
      'committed',
    ]);
    for (const artifact of listed) {
      assertEquals(
        artifact.protocolTrace.map((entry) => entry.sequence),
        Array.from({ length: artifact.protocolTrace.length }, (_, index) => index + 1),
      );
      const shown = await artifacts.read(artifact.executionId);
      assertEquals(shown.executionId, artifact.executionId);
      assertEquals(shown.turn, artifact.turn);
    }
  } finally {
    await created.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Worker execution artifact persistence failure is additive after a committed turn', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-worker-artifact-failure-',
  });
  const artifacts = new FakeWorkerExecutionArtifactStore();
  artifacts.failWrites();
  try {
    const definition = await readDefinitionRevision(
      workerBuiltinModulePath('default'),
      'builtin',
      'default',
    );
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocateWorker('default', definition);
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      executionArtifactStore: artifacts,
    });
    const outcome = await host.submit('artifact persistence failure task');
    assert(outcome.ok);
    assertEquals(outcome.executionArtifactDurability, 'failed');
    assertEquals(
      outcome.executionArtifactPersistenceError,
      'worker_execution_artifact_io_failure',
    );
    assertEquals(host.currentPosition().committedTurn, 1);
    assertEquals(artifacts.writeCount, 1);
    const saved = await store.readWorker(handle.id);
    assert(saved.schemaVersion === 6);
    await host.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Worker execution artifact distinguishes Host store failure from committed generation loss', async () => {
  class FailingCommitHandle implements WorkerSessionHandle {
    readonly id = '88888888-8888-4888-8888-888888888888';
    readonly record = undefined;
    readonly checkpoint = undefined;
    commit(
      _record: import('../../v0/agent/session/session_store.ts').StoredSessionRecord,
    ): void {
      throw new Error('simulated Host store failure');
    }
    installCheckpoint(
      _checkpoint: import('../../v0/agent/session/session_store.ts').SemanticContextCheckpointV1,
    ): void {
      throw new Error('unexpected checkpoint');
    }
    rollback(): void {}
    rollbackCheckpoint(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  const artifacts = new FakeWorkerExecutionArtifactStore();
  const definition = await readDefinitionRevision(
    workerBuiltinModulePath('default'),
    'builtin',
    'default',
  );
  const handle = new FailingCommitHandle();
  const host = await WorkerHostSession.open({
    handle,
    workspaceRoot: Deno.cwd(),
    agent: 'default',
    definition,
    modulePath: workerBuiltinModulePath('default'),
    physicalIoMode: 'provider-free',
    executionArtifactStore: artifacts,
  });
  try {
    const outcome = await host.submit('Host store failure task');
    assert(!outcome.ok);
    const artifact = (await artifacts.list())[0];
    assert(artifact !== undefined);
    assertEquals(artifact.storeResult, 'failed');
    assertEquals(artifact.acknowledgement, 'rejected_sent');
    assertEquals(artifact.settlement, 'uncommitted');
    assertEquals(artifact.automaticReplay, false);
    assertEquals(host.currentPosition().committedTurn, 0);
  } finally {
    await host.close();
  }
});

Deno.test('Worker reuses an explicitly stored checkpoint after reopen', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-context-' });
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocateWorker('default', definition);
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
    });
    assert((await host.submit(`first ${'x'.repeat(30_000)}`)).ok);
    assert((await host.submit(`second ${'y'.repeat(30_000)}`)).ok);
    assertEquals(host.checkpointSnapshot(), undefined);
    assertEquals(await store.readCheckpoint(handle.id), undefined);
    await host.close();

    const checkpointHandle = await store.openExistingWorker(handle.id);
    checkpointHandle.installCheckpoint({
      contextSchemaVersion: 1,
      sessionId: handle.id,
      createdAt: '2026-09-10T00:00:00.000Z',
      sourceProfileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
      summary: 'explicitly retained first turn',
    });
    await checkpointHandle.close();
    assert((await store.readCheckpoint(handle.id))?.sessionId === handle.id);
    const reopenedHandle = await store.openExistingWorker(handle.id);
    const reopened = await WorkerHostSession.open({
      handle: reopenedHandle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
    });
    assert(reopened.checkpointSnapshot() !== undefined);
    assert((await reopened.submit('reopened checkpoint turn')).ok);
    await reopened.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Increment 32 rejects unmanaged --definition before startup', () => {
  let rejected = false;
  try {
    parseTuiInvocation(['--definition', 'worker.ts', '--no-session']);
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test('TUI parses root maxSteps with agent and persistence selectors', () => {
  assertEquals(
    parseTuiInvocation([
      '--continue',
      '--max-steps',
      '64',
      '--agent',
      'planner',
    ]),
    {
      rawAgentName: 'planner',
      rootMaxSteps: 64,
      persistence: 'continue',
    },
  );
  for (
    const args of [
      ['--max-steps'],
      ['--max-steps', '0'],
      ['--max-steps', '-1'],
      ['--max-steps', '1.5'],
      ['--max-steps', '9007199254740992'],
      ['--max-steps', '4', '--max-steps', '5'],
    ]
  ) {
    let rejected = false;
    try {
      parseTuiInvocation(args);
    } catch {
      rejected = true;
    }
    assert(rejected, `expected rejection for ${JSON.stringify(args)}`);
  }
});

Deno.test('Host turn settlement does not apply the five-second queue timeout', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-delayed-' });
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocateWorker('default', definition);
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
    });
    const outcome = await host.submit('very-slow provider-free turn');
    assert(outcome.ok);
    assertEquals(outcome.stopReason, 'final');
    assertEquals(host.currentPosition().committedTurn, 1);
    await host.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Worker TUI composition routes core events through the presentation adapter', async () => {
  const coreEvents: AgentEvent[] = [];
  const presentationEvents: unknown[] = [];
  let adapter: ReturnType<typeof createTuiPresentationAdapter> | undefined;
  const created = await createWorkerTuiSession({
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
    eventSink: (event) => {
      coreEvents.push(event);
      adapter?.deliverCoreEvent(event);
    },
  });
  try {
    adapter = createTuiPresentationAdapter(
      created.session,
      (event) => presentationEvents.push(event),
      created.navigation,
    );
    const result = await adapter.dispatch({
      kind: 'ordinary_submit',
      text: 'read progress worker protocol',
    });
    assertEquals((result as { readonly kind: string }).kind, 'outcome');
    const coreKinds = coreEvents.map((event) => event.kind);
    assert(coreKinds.includes('assistant_progress'));
    assert(coreKinds.includes('tool_call'));
    assert(coreKinds.includes('tool_result'));
    const coreEnd = coreEvents.findLast((event) => event.kind === 'turn_end');
    assert(coreEnd?.kind === 'turn_end');
    assertEquals(coreEnd.committed, true);
    const presentationKinds = presentationEvents.map((event) =>
      typeof event === 'object' && event !== null && 'kind' in event
        ? (event as { readonly kind: string }).kind
        : undefined
    );
    assert(presentationKinds.includes('assistant_progress'));
    assert(presentationKinds.includes('tool_call'));
    assert(presentationKinds.includes('tool_result'));
    assert(presentationKinds.includes('turn_end'));
    assertEquals(created.requestCount(), 0);
  } finally {
    await created.close();
  }
});

Deno.test('Worker shares request accounting and credential-free evidence across parent and planner', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-worker-evidence-',
  });
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const evidenceStore = new FakeProviderEvidenceStore();
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocateWorker('default', definition);
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      providerEvidenceStore: evidenceStore,
    });
    const readOutcome = await host.submit('read worker protocol');
    const plannerOutcome = await host.submit('delegate planner');
    assert(readOutcome.ok && plannerOutcome.ok);
    assertEquals(
      {
        read: [
          readOutcome.steps,
          readOutcome.toolCallCount,
          readOutcome.toolResultCount,
        ],
        planner: [
          plannerOutcome.steps,
          plannerOutcome.toolCallCount,
          plannerOutcome.toolResultCount,
        ],
        requests: [
          readOutcome.turnProviderRequestCount,
          readOutcome.runtimeProviderRequestCount,
          plannerOutcome.turnProviderRequestCount,
          plannerOutcome.runtimeProviderRequestCount,
        ],
      },
      { read: [2, 1, 1], planner: [2, 1, 1], requests: [0, 0, 0, 0] },
    );
    const evidence = await evidenceStore.list();
    assertEquals(evidence.length, 2);
    assertEquals(evidence.map((item) => item.turnNumber), [1, 2]);
    assert(
      evidence[1].runtimeEvents.some((event) => event.kind === 'model_result'),
    );
    assert(
      evidence[1].runtimeEvents.some((event) => event.kind === 'tool_call'),
    );
    assertEquals(host.requestCount(), 0);
    await host.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('WorkerHost emits no automatic compaction notice for long history', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-notice-' });
  let sessionId: string | undefined;
  try {
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const definition = await readDefinitionRevision(
      workerBuiltinModulePath('default'),
      'builtin',
      'default',
    );
    const handle = await store.allocateWorker('default', definition);
    sessionId = handle.id;
    const transcript: Message[] = [];
    for (let turn = 1; turn <= 2; turn += 1) {
      transcript.push({
        role: 'user',
        content: { kind: 'text', text: `old task ${turn}` },
      });
      transcript.push({
        role: 'assistant',
        content: {
          kind: 'text',
          text: `${'old answer '.repeat(20_000)}${turn}`,
        },
      });
    }
    handle.commit({
      schemaVersion: 6,
      sessionId: handle.id,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      title: null,
      stateRevision: 1,
      nextTurn: 3,
      transcript,
      definition,
      activeModel: ROOT_DEFAULT_MODEL_SELECTION,
      modelChanges: [{
        effectiveFromTurn: 1,
        changedAt: '2026-09-04T00:00:00.000Z',
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      }],
      turnModels: [1, 2].map((turn) => ({
        turn,
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      })),
      turnExecutions: [1, 2].map((turn) => ({
        turn,
        build: buildManifest(),
        definition,
      })),
    });
    await handle.close();
    const presentationEvents: unknown[] = [];
    let adapter: ReturnType<typeof createTuiPresentationAdapter> | undefined;
    const created = await createWorkerTuiSession({
      stateRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      physicalIoMode: 'provider-free',
      eventSink: (event) => adapter?.deliverCoreEvent(event),
    });
    try {
      adapter = createTuiPresentationAdapter(
        created.session,
        (event) => presentationEvents.push(event),
        created.navigation,
      );
      await adapter.dispatch({
        kind: 'ordinary_submit',
        text: 'read without automatic compaction',
      });
      const notices = presentationEvents.filter((event) =>
        typeof event === 'object' && event !== null &&
        (event as { readonly kind?: unknown }).kind === 'notice'
      );
      assertEquals(notices.length, 0);
      assertEquals(created.session.consumeAutoCompactionNotice(), null);
      assertEquals(created.session.checkpointSnapshot(), undefined);
    } finally {
      await created.close();
    }
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('WorkerHost clears an automatic compaction notice when checkpoint ack delivery fails', async () => {
  class CheckpointAckFailureCapsule implements WorkerHostCapsule {
    private readonly listeners = new Set<
      (message: WorkerToHostMessage) => void
    >();
    terminated = false;

    private emit(message: WorkerToHostMessage): void {
      for (const listener of this.listeners) listener(message);
    }

    send(command: WorkerHostCommand): void {
      if (command.kind === 'start') {
        this.emit({
          kind: 'ready',
          correlation: command.correlation,
          manifest: {
            role: 'parent',
            maxSteps: 8,
            profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
            resources: [],
            rootModel: ROOT_DEFAULT_MODEL_SELECTION,
            plannerModel: PLANNER_DEFAULT_MODEL_SELECTION,
          },
          startupSnapshot: { skillNames: [] },
          credentialAvailability: {
            authProfile: 'openrouter-api-key',
            status: 'unknown',
          },
        });
      } else if (command.kind === 'turn') {
        queueMicrotask(() => {
          if (this.terminated) return;
          this.emit({
            kind: 'checkpoint_proposal',
            correlation: command.correlation,
            checkpoint: {
              contextSchemaVersion: 1,
              sessionId: command.correlation.session,
              createdAt: '2026-09-04T00:00:00.000Z',
              sourceProfileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
              coveredThroughTurn: 1,
              retainedFromTurn: 2,
              summary: 'retained context',
            },
            heldUserText: command.task,
          });
        });
      } else if (command.kind === 'checkpoint_acknowledgement') {
        throw new Error('simulated checkpoint ack delivery failure');
      } else if (command.kind === 'close') {
        this.emit({ kind: 'closed', correlation: command.correlation });
      }
    }

    subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-worker-notice-failure-',
  });
  let sessionId: string | undefined;
  try {
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const definition = await readDefinitionRevision(
      workerBuiltinModulePath('default'),
      'builtin',
      'default',
    );
    const handle = await store.allocateWorker('default', definition);
    sessionId = handle.id;
    handle.commit({
      schemaVersion: 6,
      sessionId: handle.id,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      title: null,
      stateRevision: 1,
      nextTurn: 3,
      transcript: [
        { role: 'user', content: { kind: 'text', text: 'old task 1' } },
        { role: 'assistant', content: { kind: 'text', text: 'old answer 1' } },
        { role: 'user', content: { kind: 'text', text: 'old task 2' } },
        { role: 'assistant', content: { kind: 'text', text: 'old answer 2' } },
      ],
      definition,
      activeModel: ROOT_DEFAULT_MODEL_SELECTION,
      modelChanges: [{
        effectiveFromTurn: 1,
        changedAt: '2026-09-04T00:00:00.000Z',
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      }],
      turnModels: [1, 2].map((turn) => ({
        turn,
        selection: ROOT_DEFAULT_MODEL_SELECTION,
      })),
      turnExecutions: [1, 2].map((turn) => ({
        turn,
        build: buildManifest(),
        definition,
      })),
    });
    await handle.close();
    const reopened = await store.openExistingWorker(sessionId);
    let adapter: ReturnType<typeof createTuiPresentationAdapter> | undefined;
    const presentationEvents: unknown[] = [];
    const host = await WorkerHostSession.open({
      handle: reopened,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath: workerBuiltinModulePath('default'),
      physicalIoMode: 'provider-free',
      capsuleFactory: () => new CheckpointAckFailureCapsule(),
      eventSink: (event) => adapter?.deliverCoreEvent(event),
    });
    try {
      adapter = createTuiPresentationAdapter(
        host,
        (event) => presentationEvents.push(event),
      );
      const result = await adapter.dispatch({
        kind: 'ordinary_submit',
        text: 'held turn must not start',
      });
      assertEquals((result as { readonly kind: string }).kind, 'outcome');
      assertEquals(host.checkpointSnapshot()?.coveredThroughTurn, 1);
      assertEquals(host.consumeAutoCompactionNotice(), null);
      assert(
        !presentationEvents.some((event) =>
          typeof event === 'object' && event !== null &&
          (event as { readonly kind?: unknown }).kind === 'notice'
        ),
      );
      assert(!host.isAvailable());
    } finally {
      await host.close();
    }
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('WorkerHost terminates on pre-commit event delivery failure and preserves post-commit state', async () => {
  type Mode = 'precommit' | 'postcommit';
  class EventFailureCapsule implements WorkerHostCapsule {
    private readonly listeners = new Set<
      (message: WorkerToHostMessage) => void
    >();
    terminated = false;
    commitProposals = 0;

    constructor(private readonly mode: Mode) {}

    private emit(message: WorkerToHostMessage): void {
      for (const listener of this.listeners) listener(message);
    }

    send(command: WorkerHostCommand): void {
      if (command.kind === 'start') {
        this.emit({
          kind: 'ready',
          correlation: command.correlation,
          manifest: {
            role: 'parent',
            maxSteps: 8,
            profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
            resources: [],
            rootModel: ROOT_DEFAULT_MODEL_SELECTION,
            plannerModel: PLANNER_DEFAULT_MODEL_SELECTION,
          },
          startupSnapshot: { skillNames: [] },
          credentialAvailability: {
            authProfile: 'openrouter-api-key',
            status: 'unknown',
          },
        });
      } else if (command.kind === 'turn') {
        queueMicrotask(() => {
          if (this.terminated) return;
          if (this.mode === 'precommit') {
            this.emit({
              kind: 'runtime_event',
              correlation: command.correlation,
              sequence: 1,
              event: {
                kind: 'agent_event',
                event: {
                  kind: 'assistant_progress',
                  turn: 1,
                  text: 'before commit',
                },
              },
            });
            if (this.terminated) return;
          }
          this.commitProposals += 1;
          this.emit({
            kind: 'commit_proposal',
            correlation: command.correlation,
            nextTurn: 2,
            transcript: [
              { role: 'user', content: { kind: 'text', text: command.task } },
              {
                role: 'assistant',
                content: { kind: 'text', text: 'committed answer' },
              },
            ],
          });
        });
      } else if (
        command.kind === 'commit_acknowledgement' && command.accepted
      ) {
        queueMicrotask(() => {
          if (this.terminated) return;
          this.emit({
            kind: 'runtime_event',
            correlation: command.correlation,
            sequence: 2,
            event: {
              kind: 'agent_event',
              event: {
                kind: 'turn_end',
                turn: 1,
                outcome: 'final',
                committed: true,
              },
            },
          });
        });
      } else if (command.kind === 'close') {
        this.emit({ kind: 'closed', correlation: command.correlation });
      }
    }

    subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  const run = async (mode: Mode, failingKind: AgentEvent['kind']): Promise<{
    readonly outcome: import('../../v0/agent/core/contracts.ts').LoopOutcome;
    readonly host: WorkerHostSession;
    readonly capsule: EventFailureCapsule;
    readonly cleanup: () => Promise<void>;
  }> => {
    const stateRoot = await Deno.makeTempDir({
      prefix: `henji-worker-event-${mode}-`,
    });
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocateWorker('default', definition);
    let capsule: EventFailureCapsule | undefined;
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      capsuleFactory: () => {
        capsule = new EventFailureCapsule(mode);
        return capsule;
      },
      eventSink: (event) => {
        if (event.kind === failingKind) {
          throw new Error('simulated presentation failure');
        }
      },
    });
    try {
      const outcome = await host.submit(`${mode} event failure task`);
      assert(capsule !== undefined);
      return {
        outcome,
        host,
        capsule,
        cleanup: async () => {
          await host.close();
          await Deno.remove(stateRoot, { recursive: true });
        },
      };
    } catch (error) {
      await host.close();
      await Deno.remove(stateRoot, { recursive: true });
      throw error;
    }
  };

  const precommit = await run('precommit', 'assistant_progress');
  try {
    assert(!precommit.outcome.ok);
    assertEquals(precommit.host.currentPosition().committedTurn, 0);
    assertEquals(precommit.capsule.commitProposals, 0);
    assert(precommit.capsule.terminated);
    assert(!precommit.host.isAvailable());
    let replayRejected = false;
    try {
      await precommit.host.submit('must not replay after event failure');
    } catch {
      replayRejected = true;
    }
    assert(replayRejected);
  } finally {
    await precommit.cleanup();
  }

  const postcommit = await run('postcommit', 'turn_end');
  try {
    assert(postcommit.outcome.ok);
    assertEquals(postcommit.host.currentPosition().committedTurn, 1);
    assertEquals(postcommit.capsule.commitProposals, 1);
    assert(postcommit.capsule.terminated);
    assert(!postcommit.host.isAvailable());
  } finally {
    await postcommit.cleanup();
  }
});

Deno.test('Slice 6 keeps a durable commit after commit-ack delivery failure without replay', async () => {
  class AckFailureCapsule implements WorkerHostCapsule {
    private readonly listeners = new Set<
      (message: WorkerToHostMessage) => void
    >();
    private emit(message: WorkerToHostMessage): void {
      for (const listener of this.listeners) listener(message);
    }
    send(command: WorkerHostCommand): void {
      if (command.kind === 'start') {
        this.emit({
          kind: 'ready',
          correlation: command.correlation,
          manifest: {
            role: 'parent',
            maxSteps: 8,
            profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
            resources: [],
            rootModel: ROOT_DEFAULT_MODEL_SELECTION,
            plannerModel: PLANNER_DEFAULT_MODEL_SELECTION,
          },
          startupSnapshot: { skillNames: [] },
          credentialAvailability: {
            authProfile: 'openrouter-api-key',
            status: 'unknown',
          },
        });
      } else if (command.kind === 'turn') {
        queueMicrotask(() =>
          this.emit({
            kind: 'commit_proposal',
            correlation: command.correlation,
            nextTurn: 2,
            transcript: [
              { role: 'user', content: { kind: 'text', text: command.task } },
              {
                role: 'assistant',
                content: { kind: 'text', text: 'committed answer' },
              },
            ],
          })
        );
      } else if (
        command.kind === 'commit_acknowledgement' && command.accepted
      ) {
        throw new Error('simulated ack delivery failure');
      } else if (command.kind === 'close') {
        this.emit({ kind: 'closed', correlation: command.correlation });
      }
    }
    subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    terminate(): void {}
  }

  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-ack-' });
  const artifacts = new FakeWorkerExecutionArtifactStore();
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocateWorker('default', definition);
    const host = await WorkerHostSession.open({
      handle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
      executionArtifactStore: artifacts,
      capsuleFactory: () => new AckFailureCapsule(),
    });
    const outcome = await host.submit('ack failure task');
    assert(outcome.ok);
    assertEquals(outcome.executionArtifactDurability, 'yes');
    assertEquals(host.currentPosition().committedTurn, 1);
    assert(!host.isAvailable());
    const saved = await store.readWorker(handle.id);
    assert(saved.schemaVersion === 6);
    let rejected = false;
    try {
      await host.submit('must not replay');
    } catch {
      rejected = true;
    }
    assert(rejected);
    const artifact = (await artifacts.list())[0];
    assert(artifact !== undefined);
    assertEquals(artifact.storeResult, 'committed');
    assertEquals(artifact.acknowledgement, 'delivery_failed');
    assertEquals(artifact.settlement, 'committed_generation_unavailable');
    assertEquals(artifact.automaticReplay, false);
    assertEquals(artifacts.writeCount, 1);
    await host.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});
