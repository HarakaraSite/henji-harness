import type { StoredExecutionEvent } from '../../v0/agent/history/history_store_contract.ts';
import { buildManifest } from '../../v0/agent/runtime/build_manifest.ts';
import { PRODUCTION_PROFILE } from '../../v0/agent/provider/provider_profile.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { modelRouteProfileId } from '../../v0/agent/provider/model_selection.ts';
import type { StoredWorkerExecutionArtifact } from '../../v0/agent/worker/worker_execution_artifact.ts';
import {
  PRODUCTION_CLI_E2E_CONFIRMATION,
  PRODUCTION_CLI_E2E_TASK,
} from '../../v0/agent/validation/production_cli_e2e_contract.ts';
import {
  PRODUCTION_CLI_LAUNCHER,
  runProductionCliE2e,
} from '../../v0/agent/validation/production_cli_e2e.ts';

function assert(value: unknown): asserts value {
  if (!value) throw new Error('assertion failed');
}

const equals = (actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(JSON.stringify(actual) + ' !== ' + JSON.stringify(expected));
  }
};

const nonce = 'henji-e2e-offlinefixture0000000000000001';
const executionId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const correlation = {
  session: sessionId,
  instanceCorrelation: 'instance-1',
  workerGeneration: 'generation-1',
  baseStateRevision: 1,
  command: 'turn-1',
} as const;

const artifact = (): StoredWorkerExecutionArtifact => ({
  schemaVersion: 2,
  executionId,
  createdAt: '2026-09-08T00:00:00.000Z',
  settledAt: '2026-09-08T00:00:01.000Z',
  sessionId,
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
    maxSteps: 128,
    profileId: modelRouteProfileId(ROOT_DEFAULT_MODEL_SELECTION),
    resources: [],
    rootModel: ROOT_DEFAULT_MODEL_SELECTION,
  },
  command: { kind: 'turn', correlation, task: PRODUCTION_CLI_E2E_TASK },
  baseStateRevision: 1,
  proposedStateRevision: 2,
  committedStateRevision: 2,
  protocolTrace: [],
  storeResult: 'committed',
  acknowledgement: 'accepted_sent',
  settlement: 'committed',
  outcome: {
    ok: true,
    outcome: 'final',
    stopReason: 'final',
    finalText: nonce,
    steps: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    turnProviderRequestCount: 2,
    runtimeProviderRequestCount: 2,
  },
  effectCommitRelation: 'not_transactional',
  automaticReplay: false,
});

const stored = (
  kind: StoredExecutionEvent['kind'],
  observation: Record<string, unknown>,
  ordinal: number,
): StoredExecutionEvent => ({
  executionId,
  ordinal,
  observedAt: '2026-09-08T00:00:00.000Z',
  direction: 'worker_to_host',
  source: 'worker',
  kind,
  workerSequence: ordinal,
  payload: {
    kind: 'provider_observation',
    correlation,
    sequence: ordinal,
    turn: 1,
    observation,
  } as StoredExecutionEvent['payload'],
});

const request = (ordinal: number): Record<string, unknown> => ({
  kind: 'request_start',
  request: {
    ordinal,
    contextRequestOrdinal: ordinal,
    lane: 'parent',
    phase: 'user_turn',
    modelStep: ordinal,
    endpoint: PRODUCTION_PROFILE.origin + PRODUCTION_PROFILE.path,
    method: 'POST',
    requestMetadata: {
      provider: ROOT_DEFAULT_MODEL_SELECTION.provider,
      api: ROOT_DEFAULT_MODEL_SELECTION.api,
      modelId: ROOT_DEFAULT_MODEL_SELECTION.modelId,
    },
  },
});

const events = (): StoredExecutionEvent[] => {
  const call = { callId: 'read-1', name: 'read', arguments: { path: 'e2e-input.txt' } };
  return [
    stored('provider_request_start', request(1), 1),
    stored('provider_response_start', {
      kind: 'response_start',
      requestOrdinal: 1,
      response: { status: 200 },
    }, 2),
    stored('runtime_event', {
      kind: 'runtime_event',
      event: { kind: 'model_result', modelStep: 1, result: { kind: 'tool_calls', calls: [call] } },
    }, 3),
    stored('runtime_event', {
      kind: 'runtime_event',
      event: { kind: 'tool_call', modelStep: 1, call },
    }, 4),
    stored('runtime_event', {
      kind: 'runtime_event',
      event: {
        kind: 'tool_result',
        modelStep: 1,
        result: {
          kind: 'tool_result',
          callId: call.callId,
          name: call.name,
          text: nonce,
          outcome: 'success',
        },
      },
    }, 5),
    stored('provider_request_start', request(2), 6),
    stored('provider_response_start', {
      kind: 'response_start',
      requestOrdinal: 2,
      response: { status: 200 },
    }, 7),
    stored('runtime_event', {
      kind: 'runtime_event',
      event: { kind: 'model_result', modelStep: 2, result: { kind: 'final', text: nonce } },
    }, 8),
  ];
};

Deno.test('production CLI E2E requires explicit live confirmation', async () => {
  let childCount = 0;
  const report = await runProductionCliE2e([], {
    runChild: () => {
      childCount += 1;
      throw new Error('must not start');
    },
  });
  assert(!report.ok);
  equals([report.stage, report.code, childCount], ['preflight', 'invalid_invocation', 0]);
});

Deno.test('production CLI E2E accepts short request facts and semantic tool history', async () => {
  const report = await runProductionCliE2e([PRODUCTION_CLI_E2E_CONFIRMATION], {
    nonce: () => nonce,
    runChild: () =>
      Promise.resolve({
        started: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: nonce + '\n',
        stderr: '',
      }),
    listExecutions: () => Promise.resolve([artifact()]),
    listHistoryEvents: () => Promise.resolve(events()),
    sessionTranscriptExists: () => Promise.resolve(false),
  });
  try {
    assert(report.ok);
    equals([report.executionId, report.externalRequests, report.steps, report.toolOrder], [
      executionId,
      2,
      2,
      ['read'],
    ]);
  } finally {
    if (report.runRoot !== null) await Deno.remove(report.runRoot, { recursive: true });
  }
});

Deno.test('production CLI E2E reports missing request facts', async () => {
  const report = await runProductionCliE2e([PRODUCTION_CLI_E2E_CONFIRMATION], {
    nonce: () => nonce,
    runChild: () =>
      Promise.resolve({
        started: true,
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: nonce + '\n',
        stderr: '',
      }),
    listExecutions: () => Promise.resolve([artifact()]),
    listHistoryEvents: () => Promise.resolve([]),
    sessionTranscriptExists: () => Promise.resolve(false),
  });
  try {
    assert(!report.ok);
    equals([report.stage, report.code], ['history', 'request_fact_mismatch']);
  } finally {
    if (report.runRoot !== null) await Deno.remove(report.runRoot, { recursive: true });
  }
});

Deno.test('offline gate cannot reach the production E2E live task', async () => {
  const config = JSON.parse(await Deno.readTextFile('deno.v0.json')) as {
    readonly tasks: Readonly<Record<string, string>>;
  };
  const live = config.tasks['agent:e2e:live'];
  const offline = config.tasks['agent:e2e:test'];
  assert(live.includes('--allow-run=./dist/henji'));
  assert(PRODUCTION_CLI_LAUNCHER.endsWith('/dist/henji'));
  assert(!offline.includes('--allow-run'));
  assert(!offline.includes('--allow-net'));
  assert(config.tasks['v0:test'].includes('agent:e2e:test'));
  assert(!config.tasks['v0:gate'].includes('agent:e2e:live'));
});
