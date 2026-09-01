import { type AgentEventSink } from '../../../v0/agent/events.ts';
import { type LoopOutcome } from '../../../v0/agent/contracts.ts';
import { TuiPresentationAdapter } from '../../../v0/agent/tui_presentation_adapter.ts';
import { type PresentationEvent } from '../../../v0/presentation/contract.ts';
import { TuiController } from '../../../v0/tui/controller.ts';
import { TuiRenderer } from '../../../v0/tui/render.ts';
import { PendingInputCore } from '../../../v0/tui/pending_input.ts';
import { TerminalLifecycle, type TerminalPort } from '../../../v0/tui/terminal.ts';

export class RetainedAcceptanceTerminal implements TerminalPort {
  readonly writes: Uint8Array[] = [];
  private readonly input: Uint8Array[];
  private readonly signals = new Map<string, () => void>();
  size = { columns: 80, rows: 24 };

  constructor(input: readonly Uint8Array[] = []) {
    this.input = [...input];
  }
  stdinIsTerminal(): boolean {
    return true;
  }
  stdoutIsTerminal(): boolean {
    return true;
  }
  consoleSize(): { columns: number; rows: number } {
    return this.size;
  }
  setRaw(): void {}
  read(): Promise<Uint8Array | null> {
    const value = this.input.shift() ?? null;
    // Keep the post-submit Ctrl-D behind the fake turn settlement so the controller observes it
    // in idle state, exactly as a human terminal would.
    return new Promise((resolve) => setTimeout(() => resolve(value), value === null ? 0 : 30));
  }
  drainAndCloseInput(): Promise<void> {
    return Promise.resolve();
  }
  write(bytes: Uint8Array): void {
    this.writes.push(new Uint8Array(bytes));
  }
  addSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void {
    this.signals.set(signal, handler);
  }
  removeSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    this.signals.delete(signal);
  }
  addResize(): void {}
  removeResize(): void {}
  text(): string {
    return new TextDecoder().decode(
      this.writes.reduce((all, item) => new Uint8Array([...all, ...item]), new Uint8Array()),
    );
  }
}

const outcome = (task: string): LoopOutcome => ({
  ok: true,
  task,
  outcome: 'tool_terminal',
  stopReason: 'tool_terminal',
  finalText: '{"accepted":true}',
  terminalKind: 'json_result',
  steps: 1,
  toolCallCount: 1,
  toolResultCount: 1,
  transcript: [],
});

class RetainedAcceptanceCore {
  private readonly sink: AgentEventSink;
  private turn = 0;
  private cancelled = false;
  constructor(sink: AgentEventSink) {
    this.sink = sink;
  }
  submit(task: string): Promise<LoopOutcome> {
    const turn = ++this.turn;
    this.cancelled = false;
    this.sink({ kind: 'turn_start', turn });
    this.sink({
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    this.sink({
      kind: 'tool_call',
      turn,
      call: { callId: 'provider-private', name: 'submit_json_result', arguments: {} },
    });
    this.sink({
      kind: 'tool_progress',
      turn,
      callId: 'provider-private',
      name: 'submit_json_result',
      text: 'progress',
    });
    this.sink({
      kind: 'tool_result',
      turn,
      result: {
        kind: 'tool_result',
        callId: 'provider-private',
        name: 'submit_json_result',
        text: '{"accepted":true}',
        outcome: 'success',
        terminal: 'json_result',
      },
    });
    this.sink({ kind: 'turn_end', turn, outcome: 'tool_terminal', committed: !this.cancelled });
    return Promise.resolve(outcome(task));
  }
  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (this.cancelled) return 'already_requested';
    this.cancelled = true;
    return 'requested';
  }
  contextCompactionPreview() {
    return {
      useful: true,
      currentTurn: this.turn,
      proposed: { coveredThroughTurn: this.turn, retainedFromTurn: Math.max(1, this.turn) },
    };
  }
  compactContext() {
    return Promise.resolve({
      kind: 'installed' as const,
      coveredThroughTurn: this.turn,
      retainedFromTurn: this.turn,
    });
  }
  checkpointSnapshot() {
    return {
      summary: 'fake checkpoint',
      coveredThroughTurn: this.turn,
      retainedFromTurn: this.turn,
    };
  }
  currentPosition() {
    return {
      sessionId: undefined,
      agent: 'default' as const,
      committedTurn: this.turn,
      messageCount: this.turn * 3,
    };
  }
  historyPage() {
    return Promise.resolve({
      sessionId: undefined,
      agent: 'default' as const,
      turn: this.turn,
      totalTurns: this.turn,
      page: 0,
      pageCount: 1,
      entries: [{ role: 'user' as const, turn: this.turn, messageIndex: 0, text: 'fake history' }],
      sourceBytes: 12,
      omitted: false,
    });
  }
}

const startup = {
  workspace: 'fixture-workspace',
  agentId: 'default' as const,
  model: { provider: 'openrouter' as const, profileId: 'PROFILE' },
  sessionMode: { kind: 'none' as const },
  instructions: { loaded: false, source: 'none' as const },
  skills: { count: 0, names: [], omitted: 0 },
  trust: { hardSandbox: false as const, osUserTools: ['bash', 'edit', 'write'] as const },
  credentialVerification: 'before_each_provider_request' as const,
};

export const runRetainedAcceptance = async (): Promise<Record<string, unknown>> => {
  const terminal = new RetainedAcceptanceTerminal([
    new TextEncoder().encode('task\n'),
    new Uint8Array([0x04]),
  ]);
  const renderer = new TuiRenderer(terminal, { retained: true });
  // The fake core emits synchronously during submit, so this reference resolves the adapter only
  // after both objects are constructed.
  const adapterRef: { current?: TuiPresentationAdapter } = {};
  const core = new RetainedAcceptanceCore((event) => adapterRef.current?.deliverCoreEvent(event));
  const adapter = new TuiPresentationAdapter(
    core,
    (event: PresentationEvent) => renderer.eventSink(event),
  );
  adapterRef.current = adapter;
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const pending = new PendingInputCore();
  renderer.renderCompactStartup(startup);
  const beforeOverlay = renderer.stateSnapshot();
  renderer.renderStartupHelp(startup);
  const helpFrame = renderer.renderFrame();
  renderer.clearModal();
  renderer.renderHistoryPage(await core.historyPage());
  const historyFrame = renderer.renderFrame();
  renderer.clearModal();
  renderer.renderContextPanel(core.contextCompactionPreview());
  const contextFrame = renderer.renderFrame();
  renderer.resize(100, 30);
  const resizedFrame = renderer.renderFrame();
  renderer.clearModal();

  const controller = new TuiController(lifecycle, renderer, adapter, {
    pending,
    history: undefined,
    intents: adapter,
  });
  const exitCode = await controller.run();
  const state = renderer.stateSnapshot();
  const frame = renderer.renderFrame(100, 30);
  return {
    ok: exitCode === 0,
    retained: true,
    threeBands: frame.includes(']') && frame.includes('> '),
    cursorRestored: new RegExp(`${String.fromCharCode(0x1b)}\\[\\d+;\\d+H`, 'u').test(
      terminal.text(),
    ),
    startupCompact: beforeOverlay.startup.length === 2,
    helpOverlay: helpFrame.includes('startup help'),
    historyOverlay: historyFrame.includes('fake history'),
    contextOverlay: contextFrame.includes('context recovery'),
    resizeReflow: resizedFrame.includes('context recovery') &&
      renderer.layoutSnapshot(100, 30).columns === 100,
    overlayRestored: state.overlay.kind === 'none',
    toolIdentityCount: state.log.entries.filter((entry) => entry.callId !== undefined).length,
    assistantFinalCount: state.log.entries.filter((entry) => entry.kind === 'assistant').length,
    rawProviderIdLeaked: JSON.stringify(state).includes('provider-private'),
    persistentStateUsed: false,
    providerUsed: false,
  };
};

if (import.meta.main) {
  console.log(JSON.stringify(await runRetainedAcceptance()));
}
