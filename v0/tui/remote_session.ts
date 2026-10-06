import type {
  PresentationLifecycle,
  PresentationNavigationListing,
  PresentationProjection,
} from '../presentation/contract.ts';
import { HenjiApiClient, HenjiApiError } from '../api/client.ts';
import type {
  ApiSelection,
  CommandResult,
  CommandState,
  ContextView,
  CoreCommandValue,
  CoreCursor,
  CoreOperationName,
  RecallValue,
  SessionActivation,
  SessionOpenInput,
  SessionOpenSelection,
  SessionSnapshot,
  SessionStreamFrame,
} from '../api/contract.ts';
import { movePresentationPickerSelection } from '../presentation/contract.ts';
import { reduceSessionStreamFrame, type SessionClientState } from '../api/reducer.ts';
import { InputDecoder, type InputEvent, TuiEditor, TuiEditorHistory } from './input.ts';
import { TuiEventQueue } from './event_queue.ts';
import { TuiRenderer } from './render.ts';
import { RemoteCatalogUi } from './remote_catalog_ui.ts';
import { RemoteSystemNotices } from './system_notices.ts';
import {
  SLASH_COMMANDS,
  slashCommandCandidates,
  type SlashCommandDefinition,
  slashCommandHelpLines,
  slashPickerCandidates,
} from './slash_command.ts';
import { DenoTerminal, TerminalLifecycle, type TerminalPort } from './terminal.ts';
import {
  presentationPositionFromSnapshot,
  presentationStartupFromSnapshot,
  SnapshotConversationProjector,
} from './snapshot_presentation.ts';

export interface RemoteTuiDependencies {
  readonly terminal?: TerminalPort;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
  readonly afterAcquire?: () => void | Promise<void>;
}

export type RemoteTuiLaunchTarget =
  | Readonly<{ kind: 'implicit' }>
  | Readonly<{ kind: 'new' }>
  | Readonly<{ kind: 'continue' }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'session'; sessionId: string }>;

interface RemoteTuiLaunchOptions {
  readonly target: RemoteTuiLaunchTarget;
  readonly activation?: SessionActivation;
}

type SubmitKind = 'task' | 'steering' | 'follow-up';

const operationLabel = (kind: SubmitKind): string =>
  kind === 'task' ? 'task.submit' : kind === 'steering' ? 'execution.steer' : 'followUp.queue';

interface PendingSubmission {
  readonly kind: SubmitKind;
  readonly sessionId: string;
  readonly executionId?: string;
  readonly commandId: string;
  readonly text: string;
  readonly draftRevision: number;
  separated: boolean;
  processing: boolean;
}

interface AcceptedSubmission {
  readonly commandId: string;
  readonly cursor?: CoreCursor;
}

interface PendingCancellation {
  readonly sessionId: string;
  readonly commandId: string;
  readonly executionId: string;
  processing: boolean;
}

type FrameWaitResult =
  | {
    readonly kind: 'frame';
    readonly result: IteratorResult<SessionStreamFrame>;
    readonly generation: number;
  }
  | {
    readonly kind: 'resync';
    readonly frame: SessionStreamFrame;
    readonly generation: number;
  }
  | { readonly kind: 'stream_error'; readonly generation: number };

type RemoteTuiEvent =
  | FrameWaitResult
  | { readonly kind: 'input'; readonly events: InputEvent[] | null }
  | { readonly kind: 'input_error'; readonly error: unknown }
  | { readonly kind: 'exit' };

interface RemoteNavigationListing {
  readonly listing: PresentationNavigationListing;
  readonly selected: number;
  readonly page: number;
}

const NO_ACTIVE_SESSION =
  'core has no active Session; open a Session through API or specify --session';

const stderr = async (
  dependencies: RemoteTuiDependencies,
  text: string,
): Promise<void> => {
  if (dependencies.writeStderr !== undefined) {
    await dependencies.writeStderr(text);
    return;
  }
  await Deno.stderr.write(new TextEncoder().encode(text));
};

interface ResolvedStartupSession {
  readonly sessionId: string;
  readonly snapshot?: SessionSnapshot;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const configurationRejectionLines = (value: unknown): string[] => {
  const configuration = record(value);
  if (!Array.isArray(configuration?.rejections)) return [];
  return configuration.rejections.map((entry) => {
    const rejection = record(entry);
    return String(rejection?.target ?? 'configuration') + ' ' + String(rejection?.name ?? '') +
      (typeof rejection?.file === 'string' ? ' (' + rejection.file + ')' : '') + ': ' +
      String(rejection?.reason ?? 'rejected');
  });
};

const effectiveAgentSelector = (
  snapshot: SessionSnapshot,
): { agent?: string; file?: string; revision?: string } => {
  const configuration = record(snapshot.runtime.effectiveConfig?.configuration);
  const choice = record(configuration?.choice);
  return {
    ...(typeof configuration?.name === 'string' ? { agent: configuration.name } : {}),
    ...(typeof choice?.file === 'string' ? { file: choice.file } : {}),
    ...(typeof configuration?.revision === 'string' ? { revision: configuration.revision } : {}),
  };
};

const activationDifferences = (
  snapshot: SessionSnapshot,
  requested: SessionActivation,
): readonly string[] => {
  const config = snapshot.runtime.effectiveConfig;
  const selector = effectiveAgentSelector(snapshot);
  const differences: string[] = [];
  if (requested.agent !== undefined && requested.agent !== selector.agent) {
    differences.push(
      '--agent requested ' + requested.agent + ', active ' +
        (selector.agent ?? 'not reported'),
    );
  }
  if (requested.agentFile !== undefined) {
    const active = selector.file ?? 'not reported';
    if (requested.agentFile !== selector.file) {
      differences.push(
        '--agent-file requested ' + requested.agentFile +
          ', active ' +
          active,
      );
    }
  }
  if (
    requested.maxSteps !== undefined && requested.maxSteps !== config?.maxSteps
  ) {
    const active = config?.maxSteps === null || config === undefined
      ? 'not evaluated'
      : String(config.maxSteps);
    differences.push(
      '--max-steps requested ' + requested.maxSteps + ', active ' + active,
    );
  }
  if (
    requested.providerTimeoutMs !== undefined &&
    requested.providerTimeoutMs !== config?.providerTimeoutMs
  ) {
    const active = config === undefined ? 'not reported' : config.providerTimeoutMs + 'ms';
    differences.push(
      '--provider-timeout-ms requested ' + requested.providerTimeoutMs +
        'ms, active ' + active,
    );
  }
  if (
    requested.rootProvider !== undefined &&
    requested.rootProvider !== snapshot.session.selection.provider
  ) {
    differences.push(
      '--root-provider requested ' + requested.rootProvider +
        ', active selection ' +
        snapshot.session.selection.provider,
    );
  }
  return differences;
};

const commandReasonText = (reason: string): string =>
  reason.replace(/[A-Z]/gu, (letter) => ' ' + letter.toLowerCase());

const commandAfterLostResponse = async <T extends CoreCommandValue>(
  client: HenjiApiClient,
  commandId: string,
  send: () => Promise<CommandResult<T>>,
): Promise<CommandResult<CoreCommandValue>> => {
  try {
    return await send();
  } catch {
    let state = await client.commandRead(commandId);
    while (state.kind === 'processing') {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      state = await client.commandRead(commandId);
    }
    return state;
  }
};

const resolveStartupSession = async (
  client: HenjiApiClient,
  core: Awaited<ReturnType<HenjiApiClient['coreRead']>>,
  sessionId: string | undefined,
  launch: RemoteTuiLaunchOptions | undefined,
  dependencies: RemoteTuiDependencies,
): Promise<ResolvedStartupSession | undefined> => {
  if (launch === undefined) {
    const selected = sessionId ?? core.activeSessionId;
    if (selected === null) {
      await stderr(dependencies, NO_ACTIVE_SESSION + '\n');
      return undefined;
    }
    return { sessionId: selected };
  }

  const activeId = core.activeSessionId;
  let attachId: string | undefined;
  let selection: SessionOpenSelection | undefined;
  switch (launch.target.kind) {
    case 'implicit':
      if (activeId !== null) attachId = activeId;
      else selection = { kind: 'new' };
      break;
    case 'continue':
      if (activeId !== null) attachId = activeId;
      else selection = { kind: 'continue' };
      break;
    case 'session':
      if (activeId === launch.target.sessionId) attachId = activeId;
      else selection = { kind: 'exact', sessionId: launch.target.sessionId };
      break;
    case 'new':
      selection = { kind: 'new' };
      break;
    case 'none':
      selection = { kind: 'none' };
      break;
  }

  if (attachId !== undefined) {
    if (launch.activation !== undefined) {
      let active: SessionSnapshot;
      try {
        active = await client.sessionRead(attachId);
      } catch {
        await stderr(
          dependencies,
          'active Session configuration unavailable\n',
        );
        return undefined;
      }
      const differences = activationDifferences(active, launch.activation);
      if (differences.length > 0) {
        await stderr(
          dependencies,
          'active Session settings are unchanged:\n' + differences.join('\n') +
            '\nUse --new to apply these settings to a new Session.\n',
        );
        return undefined;
      }
    }
    return { sessionId: attachId };
  }

  if (
    selection === undefined ||
    !core.implementedOperations.includes('session.open')
  ) {
    await stderr(dependencies, 'session.open unavailable\n');
    return undefined;
  }
  const commandId = crypto.randomUUID();
  const input: SessionOpenInput = {
    commandId,
    selection,
    ...(launch.activation === undefined ? {} : { activation: launch.activation }),
  };
  let command: CommandResult<CoreCommandValue>;
  try {
    command = await commandAfterLostResponse(
      client,
      commandId,
      () => client.sessionOpen(input),
    );
  } catch {
    await stderr(
      dependencies,
      'session open response unknown · command #' + commandId + '\n',
    );
    return undefined;
  }
  if (command.kind === 'rejected') {
    await stderr(
      dependencies,
      'session open rejected: ' + commandReasonText(command.reason) + '\n',
    );
    return undefined;
  }
  if (!('sessionId' in command.value)) {
    await stderr(
      dependencies,
      'session open unconfirmed · command #' + commandId + '\n',
    );
    return undefined;
  }
  return {
    sessionId: command.value.sessionId,
    snapshot: await client.sessionRead(command.value.sessionId),
  };
};

export const presentationLifecycle = (
  snapshot: SessionSnapshot,
  cancellingExecutionId?: string,
): PresentationLifecycle => {
  if (
    cancellingExecutionId !== undefined && snapshot.runtime.active &&
    (snapshot.runtime.reservation?.executionId === cancellingExecutionId ||
      snapshot.runtime.execution?.executionId === cancellingExecutionId)
  ) return 'cancelling';
  switch (snapshot.runtime.phase) {
    case 'preparing':
    case 'running':
    case 'settling':
      return snapshot.runtime.active ? 'busy' : 'idle';
    case 'cancelling':
      return snapshot.runtime.active ? 'cancelling' : 'idle';
    case 'unavailable':
      return 'recoverable_error';
    case 'idle':
      return 'idle';
  }
};

export const cancelTargetExecutionId = (snapshot: SessionSnapshot): string | undefined => {
  if (
    !snapshot.runtime.active || snapshot.runtime.activeSessionId !== snapshot.session.id
  ) return undefined;
  if (snapshot.runtime.reservation !== undefined) return snapshot.runtime.reservation.executionId;
  const execution = snapshot.runtime.execution;
  if (
    execution !== null && execution.sessionId === snapshot.session.id &&
    (execution.lifecycle === 'active' ||
      snapshot.pending.activeTask?.executionId === execution.executionId)
  ) return execution.executionId;
  return undefined;
};

const projectionFromSnapshot = (
  snapshot: SessionSnapshot,
  workspace: string,
  cancellingExecutionId?: string,
): PresentationProjection => ({
  lifecycle: presentationLifecycle(snapshot, cancellingExecutionId),
  agentId: snapshot.session.position.agent,
  sessionId: snapshot.session.id,
  committedTurn: snapshot.session.position.committedTurn,
  workspace,
  model: {
    provider: snapshot.session.selection.provider,
    modelId: snapshot.session.selection.modelId,
    effort: snapshot.session.selection.effort,
  },
  trust: 'trusted_local',
  credentialPolicy: 'before_each_provider_request',
  ...(snapshot.session.position.checkpoint === undefined ? {} : {
    checkpoint: {
      coveredThroughTurn: snapshot.session.position.checkpoint.coveredThroughTurn,
      retainedFromTurn: snapshot.session.position.checkpoint.retainedFromTurn,
    },
  }),
  pending: [],
  capabilities: { canNavigate: false, canCompact: false },
  generation: snapshot.cursor.revision,
});

const listingFromSessions = (
  sessions: Awaited<ReturnType<HenjiApiClient['sessionsList']>>['sessions'],
  currentSessionId: string,
): PresentationNavigationListing => ({
  sessions: sessions.map((session) => ({
    id: session.id,
    agent: session.agent,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.title === undefined ? {} : { title: session.title }),
    turnCount: session.committedTurn,
    messageCount: session.messageCount,
    current: session.id === currentSessionId,
    resumed: session.runtime?.active ?? false,
    mismatch: false,
  })),
  skippedInvalid: 0,
});

const contextLines = (context: ContextView): readonly string[] => [
  'context · read-only',
  ...(context.checkpoint === undefined ? ['checkpoint: none'] : [
    'checkpoint through turn ' + context.checkpoint.coveredThroughTurn +
    ' · retain from ' + context.checkpoint.retainedFromTurn,
    ...(context.checkpoint.summary === undefined ? [] : [context.checkpoint.summary]),
  ]),
  ...(context.pendingRecall === undefined ? ['pending recall: none'] : [
    'pending recall from #' + context.pendingRecall.sourceExecutionId +
    ' · evidence ' + context.pendingRecall.evidence,
  ]),
  ...(context.latestRequest === undefined ? ['latest request: none'] : [
    'latest request #' + context.latestRequest.requestOrdinal + ' · ' +
    context.latestRequest.lane + ' · ' + context.latestRequest.purpose,
    'execution #' + context.latestRequest.executionId + ' · step ' +
    context.latestRequest.modelStep + ' · ' + context.latestRequest.itemCount +
    ' items',
  ]),
];

const effectiveConfigLines = (snapshot: SessionSnapshot): readonly string[] => {
  const config = snapshot.runtime.effectiveConfig;
  if (
    snapshot.runtime.activeSessionId !== snapshot.session.id ||
    config === undefined
  ) {
    return ['No active Session configuration is available in this saved view.'];
  }
  const selector = effectiveAgentSelector(snapshot);
  return [
    'active Session configuration:',
    'agent ' + (selector.agent ?? 'not reported') +
    (selector.revision === undefined ? '' : ' · revision ' + selector.revision),
    'configuration ' + String(record(config.configuration)?.status ?? 'pending'),
    ...configurationRejectionLines(config.configuration),
    'max steps ' +
    (config.maxSteps === null ? 'unevaluated' : config.maxSteps) +
    ' · ' + config.maxStepsSource,
    'provider timeout ' + config.providerTimeoutMs + 'ms',
  ];
};

const contextPanelLines = (snapshot: SessionSnapshot): readonly string[] => [
  ...contextLines(snapshot.context),
  ...effectiveConfigLines(snapshot),
];

const renderSessionOrientation = (
  renderer: TuiRenderer,
  snapshot: SessionSnapshot,
  workspace: string,
  cancellingExecutionId?: string,
): void => {
  const position = presentationPositionFromSnapshot(snapshot);
  renderer.setCurrentPosition(position);
  const execution = snapshot.runtime.execution;
  renderer.setProjection(
    projectionFromSnapshot(snapshot, workspace, cancellingExecutionId),
    snapshot.runtime.active && execution !== null ? Date.parse(execution.createdAt) : undefined,
  );
  renderer.renderCompactStartup(
    presentationStartupFromSnapshot(snapshot, workspace),
    position,
  );
};

const renderSnapshot = (
  renderer: TuiRenderer,
  client: SessionClientState,
  workspace: string,
  preserveScroll: boolean,
  projector: SnapshotConversationProjector,
  notices: RemoteSystemNotices,
  cancellingExecutionId?: string,
): void => {
  const snapshot = client.snapshot;
  if (!preserveScroll) {
    renderer.clearModal();
    renderer.latest();
  }
  renderSessionOrientation(renderer, snapshot, workspace, cancellingExecutionId);
  const scope = JSON.stringify([
    snapshot.cursor.coreEpoch,
    snapshot.session.id,
  ]);
  renderer.setDisplayScope(scope);
  const projected = projector.project(client, scope);
  const noticeUpdate = notices.sync(client, projected.store, {
    reset: projected.reset,
    structureChanged: projected.structureChanged,
  });
  const structureChanged = projected.structureChanged || noticeUpdate.structureChanged;
  renderer.setKeyedConversationStore(
    projected.store,
    !preserveScroll || projected.reset,
    structureChanged,
    projected.previousIds ?? noticeUpdate.previousIds,
    new Set([...projected.changedIds, ...noticeUpdate.changedIds]),
  );
};

const isEditorTextMutation = (event: InputEvent): boolean =>
  event.kind === 'printable' || event.kind === 'paste' ||
  event.kind === 'backspace' ||
  event.kind === 'newline' || event.kind === 'alt_enter';

const applyEditorEvent = (editor: TuiEditor, event: InputEvent): boolean => {
  switch (event.kind) {
    case 'printable':
      return editor.insert(event.text);
    case 'paste':
      return editor.paste(event.text);
    case 'newline':
    case 'alt_enter':
      return editor.insert('\n');
    case 'backspace':
      return editor.backspace();
    case 'home':
      return editor.home();
    case 'end':
      return editor.end();
    case 'left':
      return editor.moveLeft();
    case 'right':
      return editor.moveRight();
    case 'up':
      return editor.moveUp();
    case 'down':
      return editor.moveDown();
    default:
      return false;
  }
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

class RemoteInputReader {
  private pending: Promise<Uint8Array | null> | undefined;

  constructor(
    private readonly lifecycle: TerminalLifecycle,
    private readonly decoder: InputDecoder,
  ) {}

  async next(): Promise<InputEvent[] | null> {
    for (;;) {
      this.pending ??= this.lifecycle.read();
      const deadline = this.decoder.escapeDeadline();
      if (deadline === undefined) {
        const bytes = await this.pending;
        this.pending = undefined;
        if (bytes === null) return null;
        const events = this.decoder.feed(bytes);
        if (events.length > 0) return events;
        continue;
      }
      const remaining = Math.max(0, deadline - Date.now());
      const result = await Promise.race([
        this.pending.then((bytes) => ({ kind: 'input' as const, bytes })),
        wait(remaining).then(() => ({ kind: 'timeout' as const })),
      ]);
      if (result.kind === 'timeout') {
        const events = this.decoder.poll();
        if (events.length > 0) return events;
        continue;
      }
      this.pending = undefined;
      if (result.bytes === null) return null;
      const events = this.decoder.feed(result.bytes);
      if (events.length > 0) return events;
    }
  }
}

/** Attach a TUI to one core Session. Detaching only aborts this client's subscription. */
export const runRemoteTui = async (
  url: string,
  sessionId?: string,
  dependencies: RemoteTuiDependencies = {},
  launch?: RemoteTuiLaunchOptions,
): Promise<number> => {
  const client = new HenjiApiClient(url);
  let core: Awaited<ReturnType<HenjiApiClient['coreRead']>>;
  try {
    core = await client.coreRead();
  } catch {
    await stderr(dependencies, 'core connection failed\n');
    return 1;
  }
  const startup = await resolveStartupSession(
    client,
    core,
    sessionId,
    launch,
    dependencies,
  );
  if (startup === undefined) return 1;
  let selectedSessionId = startup.sessionId;
  const openSnapshot = startup.snapshot;

  const terminal = dependencies.terminal ?? new DenoTerminal();
  if (!terminal.stdinIsTerminal() || !terminal.stdoutIsTerminal()) {
    await stderr(dependencies, 'remote TUI requires a terminal\n');
    return 1;
  }

  let subscriptionAbort = new AbortController();
  let iterator = client.sessionSubscribe(selectedSessionId, {
    signal: subscriptionAbort.signal,
  })[Symbol.asyncIterator]();
  let firstFrame: IteratorResult<SessionStreamFrame>;
  try {
    firstFrame = await iterator.next();
  } catch {
    await stderr(dependencies, 'Session connection failed\n');
    subscriptionAbort.abort();
    return 1;
  }
  if (
    firstFrame.done || firstFrame.value.kind !== 'session.snapshot' ||
    firstFrame.value.snapshot.session.id !== selectedSessionId
  ) {
    await stderr(dependencies, 'Session snapshot unavailable\n');
    subscriptionAbort.abort();
    return 1;
  }
  if (
    openSnapshot !== undefined &&
    openSnapshot.session.id !== firstFrame.value.snapshot.session.id
  ) {
    await stderr(
      dependencies,
      'Session open target changed before subscription\n',
    );
    subscriptionAbort.abort();
    return 1;
  }

  let state: SessionClientState | undefined = reduceSessionStreamFrame(
    undefined,
    firstFrame.value,
  );
  let selectedModel: ApiSelection = state.snapshot.session.selection;
  const renderer = new TuiRenderer(terminal);
  const conversationProjector = new SnapshotConversationProjector();
  const systemNotices = new RemoteSystemNotices();
  const editor = new TuiEditor();
  const editorHistory = new TuiEditorHistory();
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const decoder = new InputDecoder();
  let draftRevision = 0;
  let connected = true;
  let connectionLossReported = false;
  let exitRequested = false;
  const exitAbort = new AbortController();
  let shutdownPending = false;
  let pendingSubmission: PendingSubmission | undefined;
  let acceptedSubmission: AcceptedSubmission | undefined;
  const unconfirmedSubmissions = new Map<string, AcceptedSubmission>();
  let pendingCancellation: PendingCancellation | undefined;
  let cancellationRequested = false;
  let cancellationExecutionId: string | undefined;
  let notice: string | undefined;
  let slashPickerSuppressedText: string | undefined;
  let commandPoll: ReturnType<typeof setTimeout> | undefined;
  let navigationPending = false;
  let commandMutationPending = false;
  let navigationGeneration = 0;
  let subscriptionGeneration = 0;
  const events = new TuiEventQueue<RemoteTuiEvent>();

  const requestExit = (): void => {
    if (exitRequested) return;
    exitRequested = true;
    exitAbort.abort();
    subscriptionAbort.abort();
    if (commandPoll !== undefined) clearTimeout(commandPoll);
    commandPoll = undefined;
    events.push({ kind: 'exit' });
  };

  const snapshot = (): SessionSnapshot => state!.snapshot;
  const nextFrameWait = (): Promise<FrameWaitResult> => {
    const generation = subscriptionGeneration;
    return iterator.next().then(
      (next) => ({ kind: 'frame' as const, result: next, generation }),
      () => ({ kind: 'stream_error' as const, generation }),
    );
  };
  const waitForFrame = (pending: Promise<FrameWaitResult>): void => {
    void pending.then((frame) => events.push(frame));
  };
  const hasPendingLocalCommand = (): boolean =>
    pendingSubmission !== undefined || acceptedSubmission !== undefined ||
    pendingCancellation !== undefined || commandMutationPending;
  const hasOperation = (operation: CoreOperationName): boolean =>
    snapshot().runtime.operations.includes(operation);
  const targetsActiveSession = (): boolean =>
    snapshot().runtime.activeSessionId === snapshot().session.id;
  const activeExecution = () => {
    const current = snapshot();
    const execution = current.runtime.execution;
    return targetsActiveSession() && current.runtime.active &&
        execution !== null &&
        execution.sessionId === current.session.id &&
        (execution.lifecycle === 'active' ||
          current.pending.activeTask?.executionId === execution.executionId)
      ? execution
      : undefined;
  };
  const activeExecutionId = (): string | undefined => {
    const current = snapshot();
    return cancelTargetExecutionId(current);
  };
  const canSubmit = (): boolean =>
    connected && targetsActiveSession() && !unconfirmedSubmissions.has(snapshot().session.id) &&
    hasOperation('task.submit');
  const canCancel = (): boolean =>
    connected && activeExecutionId() !== undefined &&
    hasOperation('execution.cancel');

  const updateStatus = (): void => {
    const current = snapshot();
    const execution = activeExecution();
    const receiptPending = pendingSubmission !== undefined || acceptedSubmission !== undefined ||
      unconfirmedSubmissions.has(current.session.id);
    const cancelling = pendingCancellation !== undefined || cancellationRequested ||
      current.runtime.phase === 'cancelling';
    const working = receiptPending || shutdownPending || current.runtime.active ||
      current.runtime.phase === 'preparing' || current.runtime.phase === 'running' ||
      current.runtime.phase === 'settling';
    const activity = !connected
      ? 'DISCONNECTED'
      : !targetsActiveSession()
      ? 'READ-ONLY'
      : cancelling
      ? 'cancelling'
      : working
      ? 'working'
      : canSubmit()
      ? 'ready'
      : 'READ-ONLY';
    const controls: string[] = [];
    if (!shutdownPending) {
      if (editor.text.trimStart().startsWith('/')) controls.push('Enter command');
      else if (activity === 'ready') controls.push('Enter submit');
      if (
        execution !== undefined && connected && !receiptPending && pendingCancellation === undefined
      ) {
        if (hasOperation('followUp.queue')) controls.push('F2 queue');
        if (hasOperation('execution.steer')) controls.push('F3 steer');
      }
      if (canCancel() && !cancellationRequested) controls.push('Esc cancel');
      controls.push('/ commands');
    }
    renderer.setRemoteFooter({
      activity,
      controls,
      ...(notice === undefined ? {} : { hint: notice }),
    }, execution === undefined ? undefined : Date.parse(execution.createdAt));
  };

  const retainNotice = (
    sessionId: string,
    identity: string,
    text: string,
    failureWord?: string,
    executionId?: string,
  ): void => {
    systemNotices.retain(sessionId, identity, text, failureWord, executionId);
    if (snapshot().session.id === sessionId) {
      notice = undefined;
      const store = renderer.stateSnapshot().keyedConversation;
      if (store !== undefined) {
        const noticeUpdate = systemNotices.refresh(sessionId, store);
        if (noticeUpdate.changedIds.size > 0) {
          renderer.setKeyedConversationStore(
            store,
            false,
            noticeUpdate.structureChanged,
            noticeUpdate.previousIds,
            noticeUpdate.changedIds,
          );
        }
      }
      renderer.redraw();
      updateStatus();
    }
  };

  const retainLocalFailure = (
    sessionId: string,
    operation: string,
    detail: string,
    executionId?: string,
    failureWord = 'REJECTED',
  ): void => {
    retainNotice(
      sessionId,
      `local:${crypto.randomUUID()}`,
      `${failureWord} · ${operation} · ${detail}`,
      failureWord,
      executionId,
    );
  };

  const noteConnectionLoss = (): void => {
    if (connectionLossReported) return;
    connectionLossReported = true;
    const sessionId = snapshot().session.id;
    retainNotice(
      sessionId,
      `connection:${crypto.randomUUID()}`,
      'DISCONNECTED · Core connection lost · the displayed Session may be stale',
      'DISCONNECTED',
    );
  };

  const editorBusy = (): boolean =>
    pendingSubmission !== undefined || acceptedSubmission !== undefined ||
    pendingCancellation !== undefined ||
    (targetsActiveSession() && snapshot().runtime.active);

  const renderEditor = (): void => {
    renderer.setEditorSnapshot(editor.snapshot());
    const overlay = renderer.stateSnapshot().overlay;
    if (editor.text !== slashPickerSuppressedText) slashPickerSuppressedText = undefined;
    const candidates = slashPickerCandidates(editor.text, editor.cursorScalar);
    if (
      (overlay.kind === 'none' || overlay.kind === 'slashPicker') &&
      candidates !== undefined && editor.text !== slashPickerSuppressedText
    ) {
      const previous = overlay.kind === 'slashPicker'
        ? overlay.candidates[overlay.selected]?.command
        : undefined;
      const selected = Math.max(
        0,
        candidates.findIndex((candidate) => candidate.command === previous),
      );
      renderer.setSlashCommandCandidates([]);
      renderer.renderSlashPicker(candidates, selected);
    } else {
      if (overlay.kind === 'slashPicker') renderer.clearModal();
      renderer.setSlashCommandCandidates(
        editor.text === slashPickerSuppressedText ? [] : slashCommandCandidates(editor.text),
      );
    }
  };

  const walkInputHistory = (direction: 'up' | 'down'): boolean => {
    if (direction === 'down') {
      if (!editorHistory.navigating) return false;
      const next = editorHistory.next();
      if (next === null) {
        notice = 'history boundary';
        updateStatus();
        return true;
      }
      editor.setSnapshot(next);
      notice = undefined;
      renderEditor();
      updateStatus();
      return true;
    }
    if (
      !editorHistory.navigating && editor.text.length > 0 && editor.moveUp()
    ) {
      notice = undefined;
      renderEditor();
      updateStatus();
      return true;
    }
    const previous = editorHistory.previous(editor.snapshot());
    if (previous === null) {
      if (editor.text.length === 0) {
        notice = 'history empty';
        updateStatus();
      }
      return true;
    }
    editor.setSnapshot(previous);
    notice = undefined;
    renderEditor();
    updateStatus();
    return true;
  };

  const catalogUi = new RemoteCatalogUi({
    client,
    renderer,
    sessionId: () => snapshot().session.id,
    selection: () => selectedModel,
    selectionChanged: (selection) => {
      selectedModel = selection;
      updateStatus();
    },
    canChangeSelection: () =>
      connected && targetsActiveSession() &&
      snapshot().runtime.phase === 'idle' && hasOperation('selection.change'),
    canRegisterCredential: () =>
      connected &&
      snapshot().runtime.phase === 'idle' &&
      hasOperation('credential.register'),
    setNotice: (text) => {
      notice = text;
      updateStatus();
    },
    retainNotice: (sessionId, identity, text, failureWord) => {
      retainNotice(sessionId, identity, text, failureWord);
    },
  });

  const replaceEditorText = (text: string): void => {
    editorHistory.resetNavigation();
    editor.setSnapshot({
      text,
      cursorScalar: [...text].length,
      byteLength: new TextEncoder().encode(text).byteLength,
    });
    draftRevision += 1;
    renderEditor();
  };

  const separateSubmittedDraft = (): void => {
    if (pendingSubmission === undefined || pendingSubmission.separated) return;
    pendingSubmission.separated = true;
    if (editor.text === pendingSubmission.text) replaceEditorText('');
  };

  const finishDraft = (
    submission: PendingSubmission,
    accepted: boolean,
  ): void => {
    if (accepted) {
      if (
        !submission.separated && editor.text === submission.text &&
        draftRevision === submission.draftRevision
      ) replaceEditorText('');
      return;
    }
    if (!submission.separated) return;
    const current = editor.text;
    replaceEditorText(
      current.length === 0 ? submission.text : `${submission.text}\n${current}`,
    );
  };

  const receiptIsObserved = (receipt: AcceptedSubmission): boolean => {
    const current = snapshot();
    if (
      receipt.cursor !== undefined &&
      receipt.cursor.coreEpoch === current.cursor.coreEpoch &&
      receipt.cursor.sessionId === current.cursor.sessionId &&
      current.cursor.revision >= receipt.cursor.revision
    ) return true;
    return current.runtime.execution?.submittedByCommandId ===
        receipt.commandId ||
      current.runtime.reservation?.commandId === receipt.commandId ||
      current.pending.steering?.commandId === receipt.commandId ||
      current.pending.followUp?.commandId === receipt.commandId ||
      current.pending.followUps.some((record) => record.commandId === receipt.commandId);
  };

  const syncCoreObservations = (): void => {
    if (
      acceptedSubmission !== undefined && receiptIsObserved(acceptedSubmission)
    ) {
      acceptedSubmission = undefined;
    }
    const current = snapshot();
    const unconfirmed = unconfirmedSubmissions.get(current.session.id);
    if (
      unconfirmed !== undefined && (
        current.runtime.execution?.submittedByCommandId === unconfirmed.commandId ||
        (unconfirmed.cursor !== undefined && receiptIsObserved(unconfirmed))
      )
    ) unconfirmedSubmissions.delete(current.session.id);
    const executionId = activeExecutionId();
    if (current.runtime.phase === 'cancelling' && executionId !== undefined) {
      cancellationRequested = true;
      cancellationExecutionId = executionId;
    } else if (
      !current.runtime.active ||
      executionId !== cancellationExecutionId
    ) {
      cancellationRequested = false;
      cancellationExecutionId = undefined;
    }
  };
  syncCoreObservations();

  const rejectedText = (reason: string): string =>
    reason.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);

  const markUnconfirmedSubmission = (submission: PendingSubmission): void => {
    const marker: AcceptedSubmission = { commandId: submission.commandId };
    unconfirmedSubmissions.set(submission.sessionId, marker);
    // A fresh Core read can confirm input availability; the pre-send snapshot cannot.
    void client.sessionRead(submission.sessionId).then((saved) => {
      if (
        exitRequested || unconfirmedSubmissions.get(submission.sessionId) !== marker ||
        saved.session.id !== submission.sessionId
      ) return;
      unconfirmedSubmissions.set(submission.sessionId, { ...marker, cursor: saved.cursor });
      syncCoreObservations();
      updateStatus();
    }, () => {});
  };

  const finalizeTaskCommand = (
    command: CommandState<CoreCommandValue>,
    submission: PendingSubmission,
  ): void => {
    if (exitRequested || pendingSubmission !== submission) return;
    if (command.kind === 'processing') {
      submission.processing = true;
      updateStatus();
      commandPoll = setTimeout(() => {
        commandPoll = undefined;
        void readTaskCommand(submission);
      }, 250);
      return;
    }
    if (command.kind === 'rejected') {
      pendingSubmission = undefined;
      finishDraft(submission, false);
      retainNotice(
        submission.sessionId,
        submission.commandId,
        `REJECTED · ${JSON.stringify(submission.text)} · draft kept · ${
          rejectedText(command.reason)
        } · check the Session and execution state before retrying`,
        'REJECTED',
        submission.executionId,
      );
      return;
    }
    if (
      submission.kind === 'follow-up'
        ? !('queueId' in command.value)
        : !('executionId' in command.value) || 'result' in command.value
    ) {
      pendingSubmission = undefined;
      finishDraft(submission, false);
      markUnconfirmedSubmission(submission);
      retainNotice(
        submission.sessionId,
        submission.commandId,
        `UNCONFIRMED · ${JSON.stringify(submission.text)} · draft kept · ${
          operationLabel(submission.kind)
        } receipt unavailable · check command state before resubmitting`,
        'UNCONFIRMED',
        submission.executionId,
      );
      return;
    }
    const accepted: AcceptedSubmission = {
      commandId: command.commandId,
      ...(command.cursor === undefined ? {} : { cursor: command.cursor }),
    };
    if (
      submission.kind === 'task' &&
      renderer.stateSnapshot().scroll.kind !== 'followLatest'
    ) renderer.latest(false);
    editorHistory.record(submission.text);
    pendingSubmission = undefined;
    acceptedSubmission = accepted;
    finishDraft(submission, true);
    syncCoreObservations();
    updateStatus();
  };

  async function readTaskCommand(submission: PendingSubmission): Promise<void> {
    try {
      const command = await client.commandRead(submission.commandId);
      finalizeTaskCommand(command, submission);
    } catch {
      if (exitRequested || pendingSubmission !== submission) return;
      pendingSubmission = undefined;
      finishDraft(submission, false);
      markUnconfirmedSubmission(submission);
      retainNotice(
        submission.sessionId,
        submission.commandId,
        `UNCONFIRMED · ${
          JSON.stringify(submission.text)
        } · draft kept · command receipt unavailable · check command state before resubmitting`,
        'UNCONFIRMED',
        submission.executionId,
      );
    }
  }

  const submitDraft = (
    kind: SubmitKind = activeExecution() === undefined ? 'task' : 'steering',
  ): void => {
    const targetSessionId = snapshot().session.id;
    if (navigationPending || commandMutationPending) {
      const text = editor.submit();
      if (text !== null) {
        retainNotice(
          targetSessionId,
          `local:${crypto.randomUUID()}`,
          `REJECTED · ${
            JSON.stringify(text)
          } · draft kept · Session operation still pending · check the current command receipt before retrying`,
          'REJECTED',
          activeExecutionId(),
        );
      } else {
        notice = 'Session operation still pending';
        updateStatus();
      }
      return;
    }
    if (
      pendingSubmission !== undefined || acceptedSubmission !== undefined ||
      unconfirmedSubmissions.has(targetSessionId)
    ) {
      const text = editor.submit();
      if (text !== null) {
        retainNotice(
          targetSessionId,
          `local:${crypto.randomUUID()}`,
          `REJECTED · ${
            JSON.stringify(text)
          } · draft kept · submission receipt still awaiting Core state · check the current command before retrying`,
          'REJECTED',
          activeExecution()?.executionId,
        );
      } else {
        notice = 'submission still awaiting core state';
        updateStatus();
      }
      return;
    }
    const text = editor.submit();
    if (text === null) return;
    const execution = activeExecution();
    const available = kind === 'task' ? canSubmit() : connected && execution !== undefined &&
      hasOperation(
        kind === 'steering' ? 'execution.steer' : 'followUp.queue',
      );
    if (!available) {
      retainNotice(
        targetSessionId,
        `local:${crypto.randomUUID()}`,
        `REJECTED · ${JSON.stringify(text)} · draft kept · ${
          operationLabel(kind)
        } unavailable for this Session · check the active execution and available operation before retrying`,
        'REJECTED',
        execution?.executionId,
      );
      return;
    }
    const submission: PendingSubmission = {
      kind,
      sessionId: targetSessionId,
      ...(execution === undefined ? {} : { executionId: execution.executionId }),
      commandId: crypto.randomUUID(),
      text,
      draftRevision,
      separated: false,
      processing: false,
    };
    pendingSubmission = submission;
    notice = undefined;
    updateStatus();
    const input = { commandId: submission.commandId, text: submission.text };
    const operation = kind === 'task'
      ? client.taskSubmit(submission.sessionId, input)
      : kind === 'steering'
      ? client.steeringSubmit(
        submission.sessionId,
        submission.executionId!,
        input,
      )
      : client.followUpQueue(submission.sessionId, {
        ...input,
        afterExecutionId: submission.executionId!,
      });
    void operation.then(
      (command) => finalizeTaskCommand(command, submission),
      async () => {
        if (exitRequested || pendingSubmission !== submission) return;
        submission.processing = true;
        notice = undefined;
        updateStatus();
        await readTaskCommand(submission);
      },
    );
  };

  const finalizeCancelCommand = (
    command: CommandState<CoreCommandValue>,
    cancellation: PendingCancellation,
  ): void => {
    if (exitRequested || pendingCancellation !== cancellation) return;
    if (command.kind === 'processing') {
      cancellation.processing = true;
      updateStatus();
      commandPoll = setTimeout(() => {
        commandPoll = undefined;
        void readCancelCommand(cancellation);
      }, 250);
      return;
    }
    pendingCancellation = undefined;
    if (command.kind === 'rejected') {
      cancellationRequested = false;
      cancellationExecutionId = undefined;
      retainNotice(
        cancellation.sessionId,
        cancellation.commandId,
        `REJECTED · execution.cancel · execution #${cancellation.executionId} · ${
          rejectedText(command.reason)
        }`,
        'REJECTED',
        cancellation.executionId,
      );
      return;
    }
    if (!('result' in command.value)) {
      retainNotice(
        cancellation.sessionId,
        cancellation.commandId,
        `UNCONFIRMED · execution.cancel · execution #${cancellation.executionId} · command result unavailable · check execution state before retrying`,
        'UNCONFIRMED',
        cancellation.executionId,
      );
      return;
    }
    cancellationRequested = command.value.result !== 'idle';
    cancellationExecutionId = cancellationRequested ? cancellation.executionId : undefined;
    updateStatus();
  };

  async function readCancelCommand(
    cancellation: PendingCancellation,
  ): Promise<void> {
    try {
      const command = await client.commandRead(cancellation.commandId);
      finalizeCancelCommand(command, cancellation);
    } catch {
      if (exitRequested || pendingCancellation !== cancellation) return;
      pendingCancellation = undefined;
      retainNotice(
        cancellation.sessionId,
        cancellation.commandId,
        `UNCONFIRMED · execution.cancel · execution #${cancellation.executionId} · command result unavailable · check execution state before retrying`,
        'UNCONFIRMED',
        cancellation.executionId,
      );
    }
  }

  const cancelActiveExecution = (): void => {
    if (pendingCancellation !== undefined) return;
    const targetSessionId = snapshot().session.id;
    const executionId = activeExecutionId();
    if (
      executionId === undefined &&
      (pendingSubmission !== undefined || acceptedSubmission !== undefined)
    ) {
      retainLocalFailure(
        targetSessionId,
        'execution.cancel',
        'submission reservation is not available yet; check its command state',
      );
      return;
    }
    if (!canCancel() || executionId === undefined) {
      retainLocalFailure(
        targetSessionId,
        'execution.cancel',
        'unavailable for this Session; check execution state and available operations',
        executionId,
      );
      return;
    }
    const cancellation: PendingCancellation = {
      sessionId: targetSessionId,
      commandId: crypto.randomUUID(),
      executionId,
      processing: false,
    };
    pendingCancellation = cancellation;
    cancellationRequested = true;
    cancellationExecutionId = executionId;
    notice = undefined;
    updateStatus();
    void client.executionCancel(cancellation.sessionId, executionId, {
      commandId: cancellation.commandId,
    }).then(
      (command) => finalizeCancelCommand(command, cancellation),
      async () => {
        if (exitRequested || pendingCancellation !== cancellation) return;
        cancellation.processing = true;
        notice = undefined;
        updateStatus();
        await readCancelCommand(cancellation);
      },
    );
  };

  const helpLines = (): readonly string[] => slashCommandHelpLines();

  const clearRemoteOverlay = (): void => {
    navigationGeneration += 1;
    navigationPending = false;
    renderer.clearModal();
    notice = undefined;
    updateStatus();
  };

  const switchDisplayedSession = async (
    targetSessionId: string,
    generation: number,
    noticeSessionId: string,
    operationIdentity: string,
  ): Promise<boolean> => {
    if (hasPendingLocalCommand()) {
      retainNotice(
        noticeSessionId,
        operationIdentity,
        `REJECTED · Session view · ${targetSessionId} · current command receipt is pending; check that receipt before retrying`,
        'REJECTED',
      );
      return false;
    }
    const nextAbort = new AbortController();
    const nextIterator = client.sessionSubscribe(targetSessionId, {
      signal: nextAbort.signal,
    })[Symbol.asyncIterator]();
    let first: IteratorResult<SessionStreamFrame>;
    try {
      first = await nextIterator.next();
    } catch {
      nextAbort.abort();
      if (navigationGeneration === generation) {
        navigationPending = false;
        retainNotice(
          noticeSessionId,
          operationIdentity,
          `FAILED · Session view · ${targetSessionId} subscription failed; current view unchanged`,
          'FAILED',
        );
      }
      return false;
    }
    if (
      exitRequested || navigationGeneration !== generation ||
      hasPendingLocalCommand()
    ) {
      nextAbort.abort();
      try {
        await nextIterator.return?.(undefined);
      } catch {
        // A superseded read subscription has no Core ownership.
      }
      return false;
    }
    if (
      first.done || first.value.kind !== 'session.snapshot' ||
      first.value.snapshot.session.id !== targetSessionId
    ) {
      nextAbort.abort();
      try {
        await nextIterator.return?.(undefined);
      } catch {
        // The old subscription remains the displayed Session.
      }
      navigationPending = false;
      retainNotice(
        noticeSessionId,
        operationIdentity,
        `FAILED · Session view · ${targetSessionId} snapshot unavailable; current view unchanged`,
        'FAILED',
      );
      return false;
    }
    const previousAbort = subscriptionAbort;
    const previousIterator = iterator;
    subscriptionGeneration += 1;
    selectedSessionId = targetSessionId;
    subscriptionAbort = nextAbort;
    iterator = nextIterator;
    state = reduceSessionStreamFrame(undefined, first.value);
    selectedModel = snapshot().session.selection;
    unconfirmedSubmissions.delete(targetSessionId);
    connected = true;
    connectionLossReported = false;
    navigationPending = false;
    renderer.clearModal();
    syncCoreObservations();
    renderSnapshot(
      renderer,
      state!,
      core.workspace,
      false,
      conversationProjector,
      systemNotices,
      cancellationRequested ? cancellationExecutionId : undefined,
    );
    renderEditor();
    notice = undefined;
    updateStatus();
    waitForFrame(nextFrameWait());
    previousAbort.abort();
    try {
      const closing = previousIterator.return?.(undefined);
      if (closing !== undefined) void closing.catch(() => {});
    } catch {
      // Replacing this UI subscription never closes or cancels Core work.
    }
    return true;
  };

  const showSessionPicker = (): void => {
    const targetSessionId = snapshot().session.id;
    if (hasPendingLocalCommand() || navigationPending) {
      retainLocalFailure(
        targetSessionId,
        'Session list',
        'current command is still pending; check its receipt before retrying',
      );
      return;
    }
    const generation = ++navigationGeneration;
    navigationPending = true;
    renderer.renderSessionPicker(
      { sessions: [], skippedInvalid: 0 },
      0,
      0,
      true,
      'view',
    );
    notice = undefined;
    updateStatus();
    void client.sessionsList().then(
      (result) => {
        if (
          exitRequested || navigationGeneration !== generation ||
          renderer.stateSnapshot().overlay.kind !== 'sessionPicker'
        ) return;
        navigationPending = false;
        renderer.renderSessionPicker(
          listingFromSessions(result.sessions, targetSessionId),
          0,
          0,
          false,
          'view',
        );
        notice = undefined;
        updateStatus();
      },
      () => {
        if (exitRequested || navigationGeneration !== generation) return;
        navigationPending = false;
        renderer.clearModal();
        retainLocalFailure(
          targetSessionId,
          'Session list',
          'unavailable; check the Core connection and retry',
          undefined,
          'FAILED',
        );
      },
    );
  };

  const viewSession = (targetSessionId: string): void => {
    const sourceSessionId = snapshot().session.id;
    if (hasPendingLocalCommand() || navigationPending) {
      retainNotice(
        sourceSessionId,
        `local:${crypto.randomUUID()}`,
        `REJECTED · Session view · ${targetSessionId} · current command receipt is pending; check it before retrying`,
        'REJECTED',
      );
      return;
    }
    if (targetSessionId === selectedSessionId) {
      clearRemoteOverlay();
      return;
    }
    const generation = ++navigationGeneration;
    const operationIdentity = `local:${crypto.randomUUID()}`;
    navigationPending = true;
    notice = 'reading Session ' + targetSessionId;
    updateStatus();
    void client.sessionRead(targetSessionId).then(
      async (saved) => {
        if (exitRequested || navigationGeneration !== generation) return;
        if (saved.session.id !== targetSessionId) {
          navigationPending = false;
          retainNotice(
            sourceSessionId,
            operationIdentity,
            `FAILED · Session view · requested ${targetSessionId}, received ${saved.session.id}`,
            'FAILED',
          );
          return;
        }
        await switchDisplayedSession(
          saved.session.id,
          generation,
          sourceSessionId,
          operationIdentity,
        );
      },
      () => {
        if (exitRequested || navigationGeneration !== generation) return;
        navigationPending = false;
        retainNotice(
          sourceSessionId,
          operationIdentity,
          `FAILED · Session view · ${targetSessionId} read unavailable; current view unchanged`,
          'FAILED',
        );
      },
    );
  };

  const openSession = (
    selection: SessionOpenSelection,
    fromSessionId?: string,
  ): void => {
    const sourceSessionId = fromSessionId ?? snapshot().session.id;
    if (hasPendingLocalCommand() || navigationPending) {
      retainLocalFailure(
        sourceSessionId,
        'session.open',
        'current command receipt is pending; check it before retrying',
      );
      return;
    }
    if (!core.implementedOperations.includes('session.open')) {
      retainLocalFailure(
        sourceSessionId,
        'session.open',
        'unavailable in this Core; check the Core version and operations',
      );
      return;
    }
    const generation = ++navigationGeneration;
    const commandId = crypto.randomUUID();
    navigationPending = true;
    commandMutationPending = true;
    notice = 'opening Session';
    updateStatus();
    const input: SessionOpenInput = {
      commandId,
      selection,
      ...(fromSessionId === undefined ? {} : { fromSessionId }),
    };
    void commandAfterLostResponse(
      client,
      commandId,
      () => client.sessionOpen(input),
    ).then(
      async (command) => {
        commandMutationPending = false;
        navigationPending = false;
        if (exitRequested) return;
        if (command.kind === 'rejected') {
          retainNotice(
            sourceSessionId,
            commandId,
            `REJECTED · session.open · ${commandReasonText(command.reason)}`,
            'REJECTED',
          );
          return;
        }
        if (!('sessionId' in command.value)) {
          retainNotice(
            sourceSessionId,
            commandId,
            `UNCONFIRMED · session.open · command result unavailable · check Core Session state before retrying`,
            'UNCONFIRMED',
          );
          return;
        }
        await switchDisplayedSession(
          command.value.sessionId,
          generation,
          sourceSessionId,
          commandId,
        );
      },
      () => {
        commandMutationPending = false;
        navigationPending = false;
        if (exitRequested) return;
        retainNotice(
          sourceSessionId,
          commandId,
          `UNCONFIRMED · session.open · response unavailable · check Core Session state before retrying`,
          'UNCONFIRMED',
        );
      },
    );
  };

  const openPickerSelection = (
    targetSessionId: string,
    action: 'view' | 'resume',
  ): void => {
    if (action === 'view') {
      viewSession(targetSessionId);
    } else if (
      targetSessionId === selectedSessionId &&
      snapshot().runtime.activeSessionId === targetSessionId
    ) {
      clearRemoteOverlay();
    } else {
      openSession({ kind: 'exact', sessionId: targetSessionId });
    }
  };

  const restoreSessionPicker = (
    picker: Extract<import('./state.ts').UiOverlay, { kind: 'sessionPicker' }>,
  ): void => {
    renderer.renderSessionPicker(
      picker.listing ?? { sessions: [], skippedInvalid: 0 },
      picker.selected,
      picker.page,
      false,
      picker.actionMode ?? 'view',
    );
    notice = undefined;
    updateStatus();
  };

  const deletePickerSelection = (
    picker: Extract<import('./state.ts').UiOverlay, { kind: 'sessionPicker' }>,
  ): void => {
    const row = picker.listing?.sessions[picker.selected];
    if (row === undefined || commandMutationPending || navigationPending) return;
    if (!core.implementedOperations.includes('session.delete')) {
      renderer.renderSessionDeleteConfirmation(
        picker,
        false,
        'Session deletion is unavailable in this Core.',
      );
      return;
    }
    const generation = ++navigationGeneration;
    const commandId = crypto.randomUUID();
    commandMutationPending = true;
    navigationPending = true;
    renderer.renderSessionDeleteConfirmation(picker, true);
    updateStatus();
    void (async () => {
      try {
        const command = await commandAfterLostResponse(
          client,
          commandId,
          () => client.sessionDelete(row.id, { commandId }),
        );
        if (exitRequested || navigationGeneration !== generation) return;
        if (command.kind === 'rejected') {
          const message = command.reason === 'busy'
            ? 'Session is open in a Core. Switch that Core to another Session, then retry.'
            : `Deletion failed: ${commandReasonText(command.reason)}.`;
          renderer.renderSessionDeleteConfirmation(picker, false, message);
          return;
        }
        if (!('deleted' in command.value) || command.value.deleted !== row.id) {
          renderer.renderSessionDeleteConfirmation(
            picker,
            false,
            'Deletion result unavailable. Reopen the Session list to check.',
          );
          return;
        }
        commandMutationPending = false;
        // A saved Session may be the current read-only view. Return its display
        // subscription to the execution Session after removing that saved history.
        if (selectedSessionId === row.id) {
          const activeId = snapshot().runtime.activeSessionId;
          if (activeId === null) throw new Error('Core has no active Session');
          await switchDisplayedSession(
            activeId,
            generation,
            row.id,
            commandId,
          );
        }
        const result = await client.sessionsList();
        if (exitRequested || navigationGeneration !== generation) return;
        const listing = listingFromSessions(result.sessions, selectedSessionId);
        const selected = Math.max(0, Math.min(picker.selected, listing.sessions.length - 1));
        restoreSessionPicker({ ...picker, listing, selected, page: Math.floor(selected / 8) });
      } catch {
        if (exitRequested || navigationGeneration !== generation) return;
        renderer.renderSessionDeleteConfirmation(
          picker,
          false,
          'Response unavailable. Reopen the Session list to check the deletion result.',
        );
      } finally {
        commandMutationPending = false;
        navigationPending = false;
        if (!exitRequested) updateStatus();
      }
    })();
  };

  const renameSession = (title: string): void => {
    const targetId = snapshot().session.id;
    if (title.trim().length === 0) {
      notice = 'usage: /rename TEXT';
      updateStatus();
      return;
    }
    if (
      hasPendingLocalCommand() || navigationPending || commandMutationPending
    ) {
      retainLocalFailure(
        targetId,
        'session.rename',
        'current command receipt is pending; check it before retrying',
      );
      return;
    }
    if (
      !targetsActiveSession() || !connected || !hasOperation('session.rename')
    ) {
      retainLocalFailure(
        targetId,
        'session.rename',
        'requires the active Session and an available operation',
      );
      return;
    }
    const commandId = crypto.randomUUID();
    commandMutationPending = true;
    notice = 'renaming Session';
    updateStatus();
    void commandAfterLostResponse(
      client,
      commandId,
      () => client.sessionRename(targetId, { commandId, title }),
    ).then(
      (command) => {
        commandMutationPending = false;
        if (exitRequested) return;
        if (command.kind === 'rejected') {
          retainNotice(
            targetId,
            commandId,
            `REJECTED · session.rename · ${commandReasonText(command.reason)}`,
            'REJECTED',
          );
        } else if (
          'result' in command.value &&
          (command.value.result === 'renamed' ||
            command.value.result === 'unchanged')
        ) {
          notice = undefined;
          updateStatus();
        } else {
          retainNotice(
            targetId,
            commandId,
            `UNCONFIRMED · session.rename · command result unavailable · check Session title before retrying`,
            'UNCONFIRMED',
          );
        }
      },
      () => {
        commandMutationPending = false;
        if (exitRequested) return;
        retainNotice(
          targetId,
          commandId,
          `UNCONFIRMED · session.rename · response unavailable · check Session title before retrying`,
          'UNCONFIRMED',
        );
      },
    );
  };

  const recallExecution = (reference: string): void => {
    const targetId = snapshot().session.id;
    const action = reference === 'clear' ? 'clear' : 'prepare';
    const executionId = action === 'prepare' && reference !== '' && reference !== 'latest'
      ? reference
      : undefined;
    const operation = action === 'clear' ? 'recall.clear' : 'recall.prepare';
    if (
      hasPendingLocalCommand() || navigationPending || commandMutationPending
    ) {
      retainLocalFailure(
        targetId,
        operation,
        'current command receipt is pending; check it before retrying',
      );
      return;
    }
    if (!connected || !hasOperation(operation)) {
      retainLocalFailure(
        targetId,
        operation,
        'unavailable for this Session; check the connection and available operations',
      );
      return;
    }
    const commandId = crypto.randomUUID();
    commandMutationPending = true;
    notice = action === 'clear' ? 'clearing pending recall' : 'preparing recall';
    updateStatus();
    void commandAfterLostResponse(
      client,
      commandId,
      () =>
        client.recall(targetId, {
          commandId,
          action,
          ...(executionId === undefined ? {} : { executionId }),
        }),
    ).then(
      (command) => {
        commandMutationPending = false;
        if (exitRequested) return;
        if (command.kind === 'rejected') {
          retainNotice(
            targetId,
            commandId,
            `REJECTED · ${operation} · ${commandReasonText(command.reason)}`,
            'REJECTED',
          );
        } else if ('action' in command.value) {
          const value = command.value as RecallValue;
          const text = value.action === 'prepare'
            ? `RECALL PREPARED · from execution #${value.sourceExecutionId} · evidence ${value.evidence}`
            : value.cleared
            ? 'RECALL CLEARED · pending recall removed'
            : 'RECALL UNCHANGED · no pending recall';
          retainNotice(targetId, commandId, text);
        } else {
          retainNotice(
            targetId,
            commandId,
            `UNCONFIRMED · ${operation} · command result unavailable · check pending recall state before retrying`,
            'UNCONFIRMED',
          );
        }
      },
      () => {
        commandMutationPending = false;
        if (exitRequested) return;
        retainNotice(
          targetId,
          commandId,
          `UNCONFIRMED · ${operation} · response unavailable · check pending recall state before retrying`,
          'UNCONFIRMED',
        );
      },
    );
  };

  const showContext = (): void => {
    const targetId = snapshot().session.id;
    if (hasPendingLocalCommand() || navigationPending) {
      retainLocalFailure(
        targetId,
        'context.read',
        'current command is pending; check it before retrying',
      );
      return;
    }
    if (!connected || !hasOperation('context.read')) {
      retainLocalFailure(
        targetId,
        'context.read',
        'unavailable for this Session; check connection and operations',
      );
      return;
    }
    const generation = ++navigationGeneration;
    const operationIdentity = `local:${crypto.randomUUID()}`;
    navigationPending = true;
    notice = 'reading context';
    updateStatus();
    void client.contextRead(targetId).then(
      (result) => {
        if (exitRequested || navigationGeneration !== generation) return;
        navigationPending = false;
        renderer.renderReadOnlyHelp(contextPanelLines({
          ...snapshot(),
          context: result.context,
        }));
        notice = undefined;
        updateStatus();
      },
      () => {
        if (exitRequested || navigationGeneration !== generation) return;
        navigationPending = false;
        retainNotice(
          targetId,
          operationIdentity,
          'FAILED · context.read · context unavailable · check Core connection and retry',
          'FAILED',
        );
      },
    );
  };

  const completeSlashCommand = (definition: SlashCommandDefinition): void => {
    const token = /^\/[^\s]*/u.exec(editor.text)?.[0] ?? '';
    const argumentsText = editor.text.slice(token.length);
    const text = definition.text +
      (argumentsText.length > 0 ? argumentsText : definition.usage === definition.text ? '' : ' ');
    slashPickerSuppressedText = text;
    renderer.clearModal();
    replaceEditorText(text);
  };

  const completeSlashCommandAtCursor = (): void => {
    const currentText = editor.text;
    if (
      !currentText.startsWith('/') ||
      editor.cursorScalar !== [...currentText].length
    ) return;
    const candidates = slashCommandCandidates(currentText);
    if (candidates.length === 1) {
      const definition = SLASH_COMMANDS.find((candidate) => candidate.text === candidates[0]);
      if (definition !== undefined) completeSlashCommand(definition);
    }
  };

  const editDraft = (event: InputEvent): void => {
    if (
      ![
        'printable',
        'paste',
        'backspace',
        'newline',
        'alt_enter',
        'left',
        'right',
        'up',
        'down',
        'home',
        'end',
      ].includes(event.kind)
    ) return;
    if (isEditorTextMutation(event)) separateSubmittedDraft();
    const before = editor.text;
    const changed = applyEditorEvent(editor, event);
    if (changed) {
      if (editor.text !== before) {
        draftRevision += 1;
        editorHistory.resetNavigation();
      }
      notice = undefined;
      renderEditor();
    } else if (
      event.kind === 'printable' || event.kind === 'paste' ||
      event.kind === 'newline' || event.kind === 'alt_enter'
    ) {
      notice = event.kind === 'paste' ? 'paste exceeds 64 KiB' : 'input too long';
      updateStatus();
    }
  };

  const shutdownCore = (): void => {
    if (shutdownPending || exitRequested) return;
    const targetSessionId = snapshot().session.id;
    const commandId = crypto.randomUUID();
    shutdownPending = true;
    renderer.setSlashCommandCandidates([]);
    catalogUi.close();
    clearRemoteOverlay();
    notice = undefined;
    updateStatus();
    void (async () => {
      try {
        const command = await client.coreShutdown({
          commandId,
        });
        if (exitRequested) return;
        if (command.kind === 'rejected') {
          retainNotice(
            targetSessionId,
            commandId,
            `REJECTED · core.shutdown · ${commandReasonText(command.reason)}`,
            'REJECTED',
          );
        } else {
          await client.waitUntilCoreStopped(core.coreEpoch, exitAbort.signal);
          requestExit();
          return;
        }
      } catch (error) {
        if (exitRequested) return;
        retainNotice(
          targetSessionId,
          commandId,
          error instanceof HenjiApiError
            ? `FAILED · core.shutdown · ${error.message}`
            : 'UNCONFIRMED · core.shutdown · check Core with henji core status',
          error instanceof HenjiApiError ? 'FAILED' : 'UNCONFIRMED',
        );
      }
      shutdownPending = false;
      renderEditor();
      updateStatus();
    })();
  };

  const runSlashCommand = (input: string): boolean => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return false;
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
    const name = match?.[1] ?? '';
    const argument = match?.[2]?.trim() ?? '';
    const known = new Set<string>(
      SLASH_COMMANDS.map((definition) => definition.command),
    );
    if (!known.has(name)) {
      notice = 'unknown command /' + name +
        ' · try /sessions, /view, /resume, /new, /context';
      updateStatus();
      return true;
    }
    replaceEditorText('');
    notice = undefined;
    if (name === 'detach') requestExit();
    else if (name === 'quit') {
      if (argument.length > 0) {
        notice = 'usage: /quit';
        updateStatus();
      } else shutdownCore();
    } else if (name === 'help') renderer.renderReadOnlyHelp(helpLines());
    else if (name === 'sessions') showSessionPicker();
    else if (name === 'view') {
      if (argument.length === 0) {
        notice = 'usage: /view ID';
        updateStatus();
      } else viewSession(argument);
    } else if (name === 'resume') {
      if (argument.length === 0 || argument === 'latest') {
        openSession({ kind: 'continue' });
      } else openSession({ kind: 'exact', sessionId: argument });
    } else if (name === 'new') {
      openSession({ kind: 'new' }, selectedSessionId);
    } else if (name === 'rename') renameSession(argument);
    else if (name === 'recall') recallExecution(argument);
    else if (
      name === 'provider' || name === 'model' || name === 'effort' ||
      name === 'login'
    ) {
      if (argument.length > 0) {
        notice = `usage: /${name}`;
        updateStatus();
      } else if (name === 'provider') void catalogUi.openProviders();
      else if (name === 'model') void catalogUi.openModels();
      else if (name === 'effort') void catalogUi.openEfforts();
      else void catalogUi.openLogin();
    } else showContext();
    return true;
  };

  const reopenFromSnapshot = async (): Promise<FrameWaitResult> => {
    const generation = ++subscriptionGeneration;
    subscriptionAbort.abort();
    try {
      const closing = iterator.return?.(undefined);
      if (closing !== undefined) void closing.catch(() => {});
    } catch {
      // The aborted generator will run its cleanup as the new snapshot is opened.
    }
    subscriptionAbort = new AbortController();
    iterator = client.sessionSubscribe(selectedSessionId, {
      signal: subscriptionAbort.signal,
    })[Symbol.asyncIterator]();
    try {
      const next = await iterator.next();
      if (
        next.done || next.value.kind !== 'session.snapshot' ||
        next.value.snapshot.session.id !== selectedSessionId
      ) throw new Error('Session snapshot unavailable');
      return { kind: 'resync', frame: next.value, generation };
    } catch {
      return { kind: 'stream_error', generation };
    }
  };

  lifecycle.addSignals({
    SIGINT: requestExit,
    SIGTERM: requestExit,
    SIGHUP: requestExit,
  });
  const removeResize = lifecycle.subscribeResize((size) =>
    renderer.resize(size.columns, size.rows)
  );
  const removeOutputFailure = lifecycle.subscribeOutputFailure(requestExit);
  let result = 0;
  let acquired = false;
  let renderFailed = false;
  const removeRenderFailure = renderer.subscribeRenderFailure(() => {
    renderFailed = true;
    result = 1;
    requestExit();
  });
  try {
    await lifecycle.acquire();
    acquired = true;
    renderSnapshot(
      renderer,
      state!,
      core.workspace,
      false,
      conversationProjector,
      systemNotices,
      cancellationRequested ? cancellationExecutionId : undefined,
    );
    updateStatus();
    await dependencies.afterAcquire?.();

    const inputReader = new RemoteInputReader(lifecycle, decoder);
    const waitForInput = (): void => {
      void inputReader.next().then(
        (input) => events.push({ kind: 'input', events: input }),
        (error) => events.push({ kind: 'input_error', error }),
      );
    };
    waitForInput();
    waitForFrame(nextFrameWait());

    while (!exitRequested) {
      const ready = await events.next();
      if (ready.kind === 'exit') break;
      if (ready.kind === 'input_error') throw ready.error;
      if (ready.kind === 'input') {
        if (ready.events === null) {
          requestExit();
          break;
        }
        waitForInput();
        for (const event of ready.events) {
          if (event.kind === 'ctrl_d') {
            requestExit();
            break;
          }
          if (event.kind === 'ctrl_q') {
            shutdownCore();
            continue;
          }
          if (shutdownPending) continue;
          const overlay = renderer.stateSnapshot().overlay;
          if (catalogUi.isOpen || overlay.kind === 'choicePicker') {
            catalogUi.process(event);
            continue;
          }
          if (overlay.kind === 'slashPicker') {
            if (event.kind === 'escape') {
              slashPickerSuppressedText = editor.text;
              clearRemoteOverlay();
            } else if (event.kind === 'up' || event.kind === 'down') {
              const selected = Math.max(
                0,
                Math.min(
                  overlay.candidates.length - 1,
                  overlay.selected + (event.kind === 'up' ? -1 : 1),
                ),
              );
              renderer.renderSlashPicker(overlay.candidates, selected);
            } else if (event.kind === 'enter' || event.kind === 'tab') {
              const selected = overlay.candidates[overlay.selected];
              if (selected !== undefined) completeSlashCommand(selected);
            } else editDraft(event);
            continue;
          }
          if (overlay.kind === 'readOnlyHelp') {
            if (event.kind === 'escape') clearRemoteOverlay();
            else if (event.kind === 'page_up' || event.kind === 'page_down') {
              renderer.scrollHelp(event.kind === 'page_up' ? 'up' : 'down');
            }
            continue;
          }
          if (overlay.kind === 'sessionDeleteConfirm') {
            if (overlay.deleting) continue;
            if (
              event.kind === 'escape' || event.kind === 'printable' && /^[nN]$/u.test(event.text)
            ) {
              restoreSessionPicker(overlay.picker);
            } else if (event.kind === 'printable' && /^[yY]$/u.test(event.text)) {
              deletePickerSelection(overlay.picker);
            }
            continue;
          }
          if (overlay.kind === 'sessionPicker') {
            if (event.kind === 'escape') {
              clearRemoteOverlay();
            } else if (overlay.loading) {
              continue;
            } else if (event.kind === 'printable' && /^[dD]$/u.test(event.text)) {
              if (overlay.listing?.sessions[overlay.selected] !== undefined) {
                renderer.renderSessionDeleteConfirmation(overlay);
                updateStatus();
              }
            } else if (
              overlay.listing !== undefined &&
              (event.kind === 'up' || event.kind === 'down' ||
                event.kind === 'left' || event.kind === 'right')
            ) {
              const moved = movePresentationPickerSelection(
                overlay.listing.sessions.length,
                overlay.selected,
                overlay.page,
                event.kind,
              );
              renderer.renderSessionPicker(
                overlay.listing,
                moved.selected,
                moved.page,
                overlay.loading ?? false,
                overlay.actionMode ?? 'view',
              );
            } else if (
              event.kind === 'enter' || (
                event.kind === 'printable' && /^[rR]$/u.test(event.text)
              )
            ) {
              const row = overlay.listing?.sessions[overlay.selected];
              if (row !== undefined) {
                openPickerSelection(
                  row.id,
                  event.kind === 'enter' ? overlay.actionMode ?? 'view' : 'resume',
                );
              }
            }
            continue;
          }
          if (overlay.kind !== 'none') {
            if (event.kind === 'escape') clearRemoteOverlay();
            continue;
          }
          if (
            !editorBusy() && (event.kind === 'up' || event.kind === 'down') &&
            walkInputHistory(event.kind)
          ) continue;
          if (event.kind === 'ctrl_c') {
            separateSubmittedDraft();
            if (editor.text.length > 0) replaceEditorText('');
            notice = undefined;
            updateStatus();
            continue;
          }
          if (event.kind === 'page_up') {
            renderer.scrollPage('up');
          } else if (event.kind === 'page_down') {
            renderer.scrollPage('down');
          } else if (event.kind === 'escape') {
            if (renderer.stateSnapshot().scroll.kind !== 'followLatest') {
              renderer.latest();
            } else if (activeExecutionId() !== undefined) {
              if (!cancellationRequested) cancelActiveExecution();
            } else {
              renderer.clearModal();
              renderer.latest();
            }
          } else if (event.kind === 'f1') {
            showSessionPicker();
          } else if (event.kind === 'enter') {
            const command = editor.text.trim();
            if (command === '/detach') {
              requestExit();
              break;
            }
            if (runSlashCommand(command)) continue;
            if (activeExecution() === undefined) {
              notice = undefined;
              submitDraft('task');
            }
          } else if (event.kind === 'tab') {
            completeSlashCommandAtCursor();
          } else if (event.kind === 'f2') {
            notice = undefined;
            submitDraft('follow-up');
          } else if (event.kind === 'f3') {
            notice = undefined;
            submitDraft('steering');
          } else if (event.kind === 'paste_rejected') {
            notice = 'paste exceeds 64 KiB';
            updateStatus();
          } else editDraft(event);
        }
        if (!exitRequested) updateStatus();
        continue;
      }

      if (ready.generation !== subscriptionGeneration) continue;

      if (
        ready.kind === 'stream_error' ||
        (ready.kind === 'frame' && ready.result.done)
      ) {
        connected = false;
        noteConnectionLoss();
        updateStatus();
        continue;
      }

      if (ready.kind === 'resync') {
        state = reduceSessionStreamFrame(undefined, ready.frame);
        selectedModel = snapshot().session.selection;
        unconfirmedSubmissions.delete(snapshot().session.id);
        connected = true;
        connectionLossReported = false;
        syncCoreObservations();
        renderSnapshot(
          renderer,
          state!,
          core.workspace,
          true,
          conversationProjector,
          systemNotices,
          cancellationRequested ? cancellationExecutionId : undefined,
        );
        updateStatus();
        waitForFrame(nextFrameWait());
        continue;
      }

      const frame = ready.result.value;
      try {
        state = reduceSessionStreamFrame(state, frame);
      } catch (error) {
        if (error instanceof Error && error.message.includes('revision gap')) {
          connected = false;
          noteConnectionLoss();
          updateStatus();
          waitForFrame(reopenFromSnapshot());
          continue;
        }
        throw error;
      }
      selectedModel = snapshot().session.selection;
      syncCoreObservations();
      renderSnapshot(
        renderer,
        state!,
        core.workspace,
        true,
        conversationProjector,
        systemNotices,
        cancellationRequested ? cancellationExecutionId : undefined,
      );
      updateStatus();
      waitForFrame(nextFrameWait());
    }
    if (renderFailed) await stderr(dependencies, 'terminal failure\n');
  } catch {
    result = 1;
    await stderr(
      dependencies,
      `${acquired ? 'terminal failure' : 'Session connection failed'}\n`,
    );
  } finally {
    requestExit();
    events.close();
    catalogUi.close();
    removeResize();
    removeOutputFailure();
    removeRenderFailure();
    try {
      if (iterator.return !== undefined) await iterator.return(undefined);
    } catch {
      // An aborted SSE reader is already detached; terminal restoration still follows.
    }
    await lifecycle.restore();
    if (lifecycle.restoreStatus() === 'failed') result = 1;
  }
  return result;
};
