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
import type { Message } from '../../v0/agent/core/contracts.ts';
import type {
  Model,
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
} from '../../v0/agent/core/contracts.ts';
import { Registry } from '../../v0/agent/tools/tools.ts';
import { ProviderEvidenceRecorder } from '../../v0/agent/provider/provider_evidence.ts';
import { SqliteHistoryV7ProductionStore } from '../../v0/agent/history/sqlite_history_v7_production_store.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_tui_session.ts';
import { runHeadlessWorker } from '../../v0/agent/worker/worker_headless_runner.ts';
import { resolveBuiltinAgent } from '../../v0/agent/definitions/agent_catalog.ts';
import { main as runtimeCliMain, parseRuntimeArgs } from '../../v0/agent/cli/runtime_cli.ts';
import { parseTuiInvocation } from '../../v0/agent/cli/session_invocation.ts';
import {
  WorkerGeneration,
  type WorkerGenerationPort,
} from '../../v0/agent/worker/worker_runtime.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';
import { OpenRouterAgentError } from '../../v0/agent/provider/openrouter_model.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import { validateFailureDiagnostic } from '../../v0/agent/session/failure_diagnostic.ts';
import { presentationFailureReason } from '../../v0/tui/state.ts';
import {
  createIncrement170FoundationDataHarness,
  foundationProposal,
  Increment170FoundationDataPortAgent,
  openIncrement170FoundationHost,
  readIncrement170FoundationArtifacts,
} from './helpers/increment_170_foundation_data.ts';
import { ConversationWriter } from '../../v0/agent/data/conversation_writer.ts';
import {
  DataRecallSelectionError,
  DataSessionOwner,
} from '../../v0/agent/data/session_data_owner.ts';
import { builtinDefinitionRef } from '../../v0/agent/definitions/managed_resource_ref.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';

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
  const root = await Deno.makeTempDir({ prefix: 'henji-headless-foundation-' });
  const stateRoot = `${root}/state`;
  let terminated = false;
  let startOptions: unknown;
  try {
    const result = await runHeadlessWorker(
      'read worker protocol',
      resolveBuiltinAgent(),
      {
        workspaceRoot: root,
        stateRoot,
        physicalIoMode: 'provider-free',
        rootMaxSteps: 160,
        providerTimeoutMs: 420_000,
        capsuleFactory: (url) => {
          const capsule = new WorkerCapsule(url);
          return {
            send: (command, transfer) => {
              if (command.kind === 'start') {
                startOptions = {
                  rootMaxSteps: command.rootMaxSteps,
                  providerTimeoutMs: command.providerTimeoutMs,
                };
              }
              capsule.send(command, transfer);
            },
            subscribe: (listener) => capsule.subscribe(listener),
            terminate: () => {
              terminated = true;
              capsule.terminate();
            },
          };
        },
      },
    );
    assert(result.outcome.ok);
    assertEquals(result.outcome.stopReason, 'final');
    assertEquals(result.requestCount, 0);
    assertEquals(terminated, true);
    assertEquals(startOptions, {
      rootMaxSteps: 160,
      providerTimeoutMs: 420_000,
    });
    const written = await readIncrement170FoundationArtifacts({
      stateRoot,
      workspaceRoot: root,
    });
    assertEquals(written.length, 1);
    assertEquals(written[0]?.manifest.maxSteps, 160);
    assert(!written[0]?.manifest.resources.includes('agent:planner'));
    assertEquals(written[0]?.storeResult, 'committed');
    assertEquals(written[0]?.acknowledgement, 'accepted_sent');
    assert(
      written[0]?.protocolTrace.some((entry) => entry.semanticSubtype === 'module_pre_read'),
    );
    assert(
      written[0]?.protocolTrace.some((entry) => entry.semanticSubtype === 'proposal_ready'),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('production subscriber does not retain delivered Worker messages across turns', async () => {
  let capsule: WorkerCapsule | undefined;
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-subscriber-foundation-',
  });
  const created = await createWorkerSession({
    stateRoot,
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
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Host keeps provider facts on the Agent Data path without retaining a response queue', async () => {
  const harness = await createIncrement170FoundationDataHarness({
    prefix: 'henji-provider-observation-foundation-',
  });
  let host:
    | Awaited<ReturnType<typeof openIncrement170FoundationHost>>
    | undefined;
  let store: SqliteHistoryV7ProductionStore | undefined;
  try {
    host = await openIncrement170FoundationHost(harness, {
      capsuleFactory: () =>
        new Increment170FoundationDataPortAgent((input) => {
          let sequence = 0;
          const recorder = new ProviderEvidenceRecorder(
            undefined,
            input.turnNumber,
            undefined,
            (observation) => {
              const messageSequence = ++sequence;
              input.data.observation({
                kind: 'provider_observation',
                correlation: input.command.correlation,
                sequence: messageSequence,
                turn: input.turnNumber,
                observation,
              });
              if (observation.kind === 'request_start') {
                input.requestStarted(
                  observation.request.ordinal,
                  observation.request.modelStep,
                );
              }
              return messageSequence;
            },
            false,
          );
          recorder.startRequestMetadata({
            lane: 'parent',
            modelStep: 1,
            contextRequestOrdinal: 1,
            endpoint: 'https://example.invalid/provider',
            method: 'POST',
          });
          recorder.recordResponse({ status: 200 });
          input.requestCount(1, input.turnNumber);
          const transcript: Message[] = [
            {
              role: 'user',
              content: { kind: 'text', text: input.command.task },
            },
            {
              role: 'assistant',
              content: {
                kind: 'text',
                text: `recorded provider request ${input.turnNumber}`,
              },
            },
          ];
          return foundationProposal({
            correlation: input.command.correlation,
            task: input.command.task,
            turn: input.turnNumber,
            transcript,
            outcome: {
              ok: true,
              outcome: 'final',
              stopReason: 'final',
              finalText: `recorded provider request ${input.turnNumber}`,
              steps: 1,
              toolCallCount: 0,
              toolResultCount: 0,
              turnProviderRequestCount: 1,
              runtimeProviderRequestCount: input.turnNumber,
            },
          });
        }),
    });
    for (let index = 1; index <= 3; index += 1) {
      const outcome = await host.submit(`provider observation turn ${index}`);
      assert(outcome.ok);
      const coordinator = Reflect.get(host, 'coordinator') as object;
      const supervisor = Reflect.get(coordinator, 'supervisor') as object;
      const messages = Reflect.get(supervisor, 'messages') as object;
      const queued = Reflect.get(messages, 'queue') as WorkerToHostMessage[];
      assert(
        queued.every((message) => message.kind === 'turn_settled'),
        'full provider observations must stay on the Agent Data port',
      );
    }
    store = new SqliteHistoryV7ProductionStore(
      harness.stateRoot,
      harness.workspaceRoot,
    );
    await store.initialize();
    const executions = store.listExecutions();
    assertEquals(executions.length, 3);
    for (const execution of executions) {
      assertEquals(
        store.readExecutionRequestFacts(execution.executionId, 1).map((fact) => fact.kind),
        ['provider_request_start', 'provider_response_start'],
      );
    }
  } finally {
    await host?.close();
    store?.close();
    await harness.close();
  }
});

Deno.test('short provider failure facts survive the Agent Data port and SQLite readback', async () => {
  const harness = await createIncrement170FoundationDataHarness({
    prefix: 'henji-short-facts-',
  });
  let host:
    | Awaited<ReturnType<typeof openIncrement170FoundationHost>>
    | undefined;
  let store: SqliteHistoryV7ProductionStore | undefined;
  try {
    host = await openIncrement170FoundationHost(harness, {
      capsuleFactory: () =>
        new Increment170FoundationDataPortAgent((input) => {
          let sequence = 0;
          const recorder = new ProviderEvidenceRecorder(
            undefined,
            input.turnNumber,
            undefined,
            (observation) => {
              const messageSequence = ++sequence;
              input.data.observation({
                kind: 'provider_observation',
                correlation: input.command.correlation,
                sequence: messageSequence,
                turn: input.turnNumber,
                observation,
              });
              if (observation.kind === 'request_start') {
                input.requestStarted(
                  observation.request.ordinal,
                  observation.request.modelStep,
                );
              }
              return messageSequence;
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
          input.requestCount(1, input.turnNumber);
          const transcript: Message[] = [
            {
              role: 'user',
              content: { kind: 'text', text: input.command.task },
            },
            {
              role: 'assistant',
              content: { kind: 'text', text: 'recorded the request facts' },
            },
          ];
          return foundationProposal({
            correlation: input.command.correlation,
            task: input.command.task,
            turn: input.turnNumber,
            transcript,
            outcome: {
              ok: true,
              outcome: 'final',
              stopReason: 'final',
              finalText: 'recorded the request facts',
              steps: 1,
              toolCallCount: 0,
              toolResultCount: 0,
              turnProviderRequestCount: 1,
              runtimeProviderRequestCount: input.turnNumber,
            },
          });
        }),
    });
    const outcome = await host.submit('record the request fact');
    assert(outcome.ok);
    store = new SqliteHistoryV7ProductionStore(
      harness.stateRoot,
      harness.workspaceRoot,
    );
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
    await host?.close();
    store?.close();
    await harness.close();
  }
});

Deno.test('terminal tool success flows through the Agent Data port and SQLite artifact readback', async () => {
  const harness = await createIncrement170FoundationDataHarness({
    prefix: 'henji-terminal-artifact-foundation-',
  });
  let host:
    | Awaited<ReturnType<typeof openIncrement170FoundationHost>>
    | undefined;
  try {
    host = await openIncrement170FoundationHost(harness, {
      capsuleFactory: () =>
        new Increment170FoundationDataPortAgent((input) => {
          const finalText = '{"ok":true}';
          const transcript: Message[] = [
            {
              role: 'user',
              content: { kind: 'text', text: input.command.task },
            },
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
          return foundationProposal({
            correlation: input.command.correlation,
            task: input.command.task,
            turn: input.turnNumber,
            transcript,
            outcome: {
              ok: true,
              outcome: 'final',
              stopReason: 'tool_terminal',
              finalText,
              terminalKind: 'json_result',
              steps: 1,
              toolCallCount: 1,
              toolResultCount: 1,
            },
          });
        }),
    });
    const outcome = await host.submit('submit terminal JSON');
    assert(outcome.ok);
    assertEquals(
      {
        outcome: outcome.outcome,
        stopReason: outcome.stopReason,
        finalText: outcome.finalText,
      },
      {
        outcome: 'final',
        stopReason: 'tool_terminal',
        finalText: '{"ok":true}',
      },
    );
    await host.close();
    const stored = await readIncrement170FoundationArtifacts(harness);
    assertEquals(stored.length, 1);
    assertEquals(
      {
        outcome: stored[0]?.outcome?.outcome,
        stopReason: stored[0]?.outcome?.stopReason,
        finalText: stored[0]?.outcome?.finalText,
        terminalKind: stored[0]?.outcome?.terminalKind,
        storeResult: stored[0]?.storeResult,
      },
      {
        outcome: 'final',
        stopReason: 'tool_terminal',
        finalText: '{"ok":true}',
        terminalKind: 'json_result',
        storeResult: 'committed',
      },
    );
  } finally {
    await host?.close();
    await harness.close();
  }
});

Deno.test('headless Worker model receives each active tool guideline once', async () => {
  const root = await Deno.makeTempDir({
    prefix: 'henji-guidelines-foundation-',
  });
  try {
    const result = await runHeadlessWorker(
      'return active tool guidelines',
      resolveBuiltinAgent(),
      {
        workspaceRoot: root,
        stateRoot: `${root}/state`,
        configRoot: `${root}/config`,
        dataRoot: `${root}/data`,
        physicalIoMode: 'provider-free',
      },
    );
    assert(result.outcome.ok);
    const instruction = result.outcome.finalText ?? '';
    const sections = instruction.split('## Active tool guidelines\n\n');
    assertEquals(sections.length, 2);
    const guidelines = sections[1].split('\n\n')[0].split('\n');
    assertEquals(new Set(guidelines).size, guidelines.length);
    for (const tool of ['bash_output', 'read', 'web_search']) {
      assert(guidelines.some((line) => line.startsWith(`- ${tool}:`)));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
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
  const harness = await createIncrement170FoundationDataHarness({
    prefix: 'henji-composition-foundation-',
  });
  let host:
    | Awaited<ReturnType<typeof openIncrement170FoundationHost>>
    | undefined;
  try {
    const definitionPath = definitionFile === 'worker_builtin_definition.ts'
      ? new URL(
        '../../v0/agent/worker/worker_builtin_definition.ts',
        import.meta.url,
      ).pathname
      : fixture(definitionFile);
    const revision = await readWorkerModuleRevision(definitionPath);
    let ready: WorkerReadyMessage | undefined;
    host = await openIncrement170FoundationHost(harness, {
      loadDescriptor: revision,
      ...(rootMaxSteps === undefined ? {} : { rootMaxSteps }),
      capsuleFactory: (url) => {
        const capsule = new WorkerCapsule(url);
        return {
          send: (command, transfer) => capsule.send(command, transfer),
          subscribe: (listener) =>
            capsule.subscribe((message) => {
              if (message.kind === 'ready') ready = message;
              listener(message);
            }),
          terminate: () => capsule.terminate(),
        };
      },
    });
    assert(ready !== undefined);
    assert(ready.manifest !== undefined);
    assertEquals(ready.credentialAvailability, {
      authProfile: ready.manifest.rootModel.authProfile,
      status: 'unknown',
    });
    assertEquals(ready.manifest.maxSteps, expectedMaxSteps);
    assertEquals(ready.manifest.role, 'parent');

    const outcome = await host.submit('read worker protocol');
    assert(outcome.ok);
    assert(outcome.finalText?.includes('worker answer: read worker protocol'));
    await host.close();
    return ready;
  } finally {
    await host?.close();
    await harness.close();
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
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-max-steps-one-' });
  const created = await createWorkerSession({
    stateRoot,
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
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Worker root request admission follows maxSteps beyond the former eight-step ceiling', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-max-steps-ten-' });
  const created = await createWorkerSession({
    stateRoot,
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
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Slice 3 keeps effect and cancellation semantics inside the Worker generation', async () => {
  const harness = await createIncrement170FoundationDataHarness({
    prefix: 'henji-effect-cancel-foundation-',
  });
  let host:
    | Awaited<ReturnType<typeof openIncrement170FoundationHost>>
    | undefined;
  try {
    host = await openIncrement170FoundationHost(harness, {
      capsuleFactory: (url) => new WorkerCapsule(url),
    });
    const ordinary = await host.submit('ordinary worker turn');
    assert(ordinary.ok);
    assert(ordinary.finalText?.includes('worker answer: ordinary worker turn'));

    const admission = await host.admit('slow cancellation turn');
    assertEquals(host.cancelActiveTurn(), 'requested');
    const cancelled = await admission.completion;
    assertEquals(cancelled.stopReason, 'cancelled');
    assert(!cancelled.ok);
  } finally {
    await host?.close();
    await harness.close();
  }
});

Deno.test('Slice 3 commits long user turns through Data without installing a checkpoint', async () => {
  const harness = await createIncrement170FoundationDataHarness({
    prefix: 'henji-long-turn-foundation-',
  });
  let host:
    | Awaited<ReturnType<typeof openIncrement170FoundationHost>>
    | undefined;
  try {
    host = await openIncrement170FoundationHost(harness, {
      capsuleFactory: (url) => new WorkerCapsule(url),
    });
    const tasks = [
      `first ${'x'.repeat(30_000)}`,
      `second ${'y'.repeat(30_000)}`,
      'held user turn after checkpoint',
    ];
    for (const task of tasks) {
      const outcome = await host.submit(task);
      assert(outcome.ok);
    }
    assertEquals(host.currentPosition().committedTurn, 3);
    assertEquals(host.contextSnapshot().checkpoint, undefined);

    const snapshot = await harness.data.conversationSnapshot(
      harness.descriptor.id,
    );
    const publicConversation = JSON.parse(
      new TextDecoder().decode(snapshot.bytes),
    ) as {
      readonly entities: Readonly<
        Record<string, {
          readonly kind: string;
          readonly role?: string;
          readonly text?: string;
        }>
      >;
    };
    const userText = Object.values(publicConversation.entities)
      .filter((entity) => entity.kind === 'message' && entity.role === 'user')
      .map((entity) => entity.text);
    for (const task of tasks) assert(userText.includes(task));
  } finally {
    await host?.close();
    await harness.close();
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

Deno.test('Data settlement rollback keeps canonical turn and recall state uncommitted', async () => {
  const root = await Deno.makeTempDir({ prefix: 'henji-recall-settlement-' });
  const workspaceRoot = `${root}/workspace`;
  await Deno.mkdir(workspaceRoot);
  const store = new SqliteHistoryV7ProductionStore(
    `${root}/state`,
    workspaceRoot,
    {
      fault: (phase) => {
        if (phase === 'before_settlement_commit') {
          throw new Error('simulated SQLite rollback');
        }
      },
    },
  );
  const writer = new ConversationWriter(store);
  let owner: DataSessionOwner | undefined;
  try {
    const definition = await builtinDefinitionRef('default', buildManifest());
    owner = await DataSessionOwner.open({
      store,
      writer,
      workspaceRoot,
      persistence: 'new',
      agent: 'default',
      definition,
    });
    const executionId = crypto.randomUUID().toLowerCase();
    const task = 'failed canonical settlement task';
    const correlation = {
      session: owner.sessionId,
      instanceCorrelation: 'foundation-settlement-instance',
      workerGeneration: 'foundation-settlement-generation',
      baseStateRevision: owner.descriptor().stateRevision,
      command: 'foundation-settlement-task',
    };
    await owner.admit({
      executionId,
      taskId: crypto.randomUUID().toLowerCase(),
      task,
      correlation,
      manifest: {
        role: 'parent',
        maxSteps: 8,
        profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
        resources: [],
        rootModel: ROOT_DEFAULT_MODEL_SELECTION,
      },
    });
    const transcript: Message[] = [
      { role: 'user', content: { kind: 'text', text: task } },
      {
        role: 'assistant',
        content: { kind: 'text', text: 'proposed answer' },
      },
    ];
    const token = await owner.prepareProposal({
      proposalId: 'foundation-settlement-proposal',
      executionId,
      finalDataSequence: 0,
      message: {
        kind: 'commit_proposal',
        correlation,
        transcript,
        nextTurn: 2,
      },
    });
    let settlementError: unknown;
    try {
      owner.authorizeCommit(token, { accepted: true });
    } catch (error) {
      settlementError = error;
    }
    assert(
      settlementError instanceof Error,
      'SQLite settlement should roll back',
    );

    const row = store.readExecution(executionId);
    assertEquals(row.lifecycle, 'active');
    const session = await store.readWorker(owner.sessionId);
    assertEquals(
      {
        nextTurn: session.nextTurn,
        stateRevision: session.stateRevision,
        transcript: session.transcript,
        committedTurn: owner.authority.currentPosition().committedTurn,
      },
      { nextTurn: 1, stateRevision: 1, transcript: [], committedTurn: 0 },
    );
    assertEquals(
      store.readExecutionMetadata(executionId).artifactCapture,
      'none',
    );
    assert(
      (await store.executionArtifacts.list()).some((artifact) =>
        artifact.executionId === executionId
      ),
      'the independently derived artifact document remains unlinked after rollback',
    );
    let recallError: unknown;
    try {
      await owner.prepareRecall(executionId.slice(0, 8));
    } catch (error) {
      recallError = error;
    }
    assert(recallError instanceof DataRecallSelectionError);
    assertEquals(recallError.code, 'not_found');
    const sessionId = owner.sessionId;
    await owner.close();
    owner = await DataSessionOwner.open({
      store,
      writer,
      workspaceRoot,
      persistence: 'session',
      sessionId,
      agent: 'default',
      definition: await builtinDefinitionRef('default', buildManifest()),
    });
    let reopenedRecallError: unknown;
    try {
      await owner.prepareRecall(executionId.slice(0, 8));
    } catch (error) {
      reopenedRecallError = error;
    }
    assert(reopenedRecallError instanceof DataRecallSelectionError);
    assertEquals(reopenedRecallError.code, 'not_found');
  } finally {
    await owner?.close();
    writer.close();
    store.close();
    await Deno.remove(root, { recursive: true });
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

Deno.test('Worker shares request accounting across turns without evidence documents', async () => {
  const stateRoot = await Deno.makeTempDir({
    prefix: 'henji-request-count-foundation-',
  });
  const created = await createWorkerSession({
    stateRoot,
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
    await Deno.remove(stateRoot, { recursive: true });
  }
});
