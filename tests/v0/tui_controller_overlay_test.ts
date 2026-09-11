import type {
  PresentationIntent,
  PresentationIntentResult,
  PresentationNavigationListing,
} from '../../v0/presentation/contract.ts';
import type { TuiNavigationLike, TuiSessionLike } from '../../v0/tui/controller.ts';
import { ControllerOverlay } from '../../v0/tui/controller_overlay.ts';
import type { TuiRenderer } from '../../v0/tui/render.ts';
import {
  type OpenRouterModelSelection,
  ROOT_DEFAULT_MODEL_SELECTION,
  selectOpenRouterModel,
} from '../../v0/agent/provider/openrouter_model_catalog.ts';

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

Deno.test('controller overlay owns help and session picker resume transitions', async () => {
  const calls: string[] = [];
  let session = outcomeSession('old');
  const resumed = outcomeSession('resumed');
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
    historyPage: () => Promise.resolve(undefined),
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
  } as unknown as TuiRenderer;
  const overlay = new ControllerOverlay({
    renderer,
    navigation,
    dispatch: (_intent: PresentationIntent): PresentationIntentResult => ({
      kind: 'rejected',
      reason: 'unavailable',
    }),
    setSession: (next) => {
      session = next;
    },
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => undefined,
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
  assert(!overlay.isOpen);
  await overlay.settle();
});

Deno.test('controller overlay searches models and changes effort separately', async () => {
  const rendered: string[][] = [];
  const statuses: string[] = [];
  let selection: OpenRouterModelSelection = ROOT_DEFAULT_MODEL_SELECTION;
  const renderer = {
    renderChoicePicker: (lines: readonly string[]) => rendered.push([...lines]),
    clearModal: () => {},
    setStatus: (status: string) => statuses.push(status),
  } as unknown as TuiRenderer;
  const overlay = new ControllerOverlay({
    renderer,
    dispatch: (intent: PresentationIntent): PresentationIntentResult => {
      if (intent.kind !== 'select_model') return { kind: 'accepted' };
      selection = selectOpenRouterModel(
        intent.modelId,
        intent.effort as OpenRouterModelSelection['effort'],
      );
      return {
        kind: 'model_selection',
        status: 'selected',
        selection,
      };
    },
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready · credential missing: openrouter',
    modelSelection: () => selection,
    fail: (error) => Promise.reject(error),
  });

  overlay.openModelPicker();
  overlay.process({ kind: 'paste', text: 'grok' });
  assert(rendered.at(-1)?.some((line) => line.includes('x-ai/grok-4.6')));
  assert(!rendered.at(-1)?.some((line) => line.includes('deepseek/')));
  overlay.process({ kind: 'enter' });
  await waitFor(() => selection.modelId === 'x-ai/grok-4.6');
  await overlay.settle();
  assertEquals(selection.effort, 'high');
  assert(
    statuses.some((status) =>
      status.includes('ready · credential missing: openrouter · provider openrouter')
    ),
  );

  overlay.openEffortPicker();
  overlay.process({ kind: 'down' });
  overlay.process({ kind: 'enter' });
  await waitFor(() => selection.effort === 'medium');
  assert(statuses.some((status) => status.includes('effort medium')));
  await overlay.settle();
});

Deno.test('controller overlay searches history and repeats matches without replacing the draft', async () => {
  const intents: PresentationIntent[] = [];
  const rendered: string[] = [];
  let latest = 0;
  const page = {
    turn: 1,
    totalTurns: 2,
    page: 0,
    pageCount: 1,
    entries: [{ turn: 1, role: 'user' as const, messageIndex: 0, text: 'alpha' }],
    sourceBytes: 5,
    omitted: false,
  };
  const result = (ordinal: number) => ({
    page,
    match: {
      query: 'alpha',
      ordinal,
      total: 2,
      turn: 1,
      role: 'user' as const,
      messageIndex: 0,
      sourceScalarStart: 0,
      sourceScalarLength: 5,
      pageEntry: 0,
    },
  });
  const renderer = {
    renderChoicePicker: (lines: readonly string[]) => rendered.push(lines.join('\n')),
    renderHistoryPage: (_page: unknown, match: { readonly ordinal: number }) =>
      rendered.push(`match:${match.ordinal}`),
    clearModal: () => rendered.push('clear'),
    latest: () => latest += 1,
    setStatus: () => {},
  } as unknown as TuiRenderer;
  const overlay = new ControllerOverlay({
    renderer,
    dispatch: (intent: PresentationIntent): PresentationIntentResult => {
      intents.push(intent);
      if (intent.kind === 'history_search') {
        return { kind: 'history_search', result: result(intent.match) };
      }
      return { kind: 'rejected', reason: 'unavailable' };
    },
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => undefined,
    fail: (error) => Promise.reject(error),
  });

  overlay.openHistorySearch();
  overlay.process({ kind: 'paste', text: 'alpha' });
  overlay.process({ kind: 'enter' });
  await waitFor(() => rendered.includes('match:0'));
  overlay.process({ kind: 'printable', text: 'n', codePoint: 110 });
  await waitFor(() => rendered.includes('match:1'));
  overlay.process({ kind: 'printable', text: 'N', codePoint: 78 });
  await waitFor(() => rendered.filter((value) => value === 'match:0').length === 2);
  overlay.process({ kind: 'escape' });

  assertEquals(
    intents.filter((intent) => intent.kind === 'history_search'),
    [
      { kind: 'history_search', query: 'alpha', match: 0 },
      { kind: 'history_search', query: 'alpha', match: 1 },
      { kind: 'history_search', query: 'alpha', match: 0 },
    ],
  );
  assertEquals(latest, 1);
  assert(!overlay.isOpen);
  await overlay.settle();
});

Deno.test('controller overlay ignores a history result from a replaced Session binding', async () => {
  let binding = 'session-one';
  let resolveSearch!: (result: PresentationIntentResult) => void;
  let historyRendered = false;
  const overlay = new ControllerOverlay({
    renderer: {
      renderChoicePicker: () => {},
      renderHistoryPage: () => historyRendered = true,
      setStatus: () => {},
    } as unknown as TuiRenderer,
    dispatch: () =>
      new Promise<PresentationIntentResult>((resolve) => {
        resolveSearch = resolve;
      }),
    setSession: () => {},
    idleAllowed: () => true,
    isIdle: () => true,
    readyStatus: () => 'ready',
    modelSelection: () => undefined,
    bindingIdentity: () => binding,
    fail: (error) => Promise.reject(error),
  });

  overlay.openHistorySearch();
  overlay.process({ kind: 'printable', text: 'x', codePoint: 120 });
  overlay.process({ kind: 'enter' });
  binding = 'session-two';
  resolveSearch({ kind: 'history_search' });
  await overlay.settle();
  assert(!historyRendered);
});
