import { type AgentEventSink } from '../../../v0/agent/events.ts';
import { type LoopOutcome } from '../../../v0/agent/contracts.ts';
import { CancellationCleanupError } from '../../../v0/agent/cancellation.ts';
import { main, type TuiSessionFactoryResult } from '../../../v0/agent/tui_cli.ts';
import { type BuiltinAgentSelection } from '../../../v0/agent/agent_catalog.ts';
import { projectRuntimeDisplayState } from '../../../v0/agent/startup_orientation.ts';
import { WorkspacePathIndex } from '../../../v0/tui/file_reference.ts';
import {
  createFailureDiagnostic,
  type FailureDiagnosticPersister,
} from '../../../v0/agent/failure_diagnostic.ts';
import {
  DenoFailureDiagnosticStore,
  failureDiagnosticPaths,
} from '../../../v0/agent/failure_diagnostic_store.ts';
import { main as diagnosticMain } from '../../../v0/agent/failure_diagnostic_cli.ts';
import { createRuntimeSession } from '../../../v0/agent/runtime.ts';

const mode = Deno.args[0] ?? 'success';
type FixtureSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
const parseSignal = (prefix: string): FixtureSignal | undefined => {
  const value = mode.startsWith(prefix) ? mode.slice(prefix.length) : undefined;
  return value === 'SIGINT' || value === 'SIGTERM' || value === 'SIGHUP' ? value : undefined;
};
const signalMode = parseSignal('signal-') ?? parseSignal('daily-signal-');
const cleanupSignalMode = parseSignal('signal-cleanup-failure-') ??
  parseSignal('daily-signal-cleanup-failure-');
const activeSignal = cleanupSignalMode ?? signalMode;
const dailyMode = mode.startsWith('daily-') || mode.startsWith('runtime-');
const dailyRecoveryMode = mode === 'daily-recovery';
const dailyMaxMode = mode === 'daily-max';
const dailyContractMode = mode === 'daily-contract';
const dailyDiagnosticMode = mode === 'daily-diagnostic';
const runtimeDiagnosticMode = mode === 'runtime-diagnostic';
const runtimeSuccessMode = mode === 'runtime-success';
const diagnosticReadbackMode = mode === 'diagnostic-readback';
const dailyFatalMode = mode === 'daily-fatal';
const assistantProgressMode = mode === 'assistant-progress' || mode === 'assistant-progress-cancel';
const followUpSteeringMode = mode === 'follow-up-steering';
const steeringMode = mode === 'steering' || followUpSteeringMode || mode === 'daily-steering';
const followUpMode = mode === 'follow-up' || mode === 'daily-follow-up';
const delayedMode = mode === 'busy' || mode === 'busy-cleanup-failure' || followUpMode ||
  followUpSteeringMode || activeSignal !== undefined || assistantProgressMode || steeringMode ||
  dailyRecoveryMode || dailyMaxMode || dailyContractMode || dailyDiagnosticMode || dailyFatalMode;
const cleanupFailureMode = mode === 'busy-cleanup-failure' || cleanupSignalMode !== undefined;
const task = (value: string, finalText = 'fixture response'): LoopOutcome => ({
  ok: true,
  task: value,
  outcome: 'final',
  stopReason: 'final',
  finalText,
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

const cancelledTask = (value: string): LoopOutcome => ({
  ok: false,
  task: value,
  outcome: 'cancelled',
  stopReason: 'cancelled',
  steps: 1,
  toolCallCount: 0,
  toolResultCount: 0,
  transcript: [],
});

const diagnostic = createFailureDiagnostic(
  {
    stage: 'response_parse',
    code: 'response_error',
    lane: 'parent',
    providerRequestCount: 1,
    httpStatus: 200,
    parseReason: 'invalid_sse_json',
    turnNumber: 1,
    modelStep: 1,
    occurredAt: '2026-09-02T00:00:00.000Z',
  },
  {
    uuid: () => '55555555-5555-4555-8555-555555555555',
    now: () => '2026-09-02T00:00:00.000Z',
  },
);

class FixtureSession {
  private turn = 0;
  private active = false;
  private cancellationRequested = false;
  private steeringText: string | null = null;
  constructor(
    private readonly sink: AgentEventSink,
    private readonly delayed: boolean,
    private readonly persist?: FailureDiagnosticPersister,
  ) {}
  async submit(text: string): Promise<LoopOutcome> {
    const turn = ++this.turn;
    this.active = true;
    try {
      this.sink({ kind: 'turn_start', turn });
      this.sink({
        kind: 'user_message',
        turn,
        message: { role: 'user', content: { kind: 'text', text } },
      });
      if (mode === 'failure') throw new Error('fixture model failure');
      if (dailyFatalMode) throw new Error('daily fixture model failure');
      if (steeringMode) {
        this.sink({
          kind: 'assistant_message',
          turn,
          message: {
            role: 'assistant',
            content: [{ kind: 'tool_call', callId: 'steering', name: 'continue', arguments: {} }],
          },
        });
        this.sink({
          kind: 'tool_call',
          turn,
          call: { callId: 'steering', name: 'continue', arguments: {} },
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (this.cancellationRequested) {
          this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
          return cancelledTask(text);
        }
        this.sink({
          kind: 'tool_result',
          turn,
          result: {
            kind: 'tool_result',
            callId: 'steering',
            name: 'continue',
            text: 'complete tool batch',
            outcome: 'success',
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (this.cancellationRequested) {
          this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
          return cancelledTask(text);
        }
        if (this.steeringText !== null) {
          this.sink({
            kind: 'steering_message',
            turn,
            message: { role: 'user', content: { kind: 'text', text: this.steeringText } },
          });
        }
        this.sink({
          kind: 'assistant_message',
          turn,
          message: {
            role: 'assistant',
            content: {
              kind: 'text',
              text: this.steeringText === null ? 'fixture response' : 'steered response',
            },
          },
        });
        this.sink({ kind: 'turn_end', turn, outcome: 'final', committed: true });
        return task(text, this.steeringText === null ? 'fixture response' : 'steered response');
      }
      if (mode === 'progress') {
        this.sink({
          kind: 'tool_call',
          turn,
          call: { callId: 'progress', name: 'bash', arguments: {} },
        });
        this.sink({
          kind: 'tool_progress',
          turn,
          callId: 'progress',
          name: 'bash',
          text: 'stdout:\nfirst',
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        if (this.cancellationRequested) {
          this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
          return cancelledTask(text);
        }
        this.sink({
          kind: 'tool_progress',
          turn,
          callId: 'progress',
          name: 'bash',
          text: 'stdout:\nsecond',
        });
        this.sink({
          kind: 'tool_result',
          turn,
          result: {
            kind: 'tool_result',
            callId: 'progress',
            name: 'bash',
            text: '{"stdout":"second"}',
            outcome: 'success',
          },
        });
      }
      if (assistantProgressMode) {
        this.sink({ kind: 'assistant_progress', turn, text: 'first chunk' });
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.cancellationRequested) {
          this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
          return cancelledTask(text);
        }
        this.sink({ kind: 'assistant_progress', turn, text: 'second chunk' });
      }
      if (activeSignal !== undefined) {
        void new Deno.Command('/bin/bash', {
          args: ['--noprofile', '--norc', '-c', `kill -${activeSignal} ${Deno.pid}`],
          clearEnv: true,
          env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
          stdout: 'null',
          stderr: 'null',
        }).output();
      }
      if (this.delayed) {
        const delay = followUpMode ? (turn === 1 ? 150 : 300) : dailyRecoveryMode ? 300 : 120;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (dailyMaxMode || dailyContractMode || dailyDiagnosticMode) {
        const stopReason = dailyMaxMode ? 'max_steps' as const : 'contract_failure' as const;
        if (dailyDiagnosticMode) await this.persist?.(diagnostic);
        const outcome = dailyMaxMode
          ? {
            ok: false,
            task: text,
            outcome: 'max_steps' as const,
            stopReason,
            error: 'daily fixture max steps',
            steps: 8,
            toolCallCount: 8,
            toolResultCount: 8,
            transcript: [],
          }
          : {
            ok: false,
            task: text,
            outcome: 'contract_failure' as const,
            stopReason,
            error: dailyDiagnosticMode
              ? 'daily diagnostic private marker'
              : 'daily fixture contract failure',
            steps: 1,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
            ...(dailyDiagnosticMode ? { diagnostic } : {}),
          };
        this.sink({
          kind: 'turn_end',
          turn,
          outcome: stopReason,
          committed: false,
          ...(dailyDiagnosticMode ? { diagnostic } : {}),
        });
        return outcome;
      }
      if (this.cancellationRequested) {
        if (cleanupFailureMode) throw new CancellationCleanupError();
        this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
        return cancelledTask(text);
      }
      this.sink({
        kind: 'assistant_message',
        turn,
        message: { role: 'assistant', content: { kind: 'text', text: 'fixture response' } },
      });
      this.sink({ kind: 'turn_end', turn, outcome: 'final', committed: true });
      return task(text);
    } finally {
      this.active = false;
      this.cancellationRequested = false;
      this.steeringText = null;
    }
  }
  cancelActiveTurn() {
    if (!this.active || !this.delayed) return 'idle' as const;
    if (this.cancellationRequested) return 'already_requested' as const;
    this.cancellationRequested = true;
    return 'requested' as const;
  }
  steerActiveTurn(text: string) {
    if (!steeringMode || !this.active) return 'idle' as const;
    if (this.steeringText !== null) return 'already_accepted' as const;
    this.steeringText = text;
    return 'accepted' as const;
  }
}

const createSession = (
  sink: AgentEventSink,
  selection: BuiltinAgentSelection,
): Promise<TuiSessionFactoryResult> => {
  if (runtimeDiagnosticMode || runtimeSuccessMode) {
    const stateRoot = diagnosticStateRoot;
    const store = runtimeDiagnosticMode && stateRoot !== undefined
      ? new DenoFailureDiagnosticStore(stateRoot, Deno.cwd())
      : undefined;
    const runtime = runtimeDiagnosticMode
      ? createRuntimeSession(sink, {
        credential: 'credential-value-marker',
        responseMode: 'json',
        fetcher: () =>
          Promise.resolve(
            new Response(
              'credential-value-marker Authorization: Bearer authorization-shaped-marker private-payload-marker',
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          ),
        workspaceRoot: Deno.cwd(),
        diagnosticPersistence: store?.persist,
      }, selection)
      : createRuntimeSession(sink, {
        credential: 'credential-value-marker',
        responseMode: 'json',
        fetcher: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [{ message: { role: 'assistant', content: 'fixture response' } }],
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          ),
        workspaceRoot: Deno.cwd(),
      }, selection);
    return runtime.then((result) => ({
      session: result.session,
      displayState: result.displayState,
      workspaceRoot: Deno.cwd(),
    }));
  }
  if (mode === 'planner' && selection.id !== 'planner') {
    throw new Error('planner selection was not propagated');
  }
  if (mode !== 'planner' && selection.id !== 'default') {
    throw new Error('unexpected non-default selection');
  }
  return Promise.resolve({
    session: new FixtureSession(sink, delayedMode, diagnosticPersistence),
    displayState: projectRuntimeDisplayState({
      workspaceRoot: '/tmp/tui-process-fixture',
      agentId: mode === 'planner' ? 'planner' : 'default',
      profileId: 'fixture-profile',
      sessionMode: 'none',
      skillNames: [],
    }),
    ...(dailyMode
      ? {
        workspaceRoot: '/tmp/tui-process-fixture',
      }
      : {}),
  });
};

const diagnosticStateRoot = Deno.args[1];
const diagnosticPersistence = mode === 'daily-diagnostic' && diagnosticStateRoot !== undefined
  ? new DenoFailureDiagnosticStore(diagnosticStateRoot, Deno.cwd()).persist
  : undefined;

if (diagnosticReadbackMode) {
  const id = Deno.args[2];
  if (diagnosticStateRoot === undefined || id === undefined) Deno.exit(1);
  Deno.exit(
    await diagnosticMain(['show', '--id', id], {
      stateRoot: diagnosticStateRoot,
      workspaceRoot: Deno.cwd(),
    }),
  );
}

if (mode === 'diagnostic-inspect') {
  if (diagnosticStateRoot === undefined) Deno.exit(1);
  const paths = await failureDiagnosticPaths(diagnosticStateRoot, Deno.cwd());
  const inspectedId = Deno.args[2] ?? diagnostic.diagnosticId;
  const exists = async (path: string): Promise<boolean> => {
    try {
      await Deno.lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  };
  const record = `${paths.diagnostics}/${inspectedId}.json`;
  let recordText = '';
  try {
    recordText = await Deno.readTextFile(record);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const markerValues = [
    'credential-value-marker',
    'Authorization: Bearer',
    'authorization-shaped-marker',
    'private-payload-marker',
  ];
  await Deno.stdout.write(new TextEncoder().encode(
    JSON.stringify({
      record: await exists(record),
      recordMarkers: markerValues.some((marker) => recordText.includes(marker)),
      session: await exists(`${paths.root}/sessions`),
      context: await exists(`${paths.root}/contexts`),
    }) + '\n',
  ));
  Deno.exit(0);
}

if (mode === 'diagnostic-cleanup') {
  if (diagnosticStateRoot !== undefined) {
    try {
      await Deno.remove(diagnosticStateRoot, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) Deno.exit(1);
    }
  }
  Deno.exit(0);
}

if (mode === 'diagnostic-fill') {
  if (diagnosticStateRoot === undefined) Deno.exit(1);
  const store = new DenoFailureDiagnosticStore(diagnosticStateRoot, Deno.cwd());
  for (let index = 0; index < 16; index += 1) {
    const suffix = index.toString(16).padStart(2, '0');
    const second = index.toString(10).padStart(2, '0');
    await store.write(createFailureDiagnostic({
      stage: 'response_parse',
      code: 'response_error',
      lane: 'parent',
      providerRequestCount: 1,
      httpStatus: 200,
      parseReason: 'invalid_sse_json',
      turnNumber: index + 1,
      modelStep: 1,
      occurredAt: `2026-09-02T00:00:${second}.000Z`,
    }, {
      uuid: () => `66666666-6666-4666-8666-6666666666${suffix}`,
    }));
  }
  Deno.exit(0);
}

const delayedCrash = (kind: 'error' | 'rejection'): Promise<void> => {
  setTimeout(() => {
    if (kind === 'error') throw new Error('uncaught fixture failure');
    void Promise.reject(new Error('unhandled fixture rejection'));
  }, 10);
  return new Promise((resolve) => setTimeout(resolve, 40));
};

const exitCode = await main(
  runtimeDiagnosticMode || runtimeSuccessMode
    ? ['--no-session']
    : mode === 'planner'
    ? ['--agent', 'planner']
    : mode === 'invalid-selection'
    ? ['--agent', 'unknown']
    : [],
  {
    createSession,
    dailyEditor: dailyMode,
    pathIndex: dailyMode
      ? WorkspacePathIndex.fromCandidates(['README.md', 'src/main.ts'])
      : undefined,
    afterAcquire: mode === 'crash'
      ? () => {
        throw new Error('uncaught fixture failure');
      }
      : mode === 'detached-error'
      ? () => delayedCrash('error')
      : mode === 'unhandled-rejection'
      ? () => delayedCrash('rejection')
      : undefined,
  },
);
Deno.exit(exitCode);
