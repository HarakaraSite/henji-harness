import { type AgentEventSink } from '../../../v0/agent/events.ts';
import { type LoopOutcome } from '../../../v0/agent/contracts.ts';
import { CancellationCleanupError } from '../../../v0/agent/cancellation.ts';
import { main, type TuiSessionFactoryResult } from '../../../v0/agent/tui_cli.ts';
import { type BuiltinAgentSelection } from '../../../v0/agent/agent_catalog.ts';
import { projectRuntimeDisplayState } from '../../../v0/agent/startup_orientation.ts';
import { WorkspacePathIndex } from '../../../v0/tui/file_reference.ts';

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
const dailyMode = mode.startsWith('daily-');
const dailyRecoveryMode = mode === 'daily-recovery';
const dailyMaxMode = mode === 'daily-max';
const dailyContractMode = mode === 'daily-contract';
const dailyFatalMode = mode === 'daily-fatal';
const assistantProgressMode = mode === 'assistant-progress' || mode === 'assistant-progress-cancel';
const followUpSteeringMode = mode === 'follow-up-steering';
const steeringMode = mode === 'steering' || followUpSteeringMode || mode === 'daily-steering';
const followUpMode = mode === 'follow-up' || mode === 'daily-follow-up';
const delayedMode = mode === 'busy' || mode === 'busy-cleanup-failure' || followUpMode ||
  followUpSteeringMode || activeSignal !== undefined || assistantProgressMode || steeringMode ||
  dailyRecoveryMode || dailyMaxMode || dailyContractMode || dailyFatalMode;
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

class FixtureSession {
  private turn = 0;
  private active = false;
  private cancellationRequested = false;
  private steeringText: string | null = null;
  constructor(private readonly sink: AgentEventSink, private readonly delayed: boolean) {}
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
      if (dailyMaxMode || dailyContractMode) {
        const stopReason = dailyMaxMode ? 'max_steps' as const : 'contract_failure' as const;
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
            error: 'daily fixture contract failure',
            steps: 1,
            toolCallCount: 0,
            toolResultCount: 0,
            transcript: [],
          };
        this.sink({ kind: 'turn_end', turn, outcome: stopReason, committed: false });
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
  if (mode === 'planner' && selection.id !== 'planner') {
    throw new Error('planner selection was not propagated');
  }
  if (mode !== 'planner' && selection.id !== 'default') {
    throw new Error('unexpected non-default selection');
  }
  return Promise.resolve({
    session: new FixtureSession(sink, delayedMode),
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

const delayedCrash = (kind: 'error' | 'rejection'): Promise<void> => {
  setTimeout(() => {
    if (kind === 'error') throw new Error('uncaught fixture failure');
    void Promise.reject(new Error('unhandled fixture rejection'));
  }, 10);
  return new Promise((resolve) => setTimeout(resolve, 40));
};

const exitCode = await main(
  mode === 'planner'
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
