import { type AgentEventSink } from '../../../v0/agent/events.ts';
import { type LoopOutcome } from '../../../v0/agent/contracts.ts';
import { TuiPresentationAdapter } from '../../../v0/agent/tui_presentation_adapter.ts';
import {
  type NavigationBinding,
  type NavigationListing,
  type NavigationPosition,
  type SessionNavigationHost,
} from '../../../v0/agent/session_navigation.ts';
import { type PresentationEvent } from '../../../v0/presentation/contract.ts';
import { presentationProjectionFromStartup } from '../../../v0/agent/tui_presentation_adapter.ts';
import { TuiController } from '../../../v0/tui/controller.ts';
import { TuiRenderer } from '../../../v0/tui/render.ts';
import { PendingInputCore } from '../../../v0/tui/pending_input.ts';
import { TuiEditorHistory } from '../../../v0/tui/input.ts';
import { DenoTerminal, TerminalLifecycle } from '../../../v0/tui/terminal.ts';

const currentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const startup = {
  workspace: 'provider-free-interactive-fake',
  agentId: 'default' as const,
  model: { provider: 'openrouter' as const, profileId: 'fake-profile' },
  sessionMode: { kind: 'none' as const },
  instructions: { loaded: false, source: 'none' as const },
  skills: { count: 0, names: [], omitted: 0 },
  trust: { hardSandbox: false as const, osUserTools: ['bash', 'edit', 'write'] as const },
  credentialVerification: 'before_each_provider_request' as const,
};

const outcome = (task: string, cancelled = false): LoopOutcome =>
  cancelled
    ? {
      ok: false,
      task,
      outcome: 'cancelled',
      stopReason: 'cancelled',
      steps: 1,
      toolCallCount: 1,
      toolResultCount: 0,
      transcript: [],
    }
    : {
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
    };

class FakeRenderer extends TuiRenderer {
  pageUps = 0;
  pageDowns = 0;
  latestCount = 0;
  resizeCount = 0;
  helpCount = 0;
  pickerCount = 0;
  historyCount = 0;
  contextCount = 0;

  override scrollPage(direction: 'up' | 'down'): void {
    if (direction === 'up') this.pageUps += 1;
    else this.pageDowns += 1;
    super.scrollPage(direction);
  }

  override latest(): void {
    this.latestCount += 1;
    super.latest();
  }

  override resize(columns: number, rows: number): void {
    this.resizeCount += 1;
    super.resize(columns, rows);
  }

  override renderStartupHelp(): void {
    this.helpCount += 1;
    super.renderStartupHelp();
  }

  override renderSessionPicker(...args: Parameters<TuiRenderer['renderSessionPicker']>): void {
    this.pickerCount += 1;
    super.renderSessionPicker(...args);
  }

  override renderHistoryPage(...args: Parameters<TuiRenderer['renderHistoryPage']>): void {
    this.historyCount += 1;
    super.renderHistoryPage(...args);
  }

  override renderContextPanel(...args: Parameters<TuiRenderer['renderContextPanel']>): void {
    this.contextCount += 1;
    super.renderContextPanel(...args);
  }
}

class FakeCore {
  private turn = 0;
  private active: { readonly task: string; readonly resolve: (value: LoopOutcome) => void } | null =
    null;
  private cancelled = false;
  readonly submitted: string[] = [];
  cancelCount = 0;
  progressCount = 0;
  streamCount = 0;
  toolResultCount = 0;
  finalCount = 0;
  compactionPreviewCount = 0;
  compactionCount = 0;
  compactionCancelCount = 0;

  constructor(
    readonly id: string,
    private readonly sink: AgentEventSink,
    private readonly delayed = false,
  ) {}

  submit(task: string): Promise<LoopOutcome> {
    const turn = ++this.turn;
    this.submitted.push(task);
    this.cancelled = false;
    this.sink({ kind: 'turn_start', turn });
    this.sink({
      kind: 'user_message',
      turn,
      message: { role: 'user', content: { kind: 'text', text: task } },
    });
    this.sink({ kind: 'assistant_progress', turn, text: 'stream chunk' });
    this.streamCount += 1;
    this.sink({
      kind: 'tool_call',
      turn,
      call: { callId: 'fake-private-call', name: 'fake_tool', arguments: { task } },
    });
    this.sink({
      kind: 'tool_progress',
      turn,
      callId: 'fake-private-call',
      name: 'fake_tool',
      text: 'tool progress',
    });
    this.progressCount += 1;
    return new Promise((resolve) => {
      this.active = { task, resolve };
      const finish = () => {
        const active = this.active;
        if (active === null) return;
        this.active = null;
        if (this.cancelled) {
          this.sink({ kind: 'turn_end', turn, outcome: 'cancelled', committed: false });
          resolve(outcome(active.task, true));
          return;
        }
        this.sink({
          kind: 'tool_result',
          turn,
          result: {
            kind: 'tool_result',
            callId: 'fake-private-call',
            name: 'fake_tool',
            text: '{"ok":true}',
            outcome: 'success',
            terminal: 'json_result',
          },
        });
        this.toolResultCount += 1;
        this.sink({
          kind: 'assistant_message',
          turn,
          message: { role: 'assistant', content: { kind: 'text', text: 'fake final' } },
        });
        this.finalCount += 1;
        this.sink({ kind: 'turn_end', turn, outcome: 'tool_terminal', committed: true });
        resolve(outcome(active.task));
      };
      if (this.delayed) setTimeout(finish, 300);
      else queueMicrotask(finish);
    });
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    if (this.active === null) return 'idle';
    if (this.cancelled) return 'already_requested';
    this.cancelled = true;
    this.cancelCount += 1;
    return 'requested';
  }

  contextCompactionPreview() {
    this.compactionPreviewCount += 1;
    return {
      useful: true,
      currentTurn: this.turn,
      proposed: { coveredThroughTurn: this.turn, retainedFromTurn: Math.max(1, this.turn) },
      baselineMessagesBytes: 256,
      projectedMessagesBytes: 128,
    };
  }

  compactContext(signal?: AbortSignal) {
    this.compactionCount += 1;
    return new Promise<{
      readonly kind: 'installed' | 'cancelled';
      readonly coveredThroughTurn?: number;
      readonly retainedFromTurn?: number;
    }>((resolve) => {
      const timer = setTimeout(() =>
        resolve({
          kind: 'installed',
          coveredThroughTurn: this.turn,
          retainedFromTurn: Math.max(1, this.turn),
        }), 120);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.compactionCancelCount += 1;
        resolve({ kind: 'cancelled' });
      }, { once: true });
    });
  }

  checkpointSnapshot() {
    return {
      summary: 'fake checkpoint',
      coveredThroughTurn: this.turn,
      retainedFromTurn: Math.max(1, this.turn),
    };
  }

  currentPosition(): NavigationPosition {
    return {
      sessionId: this.id,
      agent: 'default',
      committedTurn: this.turn,
      messageCount: this.turn * 5,
    };
  }
}

const row = (id: string, current: boolean) => ({
  id,
  agent: 'default' as const,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  turnCount: 1,
  messageCount: 5,
  current,
  resumed: current,
  mismatch: false,
});

const history = (id: string, turn: number) => ({
  sessionId: id,
  agent: 'default' as const,
  turn,
  totalTurns: Math.max(1, turn),
  page: 0,
  pageCount: 1,
  entries: [{ turn, role: 'user' as const, messageIndex: 0, text: 'fake history' }],
  sourceBytes: 12,
  omitted: false,
});

const run = async (): Promise<Record<string, unknown>> => {
  const terminal = new DenoTerminal();
  const renderer = new FakeRenderer(terminal, { retained: true });
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const adapterRef: { current?: TuiPresentationAdapter } = {};
  const initial = new FakeCore(
    currentId,
    (event) => adapterRef.current?.deliverCoreEvent(event),
    true,
  );
  let target: FakeCore | undefined;
  let listRequests = 0;
  let switchRequests = 0;
  let historyRequests = 0;
  const navigation: SessionNavigationHost = {
    persistent: true,
    list: (): Promise<NavigationListing> => {
      listRequests += 1;
      return Promise.resolve({
        sessions: [row(currentId, true), row(targetId, false)],
        skippedInvalid: 0,
      });
    },
    switchTo: (id): Promise<NavigationBinding> => {
      if (id !== targetId) throw new Error('unexpected fake session');
      switchRequests += 1;
      target = new FakeCore(targetId, (event) => adapterRef.current?.deliverCoreEvent(event), true);
      return Promise.resolve({
        session: target,
        position: target.currentPosition(),
        restored: {
          messages: [
            { role: 'user', content: { kind: 'text', text: 'restored task' } },
            { role: 'assistant', content: { kind: 'text', text: 'restored final' } },
          ],
          omitted: 0,
        },
      });
    },
    historyPage: (_page, turn) => {
      historyRequests += 1;
      return Promise.resolve(history(target?.id ?? currentId, turn ?? 1));
    },
    currentPosition: () => (target ?? initial).currentPosition(),
  };
  const adapter = new TuiPresentationAdapter(
    initial,
    (event: PresentationEvent) => renderer.eventSink(event),
    navigation,
  );
  adapterRef.current = adapter;
  const controller = new TuiController(lifecycle, renderer, adapter, {
    pending: new PendingInputCore(),
    history: new TuiEditorHistory(),
    intents: adapter,
  });
  controller.installSignals();
  let resizeSignals = 0;
  const resizeHandler = () => {
    resizeSignals += 1;
    // This explicit fake-host hook makes the human command's PTY resize observable even when
    // the parent `script` utility consumes SIGWINCH before forwarding it to the child.
    renderer.resize(100, 30);
  };
  Deno.addSignalListener('SIGWINCH', resizeHandler);
  await lifecycle.acquire();
  renderer.renderCompactStartup(startup, currentId);
  const position = adapter.currentPosition();
  renderer.setProjection(presentationProjectionFromStartup(startup, position, {
    canNavigate: true,
    canHistory: true,
    canCompact: true,
  }));
  let exitCode = 1;
  try {
    exitCode = await controller.run();
  } finally {
    Deno.removeSignalListener('SIGWINCH', resizeHandler);
    await lifecycle.restore();
  }
  const state = renderer.stateSnapshot();
  return {
    ok: exitCode === 0 && renderer.isClosing,
    interactive: true,
    retained: true,
    threeBands: renderer.renderFrame().includes('> ') && renderer.renderFrame().includes('fake'),
    stream: initial.streamCount + (target?.streamCount ?? 0) > 0,
    toolProgress: initial.progressCount + (target?.progressCount ?? 0) > 0,
    toolResult: (target?.toolResultCount ?? 0) + initial.toolResultCount > 0,
    final: (target?.finalCount ?? 0) + initial.finalCount > 0,
    pageUp: renderer.pageUps > 0,
    pageDown: renderer.pageDowns > 0,
    latest: renderer.latestCount > 0,
    help: renderer.helpCount > 0,
    picker: renderer.pickerCount > 0,
    history: historyRequests > 0,
    compaction: initial.compactionPreviewCount + (target?.compactionPreviewCount ?? 0) > 0,
    compactionCancelled: initial.compactionCancelCount + (target?.compactionCancelCount ?? 0) > 0,
    multiline: [...initial.submitted, ...(target?.submitted ?? [])].some((task) =>
      task.includes('\n')
    ),
    resize: resizeSignals > 0 && renderer.resizeCount > 0,
    cancelled: initial.cancelCount + (target?.cancelCount ?? 0) > 0,
    navigation: listRequests > 0 && switchRequests > 0,
    terminalRestored: renderer.isClosing,
    rawProviderIdLeaked: JSON.stringify(state).includes('fake-private-call'),
    providerUsed: false,
    persistentStateUsed: false,
  };
};

if (import.meta.main) console.log(JSON.stringify(await run()));
