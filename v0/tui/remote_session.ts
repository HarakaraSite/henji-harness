import type {
  PresentationLifecycle,
  PresentationNavigationListing,
  PresentationProjection,
} from '../presentation/contract.ts';
import { HenjiApiClient } from '../api/client.ts';
import type {
  ApiSelection,
  CommandResult,
  CommandState,
  ContextView,
  CoreCommandValue,
  CoreCursor,
  CoreOperationName,
  CredentialPresenceReadResult,
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
import { TuiRenderer } from './render.ts';
import { RemoteCatalogUi } from './remote_catalog_ui.ts';
import { slashCommandCandidates } from './slash_command.ts';
import { DenoTerminal, TerminalLifecycle, type TerminalPort } from './terminal.ts';
import {
  presentationPositionFromSnapshot,
  presentationStartupFromSnapshot,
  type SnapshotConversationProjectionHint,
  SnapshotConversationProjector,
  snapshotThinkingIdentity,
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

export interface RemoteTuiLaunchOptions {
  readonly target: RemoteTuiLaunchTarget;
  readonly activation?: SessionActivation;
}

type SubmitKind = 'task' | 'steering' | 'follow-up';

interface PendingSubmission {
  readonly kind: SubmitKind;
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

interface RemoteNavigationListing {
  readonly listing: PresentationNavigationListing;
  readonly selected: number;
  readonly page: number;
}

const startupUnevaluated = (snapshot: SessionSnapshot): boolean =>
  snapshot.session.startup.status === 'unevaluated';

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

const effectiveDefinitionSelector = (snapshot: SessionSnapshot): {
  readonly agent?: string;
  readonly revision?: string;
} => {
  const config = snapshot.runtime.effectiveConfig;
  const definition = record(config?.definition);
  const resourceId = typeof definition?.resourceId === 'string' ? definition.resourceId : undefined;
  const revisionRef = record(definition?.revision);
  const digest = revisionRef?.algorithm === 'sha256' &&
      typeof revisionRef.digest === 'string'
    ? revisionRef.digest
    : undefined;
  const agent = resourceId?.startsWith('builtin/')
    ? resourceId.slice('builtin/'.length)
    : resourceId;
  const revision = resourceId === undefined || digest === undefined
    ? undefined
    : `${resourceId}@sha256:${digest}`;
  return {
    ...(agent === undefined ? {} : { agent }),
    ...(revision === undefined ? {} : { revision }),
  };
};

const activationDifferences = (
  snapshot: SessionSnapshot,
  requested: SessionActivation,
): readonly string[] => {
  const config = snapshot.runtime.effectiveConfig;
  const selector = effectiveDefinitionSelector(snapshot);
  const differences: string[] = [];
  if (requested.agent !== undefined && requested.agent !== selector.agent) {
    differences.push(
      '--agent requested ' + requested.agent + ', active ' +
        (selector.agent ?? 'not reported'),
    );
  }
  if (requested.definitionRevision !== undefined) {
    const active = selector.revision ?? 'not reported';
    if (requested.definitionRevision !== selector.revision) {
      differences.push(
        '--definition-revision requested ' + requested.definitionRevision +
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
  if (!('snapshot' in command.value)) {
    await stderr(
      dependencies,
      'session open unconfirmed · command #' + commandId + '\n',
    );
    return undefined;
  }
  return {
    sessionId: command.value.snapshot.session.id,
    snapshot: command.value.snapshot,
  };
};

const presentationLifecycle = (
  snapshot: SessionSnapshot,
): PresentationLifecycle => {
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

const projectionFromSnapshot = (
  snapshot: SessionSnapshot,
  workspace: string,
): PresentationProjection => ({
  lifecycle: presentationLifecycle(snapshot),
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
  const selector = effectiveDefinitionSelector(snapshot);
  return [
    'active Session configuration:',
    'definition ' + (selector.revision ?? selector.agent ?? 'not reported'),
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

const isConversationChange = (frame: SessionStreamFrame): boolean =>
  frame.kind === 'session.snapshot' ||
  frame.changes.some((change) =>
    change.kind.startsWith('message.') || change.kind.startsWith('tool.') ||
    change.kind.startsWith('thinking.') || change.kind.startsWith('request.') ||
    change.kind === 'conversation.omitted.replace' ||
    change.kind === 'pending.replace' || change.kind === 'runtime.replace'
  );

const renderSessionOrientation = (
  renderer: TuiRenderer,
  snapshot: SessionSnapshot,
  workspace: string,
): void => {
  const position = presentationPositionFromSnapshot(snapshot);
  renderer.setCurrentPosition(position);
  const execution = snapshot.runtime.execution;
  renderer.setProjection(
    projectionFromSnapshot(snapshot, workspace),
    snapshot.runtime.active && execution !== null ? Date.parse(execution.createdAt) : undefined,
  );
  renderer.renderCompactStartup(presentationStartupFromSnapshot(snapshot, workspace), position);
};

interface PendingConversationProjection {
  scope?: string;
  readonly messageIds: Set<string>;
  readonly toolOccurrenceIds: Set<string>;
  readonly thinkingIds: Set<string>;
  resetScroll: boolean;
  resync: boolean;
}

const mergeProjectionWork = (
  pending: PendingConversationProjection,
  scope: string,
  hint: SnapshotConversationProjectionHint,
  resetScroll: boolean,
): void => {
  if (pending.scope !== scope) {
    pending.scope = scope;
    pending.messageIds.clear();
    pending.toolOccurrenceIds.clear();
    pending.thinkingIds.clear();
    pending.resetScroll = false;
    pending.resync = false;
  }
  for (const id of hint.messageIds ?? []) pending.messageIds.add(id);
  for (const id of hint.toolOccurrenceIds ?? []) pending.toolOccurrenceIds.add(id);
  for (const id of hint.thinkingIds ?? []) pending.thinkingIds.add(id);
  pending.resetScroll ||= resetScroll;
  pending.resync ||= hint.resync === true;
};

const takeProjectionWork = (
  pending: PendingConversationProjection,
): Readonly<{ hint: SnapshotConversationProjectionHint; resetScroll: boolean }> => {
  const hint: SnapshotConversationProjectionHint = Object.freeze({
    ...(pending.messageIds.size === 0 ? {} : { messageIds: [...pending.messageIds] }),
    ...(pending.toolOccurrenceIds.size === 0
      ? {}
      : { toolOccurrenceIds: [...pending.toolOccurrenceIds] }),
    ...(pending.thinkingIds.size === 0 ? {} : { thinkingIds: [...pending.thinkingIds] }),
    ...(pending.resync ? { resync: true } : {}),
  });
  const resetScroll = pending.resetScroll;
  pending.messageIds.clear();
  pending.toolOccurrenceIds.clear();
  pending.thinkingIds.clear();
  pending.resetScroll = false;
  pending.resync = false;
  return Object.freeze({ hint, resetScroll });
};

const projectionHintFromFrame = (
  frame: SessionStreamFrame,
): SnapshotConversationProjectionHint => {
  if (frame.kind === 'session.snapshot') return Object.freeze({ resync: true });
  const messageIds: string[] = [];
  const toolOccurrenceIds: string[] = [];
  const thinkingIds: string[] = [];
  for (const change of frame.changes) {
    switch (change.kind) {
      case 'message.upsert':
        messageIds.push(change.message.id);
        break;
      case 'message.remove':
        messageIds.push(change.id);
        break;
      case 'tool.upsert':
        toolOccurrenceIds.push(change.tool.toolOccurrenceId);
        break;
      case 'tool.remove':
        toolOccurrenceIds.push(change.toolOccurrenceId);
        break;
      case 'thinking.upsert':
        thinkingIds.push(
          snapshotThinkingIdentity(change.thinking.requestKey, change.thinking.thinkingKind),
        );
        break;
      case 'thinking.remove':
        thinkingIds.push(snapshotThinkingIdentity(change.requestKey, change.thinkingKind));
        break;
    }
  }
  return Object.freeze({
    ...(messageIds.length === 0 ? {} : { messageIds }),
    ...(toolOccurrenceIds.length === 0 ? {} : { toolOccurrenceIds }),
    ...(thinkingIds.length === 0 ? {} : { thinkingIds }),
  });
};

const renderSnapshot = (
  renderer: TuiRenderer,
  snapshot: SessionSnapshot,
  workspace: string,
  preserveScroll: boolean,
  projector: SnapshotConversationProjector,
  pending: PendingConversationProjection,
  hint: SnapshotConversationProjectionHint,
): void => {
  if (!preserveScroll) {
    renderer.clearModal();
    renderer.latest();
  }
  renderSessionOrientation(renderer, snapshot, workspace);
  const scope = JSON.stringify([snapshot.cursor.coreEpoch, snapshot.session.id]);
  renderer.setDisplayScope(scope);
  mergeProjectionWork(pending, scope, hint, !preserveScroll);
  renderer.updateConversation(() => {
    const work = takeProjectionWork(pending);
    const projected = projector.project(snapshot, scope, work.hint);
    renderer.setConversationEntries(projected.entries, projected.omitted, work.resetScroll);
    const records = [
      ...(snapshot.pending.followUp === undefined ? [] : [snapshot.pending.followUp]),
      ...snapshot.pending.followUps,
    ];
    for (const [index, record] of records.entries()) {
      const execution = snapshot.runtime.execution?.executionId === record.executionId
        ? snapshot.runtime.execution
        : undefined;
      const result = execution?.lifecycle === 'settled'
        ? ` · ${execution.outcome} · ${execution.adoption} · settlement ${execution.processSettlement}`
        : '';
      renderer.eventSink({
        kind: 'notice',
        generation: index,
        text: `follow-up ${record.status} #${record.queueId}${
          record.executionId === undefined
            ? ` · after #${record.afterExecutionId}`
            : ` → execution #${record.executionId}`
        }${record.reason === undefined ? '' : ` · ${record.reason}`}${result}\n${record.text}`,
      });
    }
    if (snapshot.pending.steering !== undefined) {
      renderer.eventSink({
        kind: 'notice',
        generation: records.length,
        text:
          `steering accepted · execution #${snapshot.pending.steering.executionId}\n${snapshot.pending.steering.text}`,
      });
    }
  });
};

const isEditorTextMutation = (event: InputEvent): boolean =>
  event.kind === 'printable' || event.kind === 'paste' ||
  event.kind === 'backspace' ||
  event.kind === 'newline' || event.kind === 'alt_enter' ||
  event.kind === 'ctrl_w' ||
  event.kind === 'ctrl_u' || event.kind === 'ctrl_k' || event.kind === 'alt_d';

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
    case 'ctrl_w':
      return editor.deleteWordBackward();
    case 'ctrl_a':
    case 'home':
      return editor.home();
    case 'ctrl_e':
    case 'end':
      return editor.end();
    case 'ctrl_b':
    case 'left':
      return editor.moveLeft();
    case 'ctrl_f':
    case 'right':
      return editor.moveRight();
    case 'up':
      return editor.moveUp();
    case 'down':
      return editor.moveDown();
    case 'ctrl_u':
      return editor.deleteToLineStart();
    case 'ctrl_k':
      return editor.deleteToLineEnd();
    case 'alt_b':
      return editor.moveWordLeft();
    case 'alt_f':
      return editor.moveWordRight();
    case 'alt_d':
      return editor.deleteWordForward();
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
  let credentialPresence: CredentialPresenceReadResult | undefined;
  const renderer = new TuiRenderer(terminal);
  const conversationProjector = new SnapshotConversationProjector();
  const pendingConversationProjection: PendingConversationProjection = {
    messageIds: new Set(),
    toolOccurrenceIds: new Set(),
    thinkingIds: new Set(),
    resetScroll: false,
    resync: false,
  };
  const editor = new TuiEditor();
  const editorHistory = new TuiEditorHistory();
  const lifecycle = new TerminalLifecycle(terminal, renderer);
  const decoder = new InputDecoder();
  let draftRevision = 0;
  let connected = true;
  let exitRequested = false;
  let pendingSubmission: PendingSubmission | undefined;
  let acceptedSubmission: AcceptedSubmission | undefined;
  let pendingCancellation: PendingCancellation | undefined;
  let cancellationRequested = false;
  let cancellationExecutionId: string | undefined;
  let notice: string | undefined;
  let commandPoll: ReturnType<typeof setTimeout> | undefined;
  let navigationPending = false;
  let commandMutationPending = false;
  let navigationGeneration = 0;
  let subscriptionGeneration = 0;
  let frameWait: Promise<FrameWaitResult> | null = null;
  let exitResolve!: () => void;
  const exitWait = new Promise<void>((resolve) => exitResolve = resolve);

  const requestExit = (): void => {
    if (exitRequested) return;
    exitRequested = true;
    subscriptionAbort.abort();
    if (commandPoll !== undefined) clearTimeout(commandPoll);
    commandPoll = undefined;
    exitResolve();
  };

  const snapshot = (): SessionSnapshot => state!.snapshot;
  const nextFrameWait = (): Promise<FrameWaitResult> => {
    const generation = subscriptionGeneration;
    return iterator.next().then(
      (next) => ({ kind: 'frame' as const, result: next, generation }),
      () => ({ kind: 'stream_error' as const, generation }),
    );
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
  const canSubmit = (): boolean =>
    connected && targetsActiveSession() && hasOperation('task.submit');
  const canCancel = (): boolean =>
    connected && activeExecution() !== undefined &&
    hasOperation('execution.cancel');

  const credentialStatusHint = (): string | undefined => {
    const current = snapshot();
    if (
      targetsActiveSession() &&
      current.session.selection.provider === selectedModel.provider
    ) {
      const status = current.credentialAvailability.status;
      return status === 'unknown' ? undefined : `credential ${status}: ${selectedModel.provider}`;
    }
    const profile = credentialPresence?.profiles.find((entry) =>
      entry.providers.includes(selectedModel.provider)
    );
    return profile === undefined || profile.status === 'unknown'
      ? undefined
      : `credential ${profile.status}: ${selectedModel.provider}`;
  };

  const statusText = (): string => {
    const current = snapshot();
    if (!connected) {
      return `DISCONNECTED · last phase ${current.runtime.phase} · Ctrl-D detach`;
    }
    if (pendingCancellation !== undefined) {
      return `cancelling · ${
        pendingCancellation.processing ? 'processing' : 'requesting'
      } · Ctrl-C clear · Ctrl-D detach`;
    }
    if (pendingSubmission !== undefined) {
      return `${
        pendingSubmission.kind === 'task'
          ? 'submitting'
          : pendingSubmission.kind === 'steering'
          ? 'steering'
          : 'queueing follow-up'
      } · ${pendingSubmission.processing ? 'processing' : 'awaiting receipt'} · Ctrl-D detach`;
    }
    if (acceptedSubmission !== undefined) {
      return `submitting · accepted, syncing snapshot · Ctrl-D detach`;
    }
    if (current.runtime.phase === 'preparing') {
      return 'preparing · task admission in progress · Ctrl-D detach';
    }
    const execution = activeExecution();
    if (execution !== undefined) {
      const primary = current.runtime.phase === 'cancelling' ? 'cancelling' : 'busy';
      const cancelHint = current.runtime.phase === 'cancelling' || cancellationRequested
        ? 'Ctrl-C clear'
        : canCancel()
        ? 'Esc cancel · Ctrl-C clear'
        : 'cancellation unavailable';
      const inputHint = hasOperation('execution.steer') && hasOperation('followUp.queue')
        ? 'Enter steer · Alt-Enter queue'
        : hasOperation('execution.steer')
        ? 'Enter steer'
        : hasOperation('followUp.queue')
        ? 'Alt-Enter queue'
        : '';
      return `${primary}${
        inputHint.length === 0 ? '' : ` · ${inputHint}`
      } · ${cancelHint} · Ctrl-D detach`;
    }
    const settledExecution = current.runtime.execution;
    if (
      settledExecution?.sessionId === current.session.id &&
      settledExecution.lifecycle === 'settled'
    ) {
      const adoption = settledExecution.adoption === 'non_canonical'
        ? 'non-canonical'
        : settledExecution.adoption;
      const controls = canSubmit() ? 'Enter submit · Ctrl-D detach' : 'Ctrl-D detach';
      return `${settledExecution.outcome} · ${adoption} · settlement ${settledExecution.processSettlement} · ${controls}`;
    }
    if (canSubmit()) {
      return 'ready · Enter submit · Ctrl-C clear · Ctrl-D detach';
    }
    return 'READ-ONLY · /exit detach · Ctrl-D detach · F1 help';
  };

  const updateStatus = (): void => {
    if (
      activeExecution() === undefined &&
      (notice?.startsWith('submission unconfirmed') ||
        notice?.startsWith('submission rejected:'))
    ) {
      const summary = notice.split(' · ')[0];
      const hint = credentialStatusHint();
      renderer.setStatus(
        `${summary} · draft kept · Ctrl-D detach${hint === undefined ? '' : ` · ${hint}`}`,
      );
      return;
    }
    const rawStatus = statusText();
    const phase = snapshot().runtime.phase === 'cancelling' ||
        pendingCancellation !== undefined || cancellationRequested
      ? 'cancelling'
      : 'busy';
    const status = connected && activeExecution() !== undefined && !rawStatus.startsWith(phase)
      ? `${phase} · ${rawStatus}`
      : rawStatus;
    const hint = credentialStatusHint();
    if (notice === undefined) {
      renderer.setStatus(hint === undefined ? status : `${status} · ${hint}`);
      return;
    }
    const parts = status.split(' · ');
    const primary = parts[0] ?? '';
    const compactPhase = primary.startsWith('ready') ? 'idle' : primary;
    const controls = new Set([
      'Enter submit',
      'Enter steer',
      'Alt-Enter queue',
      'Ctrl-C clear',
      'Ctrl-D detach',
      'Esc cancel',
      'cancellation unavailable',
      '/exit detach',
      'F1 help',
    ]);
    const tail = parts.slice(1).filter((part) => controls.has(part));
    renderer.setStatus([
      ...(activeExecution() === undefined
        ? [notice, ...(compactPhase.length === 0 ? [] : [compactPhase])]
        : [...(compactPhase.length === 0 ? [] : [compactPhase]), notice]),
      ...tail,
      ...(hint === undefined ? [] : [hint]),
    ].join(' · '));
  };

  const editorBusy = (): boolean =>
    pendingSubmission !== undefined || acceptedSubmission !== undefined ||
    pendingCancellation !== undefined ||
    (targetsActiveSession() && snapshot().runtime.active);

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
      renderer.setEditorSnapshot(editor.snapshot());
      updateStatus();
      return true;
    }
    if (
      !editorHistory.navigating && editor.text.length > 0 && editor.moveUp()
    ) {
      notice = undefined;
      renderer.setEditorSnapshot(editor.snapshot());
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
    renderer.setEditorSnapshot(editor.snapshot());
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
    credentialPresenceRead: (result) => {
      credentialPresence = result;
      updateStatus();
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
    renderer.setEditorSnapshot(editor.snapshot());
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
      current.pending.steering?.commandId === receipt.commandId ||
      current.pending.followUp?.commandId === receipt.commandId ||
      current.pending.followUps.some((record) => record.commandId === receipt.commandId);
  };

  const syncCoreObservations = (): void => {
    if (
      acceptedSubmission !== undefined && receiptIsObserved(acceptedSubmission)
    ) {
      notice = 'accepted';
      acceptedSubmission = undefined;
    }
    const current = snapshot();
    const execution = activeExecution();
    if (current.runtime.phase === 'cancelling' && execution !== undefined) {
      cancellationRequested = true;
      cancellationExecutionId = execution.executionId;
    } else if (
      !current.runtime.active ||
      execution?.executionId !== cancellationExecutionId
    ) {
      cancellationRequested = false;
      cancellationExecutionId = undefined;
    }
  };
  syncCoreObservations();

  const rejectedText = (reason: string): string =>
    reason.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);

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
      notice = `submission rejected: ${rejectedText(command.reason)}`;
      updateStatus();
      return;
    }
    if (
      submission.kind === 'follow-up'
        ? !('queueId' in command.value)
        : !('executionId' in command.value) || 'result' in command.value
    ) {
      pendingSubmission = undefined;
      finishDraft(submission, false);
      notice = 'submission unconfirmed · draft kept';
      updateStatus();
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
    notice = receiptIsObserved(accepted) ? 'accepted' : 'accepted · waiting for core snapshot';
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
      notice = 'submission unconfirmed · draft kept; check the core before resubmitting';
      updateStatus();
    }
  }

  const submitDraft = (
    kind: SubmitKind = activeExecution() === undefined ? 'task' : 'steering',
  ): void => {
    if (navigationPending || commandMutationPending) {
      notice = 'Session operation still pending';
      updateStatus();
      return;
    }
    if (pendingSubmission !== undefined || acceptedSubmission !== undefined) {
      notice = 'submission still awaiting core state';
      updateStatus();
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
      notice = `${
        kind === 'task' ? 'task.submit' : kind === 'steering' ? 'execution.steer' : 'followUp.queue'
      } unavailable for this Session`;
      updateStatus();
      return;
    }
    const submission: PendingSubmission = {
      kind,
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
      ? client.taskSubmit(snapshot().session.id, input)
      : kind === 'steering'
      ? client.steeringSubmit(
        snapshot().session.id,
        submission.executionId!,
        input,
      )
      : client.followUpQueue(snapshot().session.id, {
        ...input,
        afterExecutionId: submission.executionId!,
      });
    void operation.then(
      (command) => finalizeTaskCommand(command, submission),
      async () => {
        if (exitRequested || pendingSubmission !== submission) return;
        submission.processing = true;
        notice = 'submit response unknown · checking command';
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
      notice = `cancel rejected: ${rejectedText(command.reason)}`;
      updateStatus();
      return;
    }
    if (!('result' in command.value)) {
      notice = 'cancel unconfirmed';
      updateStatus();
      return;
    }
    cancellationRequested = command.value.result !== 'idle';
    cancellationExecutionId = cancellationRequested ? cancellation.executionId : undefined;
    notice = `cancel ${command.value.result.replaceAll('_', ' ')}`;
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
      notice = 'cancel unconfirmed';
      updateStatus();
    }
  }

  const cancelActiveExecution = (): void => {
    if (pendingCancellation !== undefined) return;
    if (pendingSubmission !== undefined || acceptedSubmission !== undefined) {
      notice = 'submission admission is still pending';
      updateStatus();
      return;
    }
    if (!canCancel()) {
      notice = 'execution.cancel unavailable for this Session';
      updateStatus();
      return;
    }
    const execution = activeExecution()!;
    const cancellation: PendingCancellation = {
      commandId: crypto.randomUUID(),
      executionId: execution.executionId,
      processing: false,
    };
    pendingCancellation = cancellation;
    cancellationRequested = true;
    cancellationExecutionId = execution.executionId;
    notice = undefined;
    updateStatus();
    void client.executionCancel(snapshot().session.id, execution.executionId, {
      commandId: cancellation.commandId,
    }).then(
      (command) => finalizeCancelCommand(command, cancellation),
      async () => {
        if (exitRequested || pendingCancellation !== cancellation) return;
        cancellation.processing = true;
        notice = 'cancel response unknown · checking command';
        updateStatus();
        await readCancelCommand(cancellation);
      },
    );
  };

  const helpLines = (): readonly string[] => {
    const current = snapshot();
    const operationHint = targetsActiveSession() && hasOperation('task.submit')
      ? 'Enter submits the current draft to this active Session.'
      : 'Task submission is unavailable for this viewed Session state.';
    const cancelHint = canCancel()
      ? 'Escape sends execution.cancel to the displayed execution.'
      : 'Execution cancellation is available only when runtime.operations includes execution.cancel.';
    return [
      operationHint,
      'Ctrl-G / Ctrl-T or /sessions opens the Session picker; Enter views, R resumes.',
      'PageUp / PageDown scroll; Tab completes Core workspace paths; Escape returns latest; F1 toggles help.' +
      (startupUnevaluated(current) ? ' Worker startup not evaluated.' : ''),
      'Ctrl-C clears the draft even while busy.',
      'Detaching leaves accepted core work running. Reconnect: henji --core ID (or --connect URL).',
      '/view ID views without replacing the active slot; /resume [ID] explicitly resumes.',
      '/new creates from this view and the core-owned active activation.',
      '/rename TEXT renames; /recall [ID|latest|clear] prepares or clears next-task recall.',
      '/context reads checkpoint, recall, and activation config; /provider, /model, /effort use Core catalogs; /login opens masked key entry.',
      'Busy Enter steers this task; Alt-Enter queues the next task after success.',
      cancelHint,
      'Cancellation/failure keeps follow-up text and the stopping reason for your next decision.',
    ];
  };

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
  ): Promise<boolean> => {
    if (hasPendingLocalCommand()) {
      notice = 'wait for the current command receipt before changing the viewed Session';
      updateStatus();
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
        notice = 'Session subscription failed; current view unchanged';
        updateStatus();
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
      notice = 'Session snapshot unavailable; current view unchanged';
      updateStatus();
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
    credentialPresence = undefined;
    connected = true;
    navigationPending = false;
    renderer.clearModal();
    syncCoreObservations();
    renderSnapshot(
      renderer,
      snapshot(),
      core.workspace,
      false,
      conversationProjector,
      pendingConversationProjection,
      projectionHintFromFrame(first.value),
    );
    renderer.setEditorSnapshot(editor.snapshot());
    notice = undefined;
    updateStatus();
    frameWait = nextFrameWait();
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
    if (hasPendingLocalCommand() || navigationPending) {
      notice = 'wait for the current command before opening the Session picker';
      updateStatus();
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
    notice = 'loading Sessions';
    updateStatus();
    void client.sessionsList().then(
      (result) => {
        if (
          exitRequested || navigationGeneration !== generation ||
          renderer.stateSnapshot().overlay.kind !== 'sessionPicker'
        ) return;
        navigationPending = false;
        renderer.renderSessionPicker(
          listingFromSessions(result.sessions, selectedSessionId),
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
        notice = 'Session list unavailable';
        updateStatus();
      },
    );
  };

  const viewSession = (targetSessionId: string): void => {
    if (hasPendingLocalCommand() || navigationPending) {
      notice = 'wait for the current command receipt before changing the viewed Session';
      updateStatus();
      return;
    }
    if (targetSessionId === selectedSessionId) {
      clearRemoteOverlay();
      return;
    }
    const generation = ++navigationGeneration;
    navigationPending = true;
    notice = 'reading Session ' + targetSessionId;
    updateStatus();
    void client.sessionRead(targetSessionId).then(
      async (saved) => {
        if (exitRequested || navigationGeneration !== generation) return;
        if (saved.session.id !== targetSessionId) {
          navigationPending = false;
          notice = 'Session read returned a different target';
          updateStatus();
          return;
        }
        await switchDisplayedSession(saved.session.id, generation);
      },
      () => {
        if (exitRequested || navigationGeneration !== generation) return;
        navigationPending = false;
        notice = 'Session read unavailable; current view unchanged';
        updateStatus();
      },
    );
  };

  const openSession = (
    selection: SessionOpenSelection,
    fromSessionId?: string,
  ): void => {
    if (hasPendingLocalCommand() || navigationPending) {
      notice = 'wait for the current command receipt before opening a Session';
      updateStatus();
      return;
    }
    if (!core.implementedOperations.includes('session.open')) {
      notice = 'session.open unavailable';
      updateStatus();
      return;
    }
    const generation = ++navigationGeneration;
    const commandId = crypto.randomUUID();
    navigationPending = true;
    commandMutationPending = true;
    notice = 'opening Session · command ' + commandId;
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
          notice = 'session open rejected: ' +
            commandReasonText(command.reason);
          updateStatus();
          return;
        }
        if (!('snapshot' in command.value)) {
          notice = 'session open unconfirmed · command ' + commandId;
          updateStatus();
          return;
        }
        await switchDisplayedSession(
          command.value.snapshot.session.id,
          generation,
        );
      },
      () => {
        commandMutationPending = false;
        navigationPending = false;
        if (exitRequested) return;
        notice = 'session open response unknown · command ' + commandId;
        updateStatus();
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

  const renameSession = (title: string): void => {
    if (title.trim().length === 0) {
      notice = 'usage: /rename TEXT';
      updateStatus();
      return;
    }
    if (
      hasPendingLocalCommand() || navigationPending || commandMutationPending
    ) {
      notice = 'wait for the current command receipt before renaming';
      updateStatus();
      return;
    }
    if (
      !targetsActiveSession() || !connected || !hasOperation('session.rename')
    ) {
      notice = 'session.rename requires the active Session and an available operation';
      updateStatus();
      return;
    }
    const commandId = crypto.randomUUID();
    const targetId = snapshot().session.id;
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
          notice = 'rename rejected: ' + commandReasonText(command.reason);
        } else if (
          'result' in command.value &&
          (command.value.result === 'renamed' ||
            command.value.result === 'unchanged')
        ) {
          notice = command.value.result === 'renamed'
            ? 'Session renamed'
            : 'Session title unchanged';
        } else notice = 'rename unconfirmed · command ' + commandId;
        updateStatus();
      },
      () => {
        commandMutationPending = false;
        if (exitRequested) return;
        notice = 'rename response unknown · command ' + commandId;
        updateStatus();
      },
    );
  };

  const recallExecution = (reference: string): void => {
    const action = reference === 'clear' ? 'clear' : 'prepare';
    const executionId = action === 'prepare' && reference !== '' && reference !== 'latest'
      ? reference
      : undefined;
    const operation = action === 'clear' ? 'recall.clear' : 'recall.prepare';
    if (
      hasPendingLocalCommand() || navigationPending || commandMutationPending
    ) {
      notice = 'wait for the current command receipt before changing recall';
      updateStatus();
      return;
    }
    if (!connected || !hasOperation(operation)) {
      notice = operation + ' unavailable for this Session';
      updateStatus();
      return;
    }
    const commandId = crypto.randomUUID();
    const targetId = snapshot().session.id;
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
          notice = 'recall rejected: ' + commandReasonText(command.reason);
        } else if ('action' in command.value) {
          const value = command.value as RecallValue;
          notice = value.action === 'prepare'
            ? 'recall prepared from #' + value.sourceExecutionId +
              ' · evidence ' + value.evidence
            : value.cleared
            ? 'pending recall cleared'
            : 'no pending recall';
        } else notice = 'recall unconfirmed · command ' + commandId;
        updateStatus();
      },
      () => {
        commandMutationPending = false;
        if (exitRequested) return;
        notice = 'recall response unknown · command ' + commandId;
        updateStatus();
      },
    );
  };

  const showContext = (): void => {
    if (hasPendingLocalCommand() || navigationPending) {
      notice = 'wait for the current command before reading context';
      updateStatus();
      return;
    }
    if (!connected || !hasOperation('context.read')) {
      notice = 'context.read unavailable for this Session';
      updateStatus();
      return;
    }
    const generation = ++navigationGeneration;
    const targetId = snapshot().session.id;
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
        notice = 'context read unavailable';
        updateStatus();
      },
    );
  };

  const completePathAtCursor = (): void => {
    const currentText = editor.text;
    if (currentText.startsWith('/')) {
      if (editor.cursorScalar !== [...currentText].length) return;
      const candidates = slashCommandCandidates(currentText);
      if (candidates.length === 1) {
        const text = candidates[0];
        if (
          text !== undefined && editor.setSnapshot({
            text,
            cursorScalar: [...text].length,
            byteLength: new TextEncoder().encode(text).byteLength,
          })
        ) {
          editorHistory.resetNavigation();
          draftRevision += 1;
          renderer.setEditorSnapshot(editor.snapshot());
        }
      }
      return;
    }
    const original = editor.snapshot();
    void catalogUi.completePath(editor).then(() => {
      if (
        editor.text !== original.text ||
        editor.cursorScalar !== original.cursorScalar
      ) {
        editorHistory.resetNavigation();
        draftRevision += 1;
        renderer.setEditorSnapshot(editor.snapshot());
      }
    });
  };

  const runSlashCommand = (input: string): boolean => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return false;
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
    const name = match?.[1] ?? '';
    const argument = match?.[2]?.trim() ?? '';
    const known = new Set([
      'exit',
      'help',
      'sessions',
      'view',
      'resume',
      'new',
      'rename',
      'recall',
      'context',
      'provider',
      'model',
      'effort',
      'login',
    ]);
    if (!known.has(name)) {
      notice = 'unknown command /' + name +
        ' · try /sessions, /view, /resume, /new, /context';
      updateStatus();
      return true;
    }
    replaceEditorText('');
    notice = undefined;
    if (name === 'exit') requestExit();
    else if (name === 'help') renderer.renderReadOnlyHelp(helpLines());
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
      snapshot(),
      core.workspace,
      false,
      conversationProjector,
      pendingConversationProjection,
      projectionHintFromFrame(firstFrame.value),
    );
    updateStatus();
    await dependencies.afterAcquire?.();

    const inputReader = new RemoteInputReader(lifecycle, decoder);
    let inputWait: Promise<InputEvent[] | null> = inputReader.next();
    frameWait = nextFrameWait();

    while (!exitRequested) {
      const ready = frameWait === null
        ? await Promise.race([
          inputWait.then((events) => ({ kind: 'input' as const, events })),
          exitWait.then(() => ({ kind: 'exit' as const })),
        ])
        : await Promise.race([
          inputWait.then((events) => ({ kind: 'input' as const, events })),
          frameWait,
          exitWait.then(() => ({ kind: 'exit' as const })),
        ]);
      if (ready.kind === 'exit') break;
      if (ready.kind === 'input') {
        if (ready.events === null) {
          requestExit();
          break;
        }
        inputWait = inputReader.next();
        for (const event of ready.events) {
          if (event.kind === 'ctrl_d') {
            requestExit();
            break;
          }
          const overlay = renderer.stateSnapshot().overlay;
          if (overlay.kind === 'choicePicker') {
            catalogUi.process(event);
            continue;
          }
          if (overlay.kind === 'sessionPicker') {
            if (event.kind === 'escape' || event.kind === 'ctrl_c') {
              clearRemoteOverlay();
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
            if (
              event.kind === 'escape' || event.kind === 'ctrl_c' ||
              (overlay.kind === 'readOnlyHelp' && event.kind === 'f1')
            ) clearRemoteOverlay();
            continue;
          }
          if (
            !editorBusy() && (event.kind === 'up' || event.kind === 'down') &&
            walkInputHistory(event.kind)
          ) continue;
          if (event.kind === 'ctrl_g' || event.kind === 'ctrl_t') {
            showSessionPicker();
            continue;
          }
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
            if (activeExecution() !== undefined) {
              if (!cancellationRequested) cancelActiveExecution();
            } else {
              renderer.clearModal();
              renderer.latest();
            }
          } else if (event.kind === 'f1') {
            if (renderer.stateSnapshot().overlay.kind === 'readOnlyHelp') {
              renderer.clearModal();
            } else {
              renderer.renderReadOnlyHelp(helpLines());
            }
          } else if (event.kind === 'enter') {
            const command = editor.text.trim();
            if (command === '/exit') {
              requestExit();
              break;
            }
            if (runSlashCommand(command)) continue;
            notice = undefined;
            submitDraft();
          } else if (event.kind === 'tab') {
            completePathAtCursor();
          } else if (
            event.kind === 'alt_enter' && activeExecution() !== undefined
          ) {
            notice = undefined;
            submitDraft('follow-up');
          } else if (event.kind === 'paste_rejected') {
            notice = 'paste exceeds 64 KiB';
            updateStatus();
          } else if (event.kind === 'ctrl_o') {
            notice =
              'newline is Shift/Ctrl+Return where sent; idle Alt+Return also inserts a newline';
            updateStatus();
          } else if (
            event.kind === 'printable' || event.kind === 'paste' ||
            event.kind === 'backspace' || event.kind === 'newline' ||
            event.kind === 'alt_enter' || event.kind === 'ctrl_w' ||
            event.kind === 'ctrl_a' || event.kind === 'ctrl_b' ||
            event.kind === 'ctrl_e' || event.kind === 'ctrl_f' ||
            event.kind === 'ctrl_u' || event.kind === 'ctrl_k' ||
            event.kind === 'alt_b' || event.kind === 'alt_f' ||
            event.kind === 'alt_d' || event.kind === 'left' ||
            event.kind === 'right' || event.kind === 'up' ||
            event.kind === 'down' || event.kind === 'home' ||
            event.kind === 'end'
          ) {
            if (isEditorTextMutation(event)) separateSubmittedDraft();
            const before = editor.text;
            const changed = applyEditorEvent(editor, event);
            if (changed) {
              if (editor.text !== before) {
                draftRevision += 1;
                editorHistory.resetNavigation();
              }
              notice = undefined;
              renderer.setEditorSnapshot(editor.snapshot());
            } else if (
              event.kind === 'printable' || event.kind === 'paste' ||
              event.kind === 'newline' || event.kind === 'alt_enter'
            ) {
              notice = event.kind === 'paste' ? 'paste exceeds 64 KiB' : 'input too long';
              updateStatus();
            }
          }
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
        frameWait = null;
        updateStatus();
        continue;
      }

      if (ready.kind === 'resync') {
        state = reduceSessionStreamFrame(undefined, ready.frame);
        selectedModel = snapshot().session.selection;
        connected = true;
        syncCoreObservations();
        renderSnapshot(
          renderer,
          snapshot(),
          core.workspace,
          true,
          conversationProjector,
          pendingConversationProjection,
          projectionHintFromFrame(ready.frame),
        );
        updateStatus();
        frameWait = nextFrameWait();
        continue;
      }

      const frame = ready.result.value;
      try {
        state = reduceSessionStreamFrame(state, frame);
      } catch (error) {
        if (error instanceof Error && error.message.includes('revision gap')) {
          connected = false;
          updateStatus();
          frameWait = reopenFromSnapshot();
          continue;
        }
        throw error;
      }
      selectedModel = snapshot().session.selection;
      syncCoreObservations();
      if (isConversationChange(frame)) {
        renderSnapshot(
          renderer,
          snapshot(),
          core.workspace,
          true,
          conversationProjector,
          pendingConversationProjection,
          projectionHintFromFrame(frame),
        );
      } else {
        renderSessionOrientation(renderer, snapshot(), core.workspace);
      }
      updateStatus();
      frameWait = nextFrameWait();
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
