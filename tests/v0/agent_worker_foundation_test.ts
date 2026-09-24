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
import type { WorkerSessionHandle } from '../../v0/agent/session/session_store.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import {
  bundledToolDefinitionLoadRequests,
  createWorkerSession,
  readDefinitionRevision,
  workerBuiltinModulePath,
  WorkerHostSession,
  WorkerRecallSelectionError,
} from '../../v0/agent/worker/worker_host.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import { runHeadlessWorker } from '../../v0/agent/worker/worker_headless_runner.ts';
import { resolveBuiltinAgent } from '../../v0/agent/definitions/agent_catalog.ts';
import { main as runtimeCliMain, parseRuntimeArgs } from '../../v0/agent/cli/runtime_cli.ts';
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
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import {
  createFailureDiagnostic,
  validateFailureDiagnostic,
} from '../../v0/agent/session/failure_diagnostic.ts';
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

class TerminalToolOutcomeCapsule implements WorkerHostCapsule {
  private readonly listeners = new Set<
    (message: WorkerToHostMessage) => void
  >();

  private emit(message: WorkerToHostMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  send(command: WorkerHostCommand): void {
    if (command.kind === 'start') {
      const rootModel = command.modelSelection ?? ROOT_DEFAULT_MODEL_SELECTION;
      this.emit({
        kind: 'ready',
        correlation: command.correlation,
        manifest: {
          role: 'parent',
          maxSteps: 8,
          profileId: modelRouteProfileId(rootModel),
          resources: [],
          rootModel,
          ...(command.baseInstruction === undefined ? {} : {
            baseInstruction: {
              slot: command.baseInstruction.slot,
              selectionSource: command.baseInstruction.selectionSource,
              ref: command.baseInstruction.ref,
              contentDigest: command.baseInstruction.contentDigest,
            },
          }),
        },
        startupSnapshot: { skillNames: [] },
        credentialAvailability: {
          authProfile: rootModel.authProfile,
          status: 'unknown',
        },
      });
      return;
    }
    if (command.kind === 'turn') {
      const finalText = '{"ok":true}';
      const transcript: Message[] = [
        { role: 'user', content: { kind: 'text', text: command.task } },
        {
          role: 'assistant',
          content: [{
            kind: 'tool_call',
            callId: 'terminal-1',
            name: 'submit_json_result',
            arguments: { json: finalText },
          }],
        },
        {
          role: 'tool',
          content: [{
            kind: 'tool_result',
            callId: 'terminal-1',
            name: 'submit_json_result',
            text: finalText,
            outcome: 'success',
            terminal: 'json_result',
          }],
        },
      ];
      queueMicrotask(() =>
        this.emit({
          kind: 'commit_proposal',
          correlation: command.correlation,
          nextTurn: 2,
          transcript,
          outcome: {
            ok: true,
            task: command.task,
            outcome: 'final',
            stopReason: 'tool_terminal',
            finalText,
            terminalKind: 'json_result',
            steps: 1,
            toolCallCount: 1,
            toolResultCount: 1,
            transcript,
          },
        })
      );
      return;
    }
    if (command.kind === 'commit_acknowledgement' && command.accepted) {
      queueMicrotask(() =>
        this.emit({
          kind: 'runtime_event',
          correlation: command.correlation,
          sequence: 1,
          event: {
            kind: 'agent_event',
            event: {
              kind: 'turn_end',
              turn: 1,
              outcome: 'tool_terminal',
              committed: true,
            },
          },
        })
      );
      return;
    }
    if (command.kind === 'close') {
      this.emit({ kind: 'closed', correlation: command.correlation });
    }
  }

  subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {}
}

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
  let startOptions: unknown;
  const result = await runHeadlessWorker(
    'read worker protocol',
    resolveBuiltinAgent(),
    {
      physicalIoMode: 'provider-free',
      rootMaxSteps: 160,
      providerTimeoutMs: 420_000,
      executionArtifactStore: artifacts,
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        return {
          send: (command) => {
            if (command.kind === 'start') {
              startOptions = {
                rootMaxSteps: command.rootMaxSteps,
                providerTimeoutMs: command.providerTimeoutMs,
              };
            }
            capsule.send(command);
          },
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
  assertEquals(startOptions, { rootMaxSteps: 160, providerTimeoutMs: 420_000 });
  const written = await artifacts.list();
  assertEquals(written.length, 1);
  assertEquals(written[0]?.manifest.maxSteps, 160);
  assert(!written[0]?.manifest.resources.includes('agent:planner'));
  assertEquals(written[0]?.storeResult, 'committed');
  assertEquals(written[0]?.acknowledgement, 'accepted_sent');
  assert(
    written[0]?.protocolTrace.some((entry) => entry.semanticSubtype === 'module_pre_read'),
  );
  assert(
    written[0]?.protocolTrace.some((entry) => entry.semanticSubtype === 'commit_proposal'),
  );
});

Deno.test('production subscriber does not retain delivered Worker messages across turns', async () => {
  let capsule: WorkerCapsule | undefined;
  const created = await createWorkerSession({
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
    capsuleFactory: (url) => {
      capsule = new WorkerCapsule(url);
      return capsule;
    },
  });
  try {
    for (let turn = 1; turn <= 3; turn += 1) {
      const outcome = await created.session.submit(
        `turn ${turn}: ${'x'.repeat(8_192)}`,
      );
      assert(outcome.ok);
      assert(capsule !== undefined);
      const queued = Reflect.get(capsule, 'messages') as WorkerToHostMessage[];
      assertEquals(queued.length, 0);
    }
  } finally {
    await created.close();
  }
});

Deno.test('Host does not retain processed provider observations in its response queue', async () => {
  const artifacts = new FakeWorkerExecutionArtifactStore();
  let turn = 0;
  let probeSequence = 0;
  let hostListener: ((message: WorkerToHostMessage) => void) | undefined;
  const created = await createWorkerSession({
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
    executionArtifactStore: artifacts,
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      return {
        send: (command) => {
          if (command.kind === 'turn') {
            turn += 1;
            assert(hostListener !== undefined);
            const listener = hostListener;
            const recorder = new ProviderEvidenceRecorder(
              undefined,
              turn,
              undefined,
              (observation) => {
                listener({
                  kind: 'provider_observation',
                  correlation: command.correlation,
                  sequence: ++probeSequence,
                  turn,
                  observation,
                });
                return probeSequence;
              },
            );
            recorder.startRequestMetadata({
              lane: 'parent',
              modelStep: 1,
              endpoint: 'https://example.invalid/provider',
              method: 'POST',
            });
            recorder.recordResponse({
              status: 200,
            });
          }
          capsule.send(command);
        },
        subscribe: (listener) => {
          hostListener = listener;
          const unsubscribe = capsule.subscribe(listener);
          return () => {
            hostListener = undefined;
            unsubscribe();
          };
        },
        terminate: () => capsule.terminate(),
      };
    },
  });
  try {
    for (let index = 1; index <= 3; index += 1) {
      const outcome = await created.session.submit(
        `provider observation turn ${index}`,
      );
      assert(outcome.ok);
      const coordinator = Reflect.get(created.session, 'coordinator') as object;
      const supervisor = Reflect.get(coordinator, 'supervisor') as object;
      const messages = Reflect.get(supervisor, 'messages') as object;
      const queued = Reflect.get(messages, 'queue') as WorkerToHostMessage[];
      assertEquals(queued.length, 0);
    }
    const stored = await artifacts.list();
    assertEquals(stored.length, 3);
    for (const artifact of stored) {
      assertEquals(
        artifact.protocolTrace.filter((entry) =>
          entry.kind === 'provider_observation' &&
          entry.semanticSubtype !== 'runtime_event'
        )
          .map((entry) => entry.semanticSubtype),
        ['request_start', 'response_start'],
      );
    }
  } finally {
    await created.close();
  }
});

Deno.test('short provider failure facts survive Worker to Host SQLite persistence', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-short-facts-' });
  const workspaceRoot = Deno.cwd();
  let hostListener: ((message: WorkerToHostMessage) => void) | undefined;
  let sequence = 0;
  const created = await createWorkerSession({
    stateRoot,
    workspaceRoot,
    persistence: 'new',
    agent: 'default',
    physicalIoMode: 'provider-free',
    capsuleFactory: (url) => {
      const capsule = new WorkerCapsule(url);
      return {
        send: (command) => {
          if (command.kind === 'turn') {
            assert(hostListener !== undefined);
            const recorder = new ProviderEvidenceRecorder(
              undefined,
              1,
              undefined,
              (observation) => {
                hostListener!({
                  kind: 'provider_observation',
                  correlation: command.correlation,
                  sequence: ++sequence,
                  turn: 1,
                  observation,
                });
                return sequence;
              },
              false,
            );
            recorder.startRequestMetadata({
              lane: 'parent',
              modelStep: 1,
              contextRequestOrdinal: 1,
              endpoint: 'https://example.invalid/chat/completions',
              method: 'POST',
              requestMetadata: {
                provider: 'opencode-go-chat',
                api: 'openrouter-chat-completions',
                modelId: 'mimo-v2.6-pro',
              },
            });
            recorder.recordResponse({ status: 200 });
            recorder.recordParserTransition({
              kind: 'failure',
              field: 'response.choices[0].message.tool_calls[0].function.arguments',
              expectedShape: 'JSON string',
              actualShape: 'number',
            });
            recorder.recordRequestFailure({
              stage: 'response_parse',
              code: 'response_error',
              httpStatus: 200,
            });
          }
          capsule.send(command);
        },
        subscribe: (listener) => {
          hostListener = listener;
          const unsubscribe = capsule.subscribe(listener);
          return () => {
            hostListener = undefined;
            unsubscribe();
          };
        },
        terminate: () => capsule.terminate(),
      };
    },
  });
  try {
    const outcome = await created.session.submit('record the request fact');
    assert(outcome.ok);
    const store = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot);
    await store.initialize();
    const execution = store.listExecutions().at(-1);
    assert(execution !== undefined);
    const facts = store.readExecutionRequestFacts(execution.executionId, 1);
    assertEquals(facts.map((fact) => fact.kind), [
      'provider_request_start',
      'provider_response_start',
      'provider_parser_transition',
      'provider_request_failure',
    ]);
    const serialized = JSON.stringify(facts);
    assert(serialized.includes('mimo-v2.6-pro'));
    assert(serialized.includes('tool_calls[0].function.arguments'));
    assert(!serialized.includes('requestBody'));
    assert(!serialized.includes('rawFrame'));
  } finally {
    await created.close();
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('terminal tool success persists and reads back its Worker execution artifact', async () => {
  const artifacts = new FakeWorkerExecutionArtifactStore();
  const created = await createWorkerSession({
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
    executionArtifactStore: artifacts,
    capsuleFactory: () => new TerminalToolOutcomeCapsule(),
  });
  try {
    const outcome = await created.session.submit('submit terminal JSON');
    assert(outcome.ok);
    assertEquals(
      {
        outcome: outcome.outcome,
        stopReason: outcome.stopReason,
        finalText: outcome.finalText,
        durability: outcome.executionArtifactDurability,
      },
      {
        outcome: 'final',
        stopReason: 'tool_terminal',
        finalText: '{"ok":true}',
        durability: 'yes',
      },
    );
    const stored = await artifacts.list();
    assertEquals(stored.length, 1);
    assertEquals(
      {
        outcome: stored[0]?.outcome?.outcome,
        stopReason: stored[0]?.outcome?.stopReason,
        finalText: stored[0]?.outcome?.finalText,
        terminalKind: stored[0]?.outcome?.terminalKind,
      },
      {
        outcome: 'final',
        stopReason: 'tool_terminal',
        finalText: '{"ok":true}',
        terminalKind: 'json_result',
      },
    );
  } finally {
    await created.close();
  }
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
    ['--agent', 'default', '--task', '  plan this  '],
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
    { task: 'plan this', agent: 'default' },
    { task: 'stdin task', agent: 'default' },
  ]);
});

Deno.test('run accepts per-invocation model steps and provider deadline', () => {
  assertEquals(
    parseRuntimeArgs([
      '--provider-timeout-ms',
      '420000',
      '--agent',
      'planner',
      '--max-steps',
      '160',
      '--task',
      'hi',
    ]),
    {
      taskArg: 'hi',
      rawAgentName: 'planner',
      rootMaxSteps: 160,
      providerTimeoutMs: 420_000,
    },
  );
});

Deno.test('run passes both limits to the headless Worker invocation', async () => {
  const observed: unknown[] = [];
  const exit = await runtimeCliMain(
    ['--max-steps', '160', '--provider-timeout-ms', '420000', '--task', 'hi'],
    {
      stdinIsTerminal: () => true,
      run: (task, _selection, _sink, options) => {
        observed.push(options);
        return successfulHeadlessRun(task);
      },
      writeStdout: () => {},
      writeStderr: () => {},
    },
  );
  assertEquals(exit, 0);
  assertEquals(observed, [{ rootMaxSteps: 160, providerTimeoutMs: 420_000 }]);
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
  assert(
    task.includes(
      '--allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,XDG_STATE_HOME,ZOT_HOME',
    ),
  );
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
      readSpecifier: new URL('../../v0/agent/worker/worker_protocol.ts', import.meta.url)
        .href,
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
      ? new URL(
        '../../v0/agent/worker/worker_builtin_definition.ts',
        import.meta.url,
      )
        .pathname
      : fixture(definitionFile);
    const revision = await readWorkerModuleRevision(definitionPath);
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: correlation(`composition-${definitionFile}`),
      module: revision,
      workspaceRoot: Deno.cwd(),
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
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
  const builtin = await runCompositionTurn('worker_builtin_definition.ts', 128);
  const external = await runCompositionTurn('external_definition.ts', 4);
  assert(builtin.manifest !== undefined && external.manifest !== undefined);
  assertEquals(builtin.manifest.resources, external.manifest.resources);
});

Deno.test('Worker applies a root maxSteps request to built-in and external Definitions', async () => {
  const builtin = await runCompositionTurn(
    'worker_builtin_definition.ts',
    12,
    12,
  );
  const external = await runCompositionTurn('external_definition.ts', 12, 12);
  assertEquals(builtin.manifest?.maxSteps, 12);
  assertEquals(external.manifest?.maxSteps, 12);
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

Deno.test('Slice 3 keeps effect and cancellation semantics inside the Worker generation', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    const revision = await readWorkerModuleRevision(
      new URL(
        '../../v0/agent/worker/worker_builtin_definition.ts',
        import.meta.url,
      )
        .pathname,
    );
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: correlation('planner-start'),
      module: revision,
      workspaceRoot: Deno.cwd(),
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
    });
    await readyPromise;

    capsule.send({
      kind: 'turn',
      correlation: correlation('planner-turn'),
      task: 'ordinary worker turn',
    });
    const proposal = await capsule.waitForMessage(isCommitProposal);
    capsule.send({
      kind: 'commit_acknowledgement',
      correlation: proposal.correlation,
      accepted: true,
    });
    await capsule.waitForMessage(isTerminalAgentRuntime);
    assert(
      proposal.transcript.some((message) =>
        isTextAssistant(message) &&
        message.content.text.includes('worker answer: ordinary worker turn')
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
      new URL(
        '../../v0/agent/worker/worker_builtin_definition.ts',
        import.meta.url,
      )
        .pathname,
    );
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: sessionCorrelation,
      module: revision,
      workspaceRoot: Deno.cwd(),
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
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
        message.role === 'user' &&
        message.content.text.includes('x'.repeat(30_000))
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
    readonly phases: readonly string[];
  }> => {
    let requestCount = 0;
    let proposal: WorkerCommitProposalMessage | undefined;
    let failed: FailedTurn | undefined;
    let checkpoint: WorkerCheckpointProposalMessage | undefined;
    const phases: string[] = [];
    const model: Model = {
      generate(
        _request: ModelRequest,
        options: ModelGenerateOptions = {},
      ): ModelResult {
        requestCount += 1;
        options.providerEvidence?.startRequestMetadata({
          lane: options.providerEvidenceLane ?? 'parent',
          phase: options.providerEvidencePhase ?? 'user_turn',
          modelStep: options.modelStep ?? 1,
          endpoint: 'provider-free://counter-boundary',
          method: 'POST',
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
      providerObservation: (_correlation, observation) => {
        if (observation.kind === 'request_start') {
          phases.push(observation.request.phase ?? 'user_turn');
        }
      },
      checkpointProposal: (_correlation, value) => {
        checkpoint = value;
        return Promise.resolve(checkpointAccepted);
      },
      commitProposal: (_correlation, value) => {
        proposal = value;
        return Promise.resolve(true);
      },
      turnFailed: (_correlation, outcome) => {
        failed = { outcome };
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
    return { proposal, failed, checkpoint, requestCount, phases };
  };

  const accepted = await run(true);
  assertEquals(accepted.checkpoint, undefined);
  assert(accepted.proposal?.outcome !== undefined);
  assertEquals(accepted.requestCount, 1);
  assertEquals(accepted.proposal.outcome.turnProviderRequestCount, 1);
  assertEquals(accepted.proposal.outcome.runtimeProviderRequestCount, 1);
  assertEquals(
    accepted.phases,
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
      options.providerEvidence?.startRequestMetadata({
        lane: options.providerEvidenceLane ?? 'parent',
        phase: options.providerEvidencePhase ?? 'user_turn',
        modelStep: options.modelStep ?? 1,
        endpoint: 'provider-free://compaction-timeout',
        method: 'POST',
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
    }
    | undefined;
  const phases: string[] = [];
  const port: WorkerGenerationPort = {
    runtimeEvent: () => {},
    effectObservation: () => {},
    providerObservation: (_correlation, observation) => {
      if (observation.kind === 'request_start') {
        phases.push(observation.request.phase ?? 'user_turn');
      }
    },
    checkpointProposal: () => {
      throw new Error('timeout compaction must not propose a checkpoint');
    },
    commitProposal: () => {
      throw new Error('timeout compaction must not propose a turn commit');
    },
    turnFailed: (_correlation, outcome) => {
      failed = { outcome };
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
  assertEquals(
    presentationFailureReason(diagnostic),
    'provider deadline exceeded',
  );
  assertEquals(phases, ['user_turn']);
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
    toolDefinitions: await bundledToolDefinitionLoadRequests(),
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

Deno.test('a failed SQLite settlement cannot advertise a persisted artifact as recallable', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-recall-settlement-',
  });
  const workspaceRoot = Deno.cwd();
  const history = new SqliteHistoryV7ProductionStore(stateRoot, workspaceRoot, {
    fault: (phase) => {
      if (phase === 'before_settlement_commit') {
        throw new Error('simulated SQLite rollback');
      }
    },
  });
  await history.initialize();
  const definition = await readDefinitionRevision(
    workerBuiltinModulePath('default'),
    'builtin',
    'default',
  );
  const handle = await history.allocateWorker('default', definition);
  let listener: ((message: WorkerToHostMessage) => void) | undefined;
  const capsule: WorkerHostCapsule = {
    send: (command) => {
      if (command.kind === 'start') {
        const rootModel = command.modelSelection ??
          ROOT_DEFAULT_MODEL_SELECTION;
        listener?.({
          kind: 'ready',
          correlation: command.correlation,
          manifest: {
            role: 'parent',
            maxSteps: 8,
            profileId: modelRouteProfileId(rootModel),
            resources: [],
            rootModel,
          },
          startupSnapshot: { skillNames: [] },
          credentialAvailability: {
            authProfile: rootModel.authProfile,
            status: 'unknown',
          },
        });
      } else if (command.kind === 'turn') {
        const diagnostic = createFailureDiagnostic({
          stage: 'response_parse',
          code: 'response_error',
          lane: 'parent',
          providerRequestCount: 1,
          turnNumber: 1,
          modelStep: 1,
          retryCount: 0,
        });
        queueMicrotask(() =>
          listener?.({
            kind: 'turn_failed',
            correlation: command.correlation,
            outcome: {
              ok: false,
              task: command.task,
              outcome: 'contract_failure',
              stopReason: 'contract_failure',
              error: 'mock provider response invalid',
              steps: 1,
              toolCallCount: 0,
              toolResultCount: 0,
              transcript: [{
                role: 'user',
                content: { kind: 'text', text: command.task },
              }],
              diagnostic,
            },
            diagnostic,
          })
        );
      } else if (command.kind === 'close') {
        listener?.({ kind: 'closed', correlation: command.correlation });
      }
    },
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    terminate: () => {},
  };
  const host = await WorkerHostSession.open({
    handle,
    workspaceRoot,
    agent: 'default',
    definition,
    modulePath: workerBuiltinModulePath('default'),
    physicalIoMode: 'provider-free',
    executionArtifactStore: new FakeWorkerExecutionArtifactStore(),
    historyPersistence: history,
    durableCanonicalHistory: true,
    toolDefinitions: await bundledToolDefinitionLoadRequests(),
    capsuleFactory: () => capsule,
  });
  try {
    const outcome = await host.submit('failed settlement task');
    assert(!outcome.ok);
    assert(outcome.executionArtifactId !== undefined);
    assertEquals(outcome.executionArtifactDurability, 'yes');
    assertEquals(outcome.recallableExecutionId, undefined);
    const row = history.readExecution(outcome.executionArtifactId);
    assertEquals(row.lifecycle, 'active');
    try {
      await host.prepareRecall(outcome.executionArtifactId.slice(0, 8));
      throw new Error('recall unexpectedly selected the unsettled execution');
    } catch (error) {
      assert(error instanceof WorkerRecallSelectionError);
      assertEquals(error.code, 'unavailable');
    }
  } finally {
    await host.close();
    history.close();
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

Deno.test('Worker shares request accounting across turns without evidence documents', async () => {
  const created = await createWorkerSession({
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
  });
  try {
    const host = created.session;
    const readOutcome = await host.submit('read worker protocol');
    const secondOutcome = await host.submit('read worker protocol');
    assert(readOutcome.ok && secondOutcome.ok);
    assertEquals(
      {
        read: [
          readOutcome.steps,
          readOutcome.toolCallCount,
          readOutcome.toolResultCount,
        ],
        second: [
          secondOutcome.steps,
          secondOutcome.toolCallCount,
          secondOutcome.toolResultCount,
        ],
        requests: [
          readOutcome.turnProviderRequestCount,
          readOutcome.runtimeProviderRequestCount,
          secondOutcome.turnProviderRequestCount,
          secondOutcome.runtimeProviderRequestCount,
        ],
      },
      { read: [2, 1, 1], second: [2, 1, 1], requests: [0, 0, 0, 0] },
    );
    assertEquals(host.requestCount(), 0);
  } finally {
    await created.close();
  }
});
