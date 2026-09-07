import type {
  PresentationIntent,
  PresentationIntentResult,
  PresentationNavigationListing,
} from '../../v0/presentation/contract.ts';
import type { TuiNavigationLike, TuiSessionLike } from '../../v0/tui/controller.ts';
import { ControllerOverlay } from '../../v0/tui/controller_overlay.ts';
import type { TuiRenderer } from '../../v0/tui/render.ts';

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

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition not reached');
};

const outcomeSession = (id: string): TuiSessionLike => ({
  submit: (task) =>
    Promise.resolve({
      ok: true,
      task,
      outcome: 'final',
      stopReason: 'final',
      finalText: id,
      steps: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    }),
});

Deno.test('controller overlay owns help, picker resume, history, and context transitions', async () => {
  const calls: string[] = [];
  const historyRequests: Array<readonly [number, number | undefined, number | undefined]> = [];
  let compactionStarts = 0;
  let session = outcomeSession('old');
  const resumed = outcomeSession('resumed');
  Object.assign(session, {
    historyPage: (page: number, turn?: number, rows?: number) => {
      historyRequests.push([page, turn, rows]);
      return {
        sessionId: 'old-session',
        agent: 'default' as const,
        turn: turn ?? 2,
        totalTurns: 2,
        page,
        pageCount: 1,
        entries: [],
        sourceBytes: 0,
        omitted: false,
      };
    },
    contextCompactionPreview: () => ({
      useful: true,
      currentTurn: 2,
      proposed: { coveredThroughTurn: 1, retainedFromTurn: 2 },
    }),
    compactContext: () => Promise.resolve({ kind: 'installed' as const }),
    checkpointSnapshot: () => ({
      summary: 'checkpoint summary',
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
    }),
  });
  const listing: PresentationNavigationListing = {
    sessions: [
      {
        id: 'old-session',
        agent: 'default',
        createdAt: '2026-09-08T00:00:00Z',
        updatedAt: '2026-09-08T00:00:00Z',
        turnCount: 2,
        messageCount: 4,
        current: true,
        resumed: false,
        mismatch: false,
      },
      {
        id: 'next-session',
        agent: 'default',
        createdAt: '2026-09-08T00:00:00Z',
        updatedAt: '2026-09-08T00:00:00Z',
        turnCount: 1,
        messageCount: 2,
        current: false,
        resumed: false,
        mismatch: false,
      },
    ],
    skippedInvalid: 0,
  };
  const navigation: TuiNavigationLike = {
    persistent: true,
    list: () => Promise.resolve(listing),
    switchTo: () =>
      Promise.resolve({
        session: resumed,
        position: {
          sessionId: 'next-session',
          agent: 'default',
          committedTurn: 1,
          messageCount: 2,
        },
      }),
    historyPage: async (page, turn, rows) => await session.historyPage!(page, turn, rows),
    currentPosition: () => ({
      sessionId: 'old-session',
      agent: 'default',
      committedTurn: 2,
      messageCount: 4,
    }),
  };
  const renderer = {
    setStatus: (status: string) => calls.push(`status:${status}`),
    renderStartupHelp: () => calls.push('help'),
    clearModal: () => calls.push('clear'),
    renderSessionPicker: (
      _listing: PresentationNavigationListing,
      selected: number,
      page: number,
      loading = false,
    ) => calls.push(`picker:${selected}:${page}:${loading}`),
    renderRestored: () => calls.push('restored'),
    setCurrentPosition: () => calls.push('position'),
    renderHistoryPage: () => calls.push('history'),
    renderContextPanel: () => calls.push('context'),
    renderContextSummary: (summary: string) => calls.push(`summary:${summary}`),
  } as unknown as TuiRenderer;
  const overlay = new ControllerOverlay({
    renderer,
    navigation,
    dispatch: (_intent: PresentationIntent): PresentationIntentResult => ({
      kind: 'rejected',
      reason: 'unavailable',
    }),
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    startContextCompaction: () => {
      compactionStarts += 1;
    },
    fail: (error) => Promise.reject(error),
  });

  overlay.openStartupHelp();
  overlay.process({ kind: 'f1' });
  assertEquals(calls.slice(0, 3), ['help', 'clear', 'status:ready']);

  overlay.openPicker();
  await waitFor(() => calls.includes('picker:0:0:false'));
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'enter' });
  await waitFor(() => calls.includes('position'));
  assert(session === resumed);

  session = Object.assign(outcomeSession('history'), {
    historyPage: (page: number, turn?: number, rows?: number) => {
      historyRequests.push([page, turn, rows]);
      return {
        sessionId: 'next-session',
        agent: 'default' as const,
        turn: turn ?? 2,
        totalTurns: 2,
        page,
        pageCount: 1,
        entries: [],
        sourceBytes: 0,
        omitted: false,
      };
    },
    contextCompactionPreview: () => ({
      useful: true,
      currentTurn: 2,
      proposed: { coveredThroughTurn: 1, retainedFromTurn: 2 },
    }),
    compactContext: () => Promise.resolve({ kind: 'installed' as const }),
    checkpointSnapshot: () => ({
      summary: 'checkpoint summary',
      coveredThroughTurn: 1,
      retainedFromTurn: 2,
    }),
  });
  overlay.openHistory();
  await waitFor(() => calls.includes('history'));
  assertEquals(historyRequests.at(-1), [0, 2, 16]);
  overlay.process({ kind: 'home' });
  await waitFor(() => historyRequests.some((request) => request[1] === 1));
  overlay.process({ kind: 'escape' });

  overlay.openContextPanel();
  overlay.process({ kind: 'printable', text: 'v', codePoint: 0x76 });
  overlay.process({ kind: 'enter' });
  assert(calls.includes('context'));
  assert(calls.includes('summary:checkpoint summary'));
  assertEquals(compactionStarts, 1);
  assert(!overlay.isOpen);
  await overlay.settle();
});
