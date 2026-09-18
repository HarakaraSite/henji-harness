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
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store.ts';
import { FakeProviderEvidenceStore } from '../../v0/agent/provider/provider_evidence.ts';
import {
  builtinWebSearchToolDefinitionLoadRequest,
  createWorkerSession,
  readDefinitionRevision,
  workerBuiltinModulePath,
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
  FakeWorkerExecutionArtifactStore,
} from '../../v0/agent/worker/worker_execution_artifact_store.ts';
import { OpenRouterAgentError } from '../../v0/agent/provider/openrouter_model.ts';
import { validateFailureDiagnostic } from '../../v0/agent/session/failure_diagnostic.ts';
import { presentationFailureReason } from '../../v0/tui/state.ts';

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
      probe: 'slice1-data-only-v2:relative-import-ok',
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
      toolDefinitions: [await builtinWebSearchToolDefinitionLoadRequest()],
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
  const created = await createWorkerSession({
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
  const created = await createWorkerSession({
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
  const created = await createWorkerSession({
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
      toolDefinitions: [await builtinWebSearchToolDefinitionLoadRequest()],
    });
    await readyPromise;

    capsule.send({
      kind: 'turn',
      correlation: correlation('planner-turn'),
      task: 'delegate planner',
    });
    const effect = await capsule.waitForMessage((message): message is Extract<
      WorkerToHostMessage,
      { kind: 'provider_observation' }
    > =>
      message.kind === 'provider_observation' &&
      message.observation.kind === 'runtime_event' &&
      message.observation.event.kind === 'tool_call'
    );
    assertEquals(effect.observation.kind, 'runtime_event');
    if (
      effect.observation.kind !== 'runtime_event' ||
      effect.observation.event.kind !== 'tool_call'
    ) {
      throw new Error('expected tool call');
    }
    assertEquals(effect.observation.event.call.name, 'delegate_to_planner');
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
      toolDefinitions: [await builtinWebSearchToolDefinitionLoadRequest()],
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
    toolDefinitions: [await builtinWebSearchToolDefinitionLoadRequest()],
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

Deno.test('Worker TUI composition routes core events through the presentation adapter', async () => {
  const coreEvents: AgentEvent[] = [];
  const presentationEvents: unknown[] = [];
  let adapter: ReturnType<typeof createTuiPresentationAdapter> | undefined;
  const created = await createWorkerSession({
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
  const evidenceStore = new FakeProviderEvidenceStore();
  const created = await createWorkerSession({
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
    providerEvidenceStore: evidenceStore,
  });
  try {
    const host = created.session;
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
  } finally {
    await created.close();
  }
});
