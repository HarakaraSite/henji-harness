import { parseTuiInvocation } from '../../v0/agent/cli/tui_cli.ts';
import type { ModelRequest } from '../../v0/agent/core/contracts.ts';
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  OpenRouterAgentError,
  OpenRouterAgentModel,
} from '../../v0/agent/provider/openrouter_model.ts';
import {
  OPENROUTER_MODEL_CATALOG,
  openRouterProfileFor,
  PLANNER_DEFAULT_MODEL_SELECTION,
  ROOT_DEFAULT_MODEL_SELECTION,
  selectOpenRouterModel,
} from '../../v0/agent/provider/openrouter_model_catalog.ts';
import { TuiPresentationAdapter } from '../../v0/presentation/adapter.ts';
import { validateFailureDiagnostic } from '../../v0/agent/session/failure_diagnostic.ts';
import { createWorkerSession } from '../../v0/agent/worker/worker_host.ts';
import type { WorkerHostCapsule } from '../../v0/agent/worker/worker_host_contract.ts';
import type {
  WorkerHostCommand,
  WorkerToHostMessage,
} from '../../v0/agent/worker/worker_protocol.ts';
import { presentationFailureReason } from '../../v0/tui/state.ts';
import {
  createUiState,
  reduceUiAction,
  reduceUiEvent,
  setUiProjection,
} from '../../v0/tui/state.ts';
import { layoutUi } from '../../v0/tui/layout.ts';

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

const request: ModelRequest = {
  transcript: [{ role: 'user', content: { kind: 'text', text: 'finish normally' } }],
  tools: [],
};

Deno.test('Increment 13 admits a per-invocation provider deadline and rejects invalid values', () => {
  assertEquals(DEFAULT_PROVIDER_TIMEOUT_MS, 120_000);
  assertEquals(
    parseTuiInvocation([
      '--continue',
      '--provider-timeout-ms',
      '180000',
      '--max-steps',
      '64',
      '--agent',
      'default',
    ]),
    {
      rawAgentName: 'default',
      rootMaxSteps: 64,
      providerTimeoutMs: 180_000,
      persistence: 'continue',
    },
  );
  for (
    const args of [
      ['--provider-timeout-ms'],
      ['--provider-timeout-ms', '0'],
      ['--provider-timeout-ms', '-1'],
      ['--provider-timeout-ms', '1.5'],
      ['--provider-timeout-ms', '9007199254740992'],
      ['--provider-timeout-ms', '1', '--provider-timeout-ms', '2'],
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

Deno.test('Increment 13 preserves provider_timeout when an aborted SSE body rejects cleanup', async () => {
  const encoder = new TextEncoder();
  const fetcher: typeof fetch = (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"id":"gen-timeout","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"working"},"finish_reason":null}]}\n\n',
        ));
        signal?.addEventListener('abort', () => {
          controller.error(new Error('simulated aborted provider body'));
        }, { once: true });
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  const model = new OpenRouterAgentModel({
    credential: 'dummy-test-credential',
    fetcher,
    responseMode: 'sse',
    timeoutMs: 5,
  });
  let observed: OpenRouterAgentError | undefined;
  try {
    await model.generate(request);
  } catch (error) {
    if (error instanceof OpenRouterAgentError) observed = error;
    else throw error;
  }
  assert(observed !== undefined);
  assertEquals(observed.code, 'provider_timeout');
  assertEquals(observed.failureFact, {
    stage: 'transport',
    code: 'provider_timeout',
    requestCount: 1,
  });
  const diagnostic = {
    schemaVersion: 1 as const,
    diagnosticId: '13131313-1313-4131-8131-131313131313',
    stage: 'transport' as const,
    code: 'provider_timeout' as const,
    lane: 'parent' as const,
    providerRequestCount: 1,
    occurredAt: '2026-09-08T00:00:00.000Z',
    turnNumber: 1,
    modelStep: 1,
    retryCount: 0 as const,
  };
  assert(validateFailureDiagnostic(diagnostic));
  assertEquals(presentationFailureReason(diagnostic), 'provider deadline exceeded');
});

Deno.test('Increment 13 sends the configured provider deadline across the Host Worker boundary', async () => {
  class CaptureCapsule implements WorkerHostCapsule {
    private readonly listeners = new Set<(message: WorkerToHostMessage) => void>();
    start?: Extract<WorkerHostCommand, { readonly kind: 'start' }>;

    send(command: WorkerHostCommand): void {
      if (command.kind === 'start') {
        this.start = command;
        this.emit({
          kind: 'ready',
          correlation: command.correlation,
          manifest: {
            role: 'parent',
            maxSteps: 64,
            profileId: openRouterProfileFor(ROOT_DEFAULT_MODEL_SELECTION).id,
            resources: [],
            rootModel: ROOT_DEFAULT_MODEL_SELECTION,
            plannerModel: PLANNER_DEFAULT_MODEL_SELECTION,
          },
        });
      } else if (command.kind === 'close') {
        this.emit({ kind: 'closed', correlation: command.correlation });
      }
    }

    subscribe(listener: (message: WorkerToHostMessage) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    terminate(): void {}

    private emit(message: WorkerToHostMessage): void {
      for (const listener of this.listeners) listener(message);
    }
  }

  const capsule = new CaptureCapsule();
  const created = await createWorkerSession({
    workspaceRoot: Deno.cwd(),
    persistence: 'none',
    agent: 'default',
    physicalIoMode: 'provider-free',
    providerTimeoutMs: 180_000,
    capsuleFactory: () => capsule,
  });
  try {
    assertEquals(capsule.start?.providerTimeoutMs, 180_000);
  } finally {
    await created.close();
  }
});

Deno.test('Increment 13 projects successful model and effort selection immediately', async () => {
  const qwen = selectOpenRouterModel('qwen/qwen3.8-max-0902');
  const events: unknown[] = [];
  const adapter = new TuiPresentationAdapter(
    {
      submit: () => Promise.reject(new Error('not used')),
      selectModel: () => Promise.resolve('selected'),
    },
    (event) => events.push(event),
  );
  const result = await adapter.dispatch({
    kind: 'select_model',
    modelId: qwen.modelId,
    effort: qwen.effort,
  });
  assertEquals(result, {
    kind: 'model_selection',
    status: 'selected',
    selection: qwen,
  });
  assertEquals(events, [{ kind: 'model_selection_changed', selection: qwen }]);
});

Deno.test('Increment 13 keeps Session model and effort in the second footer row', () => {
  const qwen = selectOpenRouterModel('qwen/qwen3.8-max-0902');
  let state = setUiProjection(createUiState(), {
    lifecycle: 'idle',
    agentId: 'default',
    sessionId: 'abcdef12-3456-4789-8123-abcdefabcdef',
    committedTurn: 3,
    workspace: '/home/masat.guest/src/forgejo-agent',
    model: qwen,
    trust: 'trusted_local',
    credentialPolicy: 'before_each_provider_request',
    pending: [],
    capabilities: { canNavigate: true, canHistory: true, canCompact: true },
    generation: 0,
  });
  state = reduceUiAction(state, { kind: 'status', text: 'ready' });
  const first = layoutUi(state, 80, 24).footer;
  assertEquals(first[0].text, '[ready]');
  assert(first[1].text.includes('session:abcdef12'));
  assert(first[1].text.includes('model:qwen/qwen3.8-max-0902'));
  assert(first[1].text.endsWith(' xhigh]'));
  assert(first[1].text.includes('forgejo-agent'));
  assert(!first[1].text.includes('cwd:'));
  assert(!first[1].text.includes('effort:'));
  assert(first[1].text.length <= 80);
  assertEquals(
    layoutUi(state, 160, 24).footer[1].text,
    '[/home/masat.guest/src/forgejo-agent session:abcdef12 model:qwen/qwen3.8-max-0902 xhigh]',
  );

  state = reduceUiAction(state, { kind: 'status', text: 'contract_failure' });
  assertEquals(layoutUi(state, 80, 24).footer[1].text, first[1].text);

  const deepseek = selectOpenRouterModel('deepseek/deepseek-v4-pro-0813');
  state = reduceUiEvent(state, {
    kind: 'model_selection_changed',
    selection: deepseek,
  });
  let second = layoutUi(state, 80, 24).footer[1].text;
  assert(second.includes('model:deepseek/deepseek-v4-pro-0813'));
  assert(second.endsWith(' high]'));

  state = reduceUiEvent(state, {
    kind: 'session_binding_replaced',
    position: {
      sessionId: '87654321-3456-4789-8123-abcdefabcdef',
      agent: 'default',
      committedTurn: 7,
      messageCount: 14,
    },
    modelSelection: qwen,
  });
  second = layoutUi(state, 80, 24).footer[1].text;
  assert(second.includes('session:87654321'));
  assert(second.includes('model:qwen/qwen3.8-max-0902'));
  assert(second.endsWith(' xhigh]'));

  for (const entry of OPENROUTER_MODEL_CATALOG) {
    const selection = selectOpenRouterModel(entry.modelId);
    state = reduceUiEvent(state, {
      kind: 'model_selection_changed',
      selection,
    });
    const identity = layoutUi(state, 80, 24).footer[1].text;
    assert(identity.includes(`model:${entry.modelId}`));
    assert(identity.endsWith(` ${entry.defaultEffort}]`));
    assert(!identity.includes('cwd:'));
    assert(!identity.includes('effort:'));
    assert(identity.length <= 80);
  }
});
