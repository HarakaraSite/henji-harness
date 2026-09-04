import {
  readWorkerModuleRevision,
  WorkerCapsule,
  workerTextByteLength,
} from '../../v0/agent/worker_capsule.ts';
import type {
  WorkerCheckpointProposalMessage,
  WorkerClosedMessage,
  WorkerCommitProposalMessage,
  WorkerErrorMessage,
  WorkerHostCommand,
  WorkerReadyMessage,
  WorkerRuntimeEventMessage,
  WorkerToHostMessage,
} from '../../v0/agent/worker_protocol.ts';
import type { AssistantMessage, Message } from '../../v0/agent/contracts.ts';
import type {
  Model,
  ModelGenerateOptions,
  ModelRequest,
  ModelResult,
} from '../../v0/agent/contracts.ts';
import type { AgentEvent } from '../../v0/agent/events.ts';
import { Registry } from '../../v0/agent/tools.ts';
import { DenoSessionStore, type SessionRecord } from '../../v0/agent/session_store.ts';
import {
  decodeProviderEvidence,
  encodeProviderEvidence,
  FakeProviderEvidenceStore,
} from '../../v0/agent/provider_evidence.ts';
import {
  createWorkerTuiSession,
  readDefinitionRevision,
  workerBuiltinModulePath,
  type WorkerHostCapsule,
  WorkerHostSession,
} from '../../v0/agent/worker_host.ts';
import { parseTuiInvocation } from '../../v0/agent/tui_cli.ts';
import { createTuiPresentationAdapter } from '../../v0/agent/tui_presentation_adapter.ts';
import { WorkerGeneration, type WorkerGenerationPort } from '../../v0/agent/worker_runtime.ts';
import type { WorkerAgentComposition } from '../../v0/agent/worker_agent_api.ts';

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
  '../../v0/agent/worker_bootstrap.ts',
  import.meta.url,
);
const fixture = (name: string): string =>
  new URL(`../../v0/agent/worker_fixtures/${name}`, import.meta.url).pathname;

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
const isCheckpointProposal = (
  message: WorkerToHostMessage,
): message is WorkerCheckpointProposalMessage => message.kind === 'checkpoint_proposal';
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
      readSpecifier: new URL('../../v0/agent/worker_protocol.ts', import.meta.url).href,
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
): Promise<WorkerReadyMessage> => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    const definitionPath = definitionFile === 'worker_builtin_definition.ts'
      ? new URL('../../v0/agent/worker_builtin_definition.ts', import.meta.url)
        .pathname
      : fixture(definitionFile);
    const revision = await readWorkerModuleRevision(definitionPath);
    const readyPromise = capsule.waitForMessage(isReady);
    capsule.send({
      kind: 'start',
      correlation: correlation(`composition-${definitionFile}`),
      module: revision,
      workspaceRoot: Deno.cwd(),
    });
    const ready = await readyPromise;
    assert(ready.manifest !== undefined);
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
  const builtin = await runCompositionTurn('worker_builtin_definition.ts', 8);
  const external = await runCompositionTurn('external_definition.ts', 4);
  assert(builtin.manifest !== undefined && external.manifest !== undefined);
  assertEquals(builtin.manifest.resources, external.manifest.resources);
});

Deno.test('Slice 3 keeps planner, effect, and cancellation semantics inside the Worker generation', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  try {
    const revision = await readWorkerModuleRevision(
      new URL('../../v0/agent/worker_builtin_definition.ts', import.meta.url)
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

Deno.test('Slice 3 holds a user turn across automatic checkpoint proposal and Host acknowledgement', async () => {
  const capsule = new WorkerCapsule(workerUrl);
  const sessionCorrelation = compactionCorrelation('compaction-start');
  try {
    const revision = await readWorkerModuleRevision(
      new URL('../../v0/agent/worker_builtin_definition.ts', import.meta.url)
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
    const checkpoint = await capsule.waitForMessage(isCheckpointProposal);
    assertEquals(checkpoint.heldUserText, heldText);
    assertEquals(checkpoint.checkpoint.contextSchemaVersion, 1);
    assert(checkpoint.checkpoint.coveredThroughTurn >= 1);
    capsule.send({
      kind: 'checkpoint_acknowledgement',
      correlation: checkpoint.correlation,
      accepted: true,
    });
    const proposal = await capsule.waitForMessage(isCommitProposal);
    assert(
      proposal.transcript.some((message) =>
        isTextAssistant(message) && message.content.text.includes(heldText)
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

Deno.test('Compaction evidence and request counts stop at the checkpoint acknowledgement boundary', async () => {
  type FailedTurn = {
    readonly outcome: import('../../v0/agent/contracts.ts').LoopOutcome;
    readonly evidence: import('../../v0/agent/provider_evidence.ts').ProviderEvidenceV1;
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
          requestMetadata: { contentType: 'application/json', responseMode: 'json' },
        });
        return options.providerEvidencePhase === 'compaction'
          ? { kind: 'final', text: '{"schemaVersion":1,"summary":"retained context"}' }
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
      resolved: { model: { profile: { id: 'provider-free-counter-boundary' } } },
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
        if (evidence === undefined) throw new Error('missing provider evidence');
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
  assert(accepted.checkpoint !== undefined, JSON.stringify(accepted));
  assert(accepted.proposal?.outcome !== undefined);
  assertEquals(accepted.requestCount, 2);
  assertEquals(accepted.proposal.outcome.turnProviderRequestCount, 1);
  assertEquals(accepted.proposal.outcome.runtimeProviderRequestCount, 2);
  assertEquals(
    accepted.proposal.providerEvidence?.requests.map((record) => record.request.phase),
    ['compaction', 'user_turn'],
  );
  const evidenceStore = new FakeProviderEvidenceStore();
  await evidenceStore.write(accepted.proposal.providerEvidence!);
  const readback = await evidenceStore.read(accepted.proposal.providerEvidence!.evidenceId);
  assertEquals(decodeProviderEvidence(encodeProviderEvidence(readback)), readback);
  const legacyWithoutPhase = {
    ...readback,
    requests: readback.requests.map((record) => ({
      ...record,
      request: Object.fromEntries(
        Object.entries(record.request).filter(([key]) => key !== 'phase'),
      ),
    })),
  };
  const legacyReadback = decodeProviderEvidence(JSON.stringify(legacyWithoutPhase));
  assertEquals(legacyReadback.requests.map((record) => record.request.phase), [
    undefined,
    undefined,
  ]);

  const rejected = await run(false);
  assert(rejected.checkpoint !== undefined);
  assert(rejected.failed !== undefined);
  assertEquals(rejected.proposal, undefined);
  assertEquals(rejected.requestCount, 1);
  assertEquals(rejected.failed.outcome.turnProviderRequestCount, 0);
  assertEquals(rejected.failed.outcome.runtimeProviderRequestCount, 1);
  assertEquals(
    rejected.failed.evidence.requests.map((record) => record.request.phase),
    ['compaction'],
  );
});

Deno.test('Slices 4–6 commit Worker proposals durably and reopen built-in/external bindings', async () => {
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
    assert(saved.schemaVersion === 2);
    assertEquals(saved.definition, definition);
    assertEquals(saved.stateRevision, 2);

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

    const externalPath = fixture('external_definition.ts');
    const external = await readDefinitionRevision(externalPath, 'external');
    const externalHandle = await store.allocateWorker('default', external);
    const externalHost = await WorkerHostSession.open({
      handle: externalHandle,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition: external,
      modulePath: externalPath,
      physicalIoMode: 'provider-free',
    });
    assert((await externalHost.submit('read worker protocol')).ok);
    await externalHost.close();
    const externalSaved = await store.readWorker(externalHandle.id);
    assert(externalSaved.schemaVersion === 2);
    assertEquals(externalSaved.definition.kind, 'external');

    const ephemeral = await createWorkerTuiSession({
      persistence: 'none',
      agent: 'default',
      externalDefinitionPath: externalPath,
      physicalIoMode: 'provider-free',
    });
    assert((await ephemeral.session.submit('read worker protocol')).ok);
    await ephemeral.close();
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

Deno.test('Slice 4 reads a legacy v1 record and upgrades it only on the next durable Worker commit', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-v1-' });
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(
      modulePath,
      'builtin',
      'default',
    );
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocate('default');
    const record: SessionRecord = {
      schemaVersion: 1,
      sessionId: handle.id,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      nextTurn: 2,
      transcript: [
        { role: 'user', content: { kind: 'text', text: 'legacy turn' } },
        { role: 'assistant', content: { kind: 'text', text: 'legacy answer' } },
      ],
    };
    handle.commit(record);
    await handle.close();
    const reopened = await store.openExistingWorker(record.sessionId);
    const host = await WorkerHostSession.open({
      handle: reopened,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      definition,
      modulePath,
      physicalIoMode: 'provider-free',
    });
    assert((await host.submit('read worker protocol')).ok);
    await host.close();
    const upgraded = await store.readWorker(record.sessionId);
    assertEquals(upgraded.schemaVersion, 2);
    if (upgraded.schemaVersion !== 2) {
      throw new Error('legacy record was not upgraded');
    }
    assertEquals(upgraded.definition, definition);
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('Slices 4–6 install Worker checkpoints beside v2 state and reuse them after reopen', async () => {
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
    assert((await host.submit('held after automatic compaction')).ok);
    const checkpoint = host.checkpointSnapshot();
    assert(checkpoint !== undefined);
    assert(checkpoint.coveredThroughTurn >= 1);
    assertEquals((await store.readCheckpoint(handle.id))?.sessionId, handle.id);
    await host.close();

    const reopenedHandle = await store.openExistingWorker(handle.id);
    assert((await store.readCheckpoint(handle.id))?.sessionId === handle.id);
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

Deno.test('Slice 5 parses --definition with the existing persistence flags before startup', () => {
  assertEquals(
    parseTuiInvocation(['--definition', 'worker.ts', '--no-session']),
    {
      rawAgentName: undefined,
      definitionPath: 'worker.ts',
      persistence: 'none',
    },
  );
  let rejected = false;
  try {
    parseTuiInvocation(['--agent', 'default', '--definition', 'worker.ts']);
  } catch {
    rejected = true;
  }
  assert(rejected);
});

Deno.test('Host turn settlement does not apply the five-second queue timeout', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-delayed-' });
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(modulePath, 'builtin', 'default');
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
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-evidence-' });
  try {
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(modulePath, 'builtin', 'default');
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
        read: [readOutcome.steps, readOutcome.toolCallCount, readOutcome.toolResultCount],
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
    assert(evidence[1].runtimeEvents.some((event) => event.kind === 'model_result'));
    assert(evidence[1].runtimeEvents.some((event) => event.kind === 'tool_call'));
    assertEquals(host.requestCount(), 0);
    await host.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('WorkerHost exposes one-shot automatic compaction notice to the adapter', async () => {
  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-notice-' });
  let sessionId: string | undefined;
  try {
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocate('default');
    sessionId = handle.id;
    const transcript: Message[] = [];
    for (let turn = 1; turn <= 2; turn += 1) {
      transcript.push({ role: 'user', content: { kind: 'text', text: `old task ${turn}` } });
      transcript.push({
        role: 'assistant',
        content: { kind: 'text', text: `${'old answer '.repeat(20_000)}${turn}` },
      });
    }
    handle.commit({
      schemaVersion: 1,
      sessionId: handle.id,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      nextTurn: 3,
      transcript,
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
        text: 'read after automatic compaction',
      });
      const notices = presentationEvents.filter((event) =>
        typeof event === 'object' && event !== null &&
        (event as { readonly kind?: unknown }).kind === 'notice'
      );
      assertEquals(notices.length, 1);
      assert((notices[0] as { readonly text: string }).text.includes('auto-compacted'));
      assertEquals(created.session.consumeAutoCompactionNotice(), null);
    } finally {
      await created.close();
    }
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});

Deno.test('WorkerHost clears an automatic compaction notice when checkpoint ack delivery fails', async () => {
  class CheckpointAckFailureCapsule implements WorkerHostCapsule {
    private readonly listeners = new Set<(message: WorkerToHostMessage) => void>();
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
            profileId: 'openrouter-google-gemini-3.7-flash-vertex-v0',
            resources: [],
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
              sourceProfileId: 'openrouter-google-gemini-3.7-flash-vertex-v0',
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

  const stateRoot = await Deno.makeTempDir({ prefix: 'henji-worker-notice-failure-' });
  let sessionId: string | undefined;
  try {
    const store = new DenoSessionStore(stateRoot, Deno.cwd());
    const handle = await store.allocate('default');
    sessionId = handle.id;
    handle.commit({
      schemaVersion: 1,
      sessionId: handle.id,
      workspaceRoot: Deno.cwd(),
      agent: 'default',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      nextTurn: 3,
      transcript: [
        { role: 'user', content: { kind: 'text', text: 'old task 1' } },
        { role: 'assistant', content: { kind: 'text', text: 'old answer 1' } },
        { role: 'user', content: { kind: 'text', text: 'old task 2' } },
        { role: 'assistant', content: { kind: 'text', text: 'old answer 2' } },
      ],
    });
    await handle.close();
    const definition = await readDefinitionRevision(
      workerBuiltinModulePath('default'),
      'builtin',
      'default',
    );
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
    private readonly listeners = new Set<(message: WorkerToHostMessage) => void>();
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
            profileId: 'openrouter-google-gemini-3.7-flash-vertex-v0',
            resources: [],
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
                event: { kind: 'assistant_progress', turn: 1, text: 'before commit' },
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
              { role: 'assistant', content: { kind: 'text', text: 'committed answer' } },
            ],
          });
        });
      } else if (command.kind === 'commit_acknowledgement' && command.accepted) {
        queueMicrotask(() => {
          if (this.terminated) return;
          this.emit({
            kind: 'runtime_event',
            correlation: command.correlation,
            sequence: 2,
            event: {
              kind: 'agent_event',
              event: { kind: 'turn_end', turn: 1, outcome: 'final', committed: true },
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
    readonly outcome: import('../../v0/agent/contracts.ts').LoopOutcome;
    readonly host: WorkerHostSession;
    readonly capsule: EventFailureCapsule;
    readonly cleanup: () => Promise<void>;
  }> => {
    const stateRoot = await Deno.makeTempDir({ prefix: `henji-worker-event-${mode}-` });
    const modulePath = workerBuiltinModulePath('default');
    const definition = await readDefinitionRevision(modulePath, 'builtin', 'default');
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
        if (event.kind === failingKind) throw new Error('simulated presentation failure');
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
            profileId: 'openrouter-google-gemini-3.7-flash-vertex-v0',
            resources: [],
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
      capsuleFactory: () => new AckFailureCapsule(),
    });
    const outcome = await host.submit('ack failure task');
    assert(outcome.ok);
    assertEquals(host.currentPosition().committedTurn, 1);
    assert(!host.isAvailable());
    const saved = await store.readWorker(handle.id);
    assert(saved.schemaVersion === 2);
    let rejected = false;
    try {
      await host.submit('must not replay');
    } catch {
      rejected = true;
    }
    assert(rejected);
    await host.close();
  } finally {
    await Deno.remove(stateRoot, { recursive: true });
  }
});
