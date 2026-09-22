import type { ProviderEvidenceV2 } from '../../v0/agent/provider/provider_evidence.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { PRODUCTION_PROFILE } from '../../v0/agent/provider/provider_profile.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import type {
  WorkerExecutionArtifactV2,
  WorkerExecutionTraceEntry,
} from '../../v0/agent/worker/worker_execution_artifact.ts';
import {
  PRODUCTION_CLI_E2E_CONFIRMATION,
  PRODUCTION_CLI_E2E_TASK,
} from '../../v0/agent/validation/production_cli_e2e_contract.ts';
import {
  main,
  PRODUCTION_CLI_E2E_PATH,
  PRODUCTION_CLI_LAUNCHER,
  type ProductionCliCommandOptions,
  runProductionCliE2e,
} from '../../v0/agent/validation/production_cli_e2e.ts';

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

const NONCE = 'henji-e2e-offlinefixture0000000000000001';
const EVIDENCE_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';
const CALL_ID = 'read-1';

const correlation = {
  session: '33333333-3333-4333-8333-333333333333',
  instanceCorrelation: 'instance-1',
  workerGeneration: 'generation-1',
  baseStateRevision: 1,
  command: 'turn-1',
} as const;

const traceEntry = (
  direction: WorkerExecutionTraceEntry['direction'],
  kind: WorkerExecutionTraceEntry['kind'],
  semanticSubtype: string,
  sequence: number,
  ackAccepted?: boolean,
): WorkerExecutionTraceEntry => ({
  direction,
  kind,
  semanticSubtype,
  sequence,
  correlation,
  ...(ackAccepted === undefined ? {} : { ackAccepted }),
});

const executionFixture = (overrides: Partial<WorkerExecutionArtifactV2> = {}) =>
  ({
    schemaVersion: 2,
    executionId: EXECUTION_ID,
    createdAt: '2026-09-08T00:00:00.000Z',
    settledAt: '2026-09-08T00:00:01.000Z',
    sessionId: correlation.session,
    turn: 1,
    agent: 'default',
    instanceCorrelation: correlation.instanceCorrelation,
    workerGeneration: correlation.workerGeneration,
    build: buildManifest(),
    definition: {
      schemaVersion: 1,
      resourceKind: 'agent-definition',
      resourceId: 'builtin/default',
      revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
    },
    manifest: {
      role: 'parent',
      maxSteps: 64,
      profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
      resources: [],
      rootModel: ROOT_DEFAULT_MODEL_SELECTION,
    },
    command: { kind: 'turn', correlation, task: PRODUCTION_CLI_E2E_TASK },
    baseStateRevision: 1,
    proposedStateRevision: 2,
    committedStateRevision: 2,
    protocolTrace: [
      traceEntry('host_to_worker', 'start', 'start', 1),
      traceEntry('worker_to_host', 'runtime_event', 'module_pre_read', 2),
      traceEntry('worker_to_host', 'runtime_event', 'module_import_start', 3),
      traceEntry('worker_to_host', 'runtime_event', 'module_imported', 4),
      traceEntry('worker_to_host', 'ready', 'ready', 5),
      traceEntry('host_to_worker', 'turn', 'turn', 6),
      traceEntry('worker_to_host', 'provider_observation', 'runtime_event', 7),
      traceEntry('worker_to_host', 'commit_proposal', 'commit_proposal', 8),
      traceEntry(
        'host_to_worker',
        'commit_acknowledgement',
        'commit_acknowledgement',
        9,
        true,
      ),
      traceEntry('worker_to_host', 'runtime_event', 'turn_end', 10),
    ],
    providerEvidenceId: EVIDENCE_ID,
    providerEvidenceDurability: 'yes',
    storeResult: 'committed',
    acknowledgement: 'accepted_sent',
    settlement: 'committed',
    outcome: {
      ok: true,
      outcome: 'final',
      stopReason: 'final',
      finalText: NONCE,
      steps: 2,
      toolCallCount: 1,
      toolResultCount: 1,
      turnProviderRequestCount: 2,
      runtimeProviderRequestCount: 2,
    },
    effectCommitRelation: 'not_transactional',
    automaticReplay: false,
    ...overrides,
  }) satisfies WorkerExecutionArtifactV2;

const evidenceFixture = (overrides: Partial<ProviderEvidenceV2> = {}) => {
  const call = {
    callId: CALL_ID,
    name: 'read',
    arguments: { path: 'e2e-input.txt' },
  } as const;
  const request = (ordinal: number) => ({
    request: {
      ordinal,
      contextRequestOrdinal: ordinal,
      lane: 'parent' as const,
      phase: 'user_turn' as const,
      modelStep: ordinal,
      endpoint: `${PRODUCTION_PROFILE.origin}${PRODUCTION_PROFILE.path}`,
      method: 'POST' as const,
      requestBody: JSON.stringify({ model: PRODUCTION_PROFILE.model, stream: true }),
      requestBodyBytes: 64,
      requestMetadata: {
        contentType: 'application/json',
        redirect: 'error',
        responseMode: 'sse' as const,
        origin: 'root_model' as const,
        provider: ROOT_DEFAULT_MODEL_SELECTION.provider,
        api: ROOT_DEFAULT_MODEL_SELECTION.api,
        modelId: ROOT_DEFAULT_MODEL_SELECTION.modelId,
        authProfile: ROOT_DEFAULT_MODEL_SELECTION.authProfile,
        effort: ROOT_DEFAULT_MODEL_SELECTION.effort,
        protocol: 'sse' as const,
      },
    },
    response: { status: 200, headers: {}, rawBodyBytes: 1 },
    sseEvents: [{
      ordinal: 1,
      data: '{}',
      rawFrame: 'data: {}\n\n',
      rawFrameBytes: 10,
      responseBodyOffset: 10,
      parsed: {},
    }],
    parserTransitions: [{ ordinal: 1, kind: 'result' as const, reason: 'done' }],
  });
  return {
    schemaVersion: 2,
    evidenceId: EVIDENCE_ID,
    sessionId: correlation.session,
    build: buildManifest(),
    definition: {
      schemaVersion: 1,
      resourceKind: 'agent-definition',
      resourceId: 'builtin/default',
      revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
    },
    turnNumber: 1,
    createdAt: '2026-09-08T00:00:00.000Z',
    requests: [request(1), request(2)],
    runtimeEvents: [
      { kind: 'model_result', modelStep: 1, result: { kind: 'tool_calls', calls: [call] } },
      { kind: 'tool_call', modelStep: 1, call },
      {
        kind: 'tool_result',
        modelStep: 1,
        result: {
          kind: 'tool_result',
          callId: CALL_ID,
          name: 'read',
          text: NONCE,
          outcome: 'success',
        },
      },
      { kind: 'model_result', modelStep: 2, result: { kind: 'final', text: NONCE } },
      { kind: 'turn_outcome', outcome: 'final' },
    ],
    turnProviderRequestCount: 2,
    runtimeProviderRequestCount: 2,
    outcome: 'final',
    ...overrides,
  } satisfies ProviderEvidenceV2;
};

const retainedRoot = async (report: { readonly runRoot: string | null }): Promise<void> => {
  if (report.runRoot !== null) await Deno.remove(report.runRoot, { recursive: true });
};

Deno.test('production CLI E2E requires the exact live confirmation argument', async () => {
  let childCount = 0;
  for (const args of [[], ['--confirm-external-call', 'extra'], ['--yes']]) {
    const report = await runProductionCliE2e(args, {
      runChild: () => {
        childCount += 1;
        throw new Error('must not start');
      },
    });
    assertEquals(
      {
        ok: report.ok,
        stage: report.ok ? null : report.stage,
        code: report.ok ? null : report.code,
      },
      { ok: false, stage: 'preflight', code: 'invalid_invocation' },
    );
    assertEquals(report.runRoot, null);
  }
  assertEquals(childCount, 0);
});

Deno.test('production CLI E2E launches one fixed production command and accepts retained proof', async () => {
  let childCount = 0;
  let observed: ProductionCliCommandOptions | undefined;
  const report = await runProductionCliE2e([PRODUCTION_CLI_E2E_CONFIRMATION], {
    nonce: () => NONCE,
    runChild: (command, options, deadlineMs) => {
      childCount += 1;
      assertEquals(command, PRODUCTION_CLI_LAUNCHER);
      assertEquals(deadlineMs, 120_000);
      observed = options;
      return Promise.resolve({
        started: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `${NONCE}\n`,
        stderr: '',
      });
    },
    listExecutions: () => Promise.resolve([executionFixture()]),
    listEvidence: () => Promise.resolve([evidenceFixture()]),
    sessionTranscriptExists: () => Promise.resolve(false),
  });
  try {
    assert(report.ok);
    assertEquals(childCount, 1);
    assertEquals(observed?.args, ['run']);
    assertEquals(observed?.input, `${PRODUCTION_CLI_E2E_TASK}\n`);
    assertEquals(observed?.stdin, 'piped');
    assertEquals(observed?.clearEnv, true);
    assertEquals(observed?.env, {
      HOME: Deno.env.get('HOME'),
      XDG_CONFIG_HOME: `${Deno.env.get('HOME')}/.config`,
      XDG_DATA_HOME: `${report.runRoot}/data`,
      XDG_STATE_HOME: `${report.runRoot}/state`,
      PATH: PRODUCTION_CLI_E2E_PATH,
    });
    assertEquals(observed?.cwd, report.workspaceRoot);
    assertEquals(await Deno.readTextFile(report.noncePath), NONCE);
    assertEquals(await Deno.readTextFile(report.childStdoutPath), `${NONCE}\n`);
    assertEquals(await Deno.readTextFile(report.childStderrPath), '');
    assertEquals(
      {
        executionId: report.executionId,
        evidenceId: report.providerEvidenceId,
        requests: report.externalRequests,
        steps: report.steps,
        toolOrder: report.toolOrder,
        stop: report.stopReason,
        retry: report.retryCount,
      },
      {
        executionId: EXECUTION_ID,
        evidenceId: EVIDENCE_ID,
        requests: 2,
        steps: 2,
        toolOrder: ['read'],
        stop: 'final',
        retry: 0,
      },
    );
  } finally {
    await retainedRoot(report);
  }
});

Deno.test('production CLI E2E retains child failure and emits one JSON report', async () => {
  const output: string[] = [];
  let reportRoot: string | null = null;
  const exit = await main([PRODUCTION_CLI_E2E_CONFIRMATION], {
    nonce: () => NONCE,
    runChild: () =>
      Promise.resolve({
        started: true,
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: 'child diagnostic\n',
      }),
    listExecutions: () => Promise.resolve([]),
    listEvidence: () => Promise.resolve([]),
    sessionTranscriptExists: () => Promise.resolve(false),
    writeStdout: (text) => {
      output.push(text);
    },
  });
  const report = JSON.parse(output.join('')) as {
    readonly ok: boolean;
    readonly stage: string;
    readonly code: string;
    readonly runRoot: string;
    readonly childStderrPath: string;
    readonly retryCount: number;
  };
  reportRoot = report.runRoot;
  try {
    assertEquals(exit, 1);
    assertEquals(output.length, 1);
    assert(output[0].endsWith('\n'));
    assertEquals(
      { ok: report.ok, stage: report.stage, code: report.code, retry: report.retryCount },
      { ok: false, stage: 'process', code: 'child_exit', retry: 0 },
    );
    assertEquals(await Deno.readTextFile(report.childStderrPath), 'child diagnostic\n');
  } finally {
    if (reportRoot !== null) await Deno.remove(reportRoot, { recursive: true });
  }
});

Deno.test('production CLI E2E distinguishes channel, artifact, and evidence failures', async () => {
  const cases = [
    {
      stderr: 'unexpected',
      executions: [executionFixture()],
      evidence: [evidenceFixture()],
      expected: ['cli_contract', 'child_stderr'],
    },
    {
      stderr: '',
      executions: [],
      evidence: [evidenceFixture()],
      expected: ['execution_artifact', 'execution_count_mismatch'],
    },
    {
      stderr: '',
      executions: [executionFixture()],
      evidence: [],
      expected: ['provider_evidence', 'evidence_count_mismatch'],
    },
    {
      stderr: '',
      executions: [executionFixture()],
      evidence: [evidenceFixture({ runtimeEvents: [] })],
      expected: ['model_behavior', 'evidence_runtime_mismatch'],
    },
  ] as const;
  for (const item of cases) {
    const report = await runProductionCliE2e([PRODUCTION_CLI_E2E_CONFIRMATION], {
      nonce: () => NONCE,
      runChild: () =>
        Promise.resolve({
          started: true,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: `${NONCE}\n`,
          stderr: item.stderr,
        }),
      listExecutions: () => Promise.resolve(item.executions),
      listEvidence: () => Promise.resolve(item.evidence),
      sessionTranscriptExists: () => Promise.resolve(false),
    });
    try {
      assert(!report.ok);
      assertEquals([report.stage, report.code], item.expected);
    } finally {
      await retainedRoot(report);
    }
  }
});

Deno.test('offline gate cannot reach the production E2E live task', async () => {
  const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
    readonly tasks: Readonly<Record<string, string>>;
  };
  const live = config.tasks['agent:e2e:live'];
  const offline = config.tasks['agent:e2e:test'];
  assert(typeof live === 'string');
  assert(typeof offline === 'string');
  assert(live.includes(PRODUCTION_CLI_LAUNCHER));
  assert(live.includes(PRODUCTION_CLI_E2E_CONFIRMATION) === false);
  assert(!live.includes('--allow-net'));
  assert(!live.includes('openrouter-api-key'));
  assert(!offline.includes('--allow-run'));
  assert(!offline.includes('--allow-net'));
  assert(offline.includes('--allow-env=HOME'));
  assert(config.tasks['v0:test'].includes('agent:e2e:test'));
  assert(!config.tasks['v0:test'].includes('agent:e2e:live'));
  assert(!config.tasks['v0:gate'].includes('agent:e2e:live'));
});
