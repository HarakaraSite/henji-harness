import { type AgentEventSink } from '../../../v0/agent/events.ts';
import { type LoopOutcome } from '../../../v0/agent/contracts.ts';
import { main, type TuiSessionFactoryResult } from '../../../v0/agent/tui_cli.ts';
import { type BuiltinAgentSelection } from '../../../v0/agent/agent_catalog.ts';

const mode = Deno.args[0] ?? 'success';
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

class FixtureSession {
  private turn = 0;
  constructor(private readonly sink: AgentEventSink, private readonly delayed: boolean) {}
  async submit(text: string): Promise<LoopOutcome> {
    const turn = ++this.turn;
    this.sink({ kind: 'turn_start', turn });
    this.sink({
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text } },
    });
    if (mode === 'failure') throw new Error('fixture model failure');
    if (this.delayed) await new Promise((resolve) => setTimeout(resolve, 120));
    this.sink({
      kind: 'assistant_message',
      turn,
      message: { role: 'assistant', content: { kind: 'text', text: 'fixture response' } },
    });
    this.sink({ kind: 'turn_end', turn, outcome: 'final', committed: true });
    return task(text);
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
    session: new FixtureSession(sink, mode === 'busy'),
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
