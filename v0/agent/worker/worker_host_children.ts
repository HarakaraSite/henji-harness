import type {
  AsyncAgentRequest,
  AsyncAgentResponse,
  AsyncAgentRunState,
  AsyncAgentSpawnModelRequest,
  AsyncAgentTerminalResult,
  AsyncAgentTerminalState,
} from '../tools/async_agents.ts';
import type { WorkerSessionHandle } from '../session/session_store_contract.ts';
import type {
  HistoryCaptureResult,
  HistoryPersistencePort,
} from '../history/history_store_contract.ts';
import type { LoopOutcome } from '../core/contracts.ts';
import type { ExecutionContextManifestV2 } from '../history/context_attribution.ts';
import type { FailureDiagnosticV1 } from '../session/failure_diagnostic.ts';
import { buildManifest, type BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { DefinitionRevisionRef } from '../session/session_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import type { ModelSelection, ReasoningEffort } from '../provider/model_selection.ts';
import { selectModelFor } from '../provider/model_catalog.ts';
import { TOOL_FILTER_ERROR_CODE } from '../definitions/tool_filter.ts';
import { workerBuiltinModulePath } from './worker_definition_revision.ts';
import type {
  WorkerAsyncAgentCatalogEntry,
  WorkerDefinitionLoadRequest,
  WorkerReadyMessage,
  WorkerToHostMessage,
} from './worker_protocol.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import { WorkerSupervisor } from './worker_host_supervisor.ts';
import { proposalOutcome } from './worker_host_outcome.ts';
import type {
  ChildCleanupObservationV1,
  ChildCleanupRunObservationV1,
} from './worker_child_contract.ts';
import { historyCaptureDurability } from './worker_history_projection.ts';

const CHILD_SETTLEMENT_GRACE_MS = 5_000;

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((accepted) => resolve = accepted);
  return { promise, resolve };
};

type ChildRun = {
  readonly runId: string;
  readonly parentExecutionId: string;
  readonly spawnCallId?: string;
  readonly agent: string;
  readonly task: string;
  readonly model: ModelSelection;
  readonly tools?: readonly string[];
  readonly build: BuildManifestV1;
  readonly definitionRef: DefinitionRevisionRef;
  readonly createdAt: string;
  readonly settled: Deferred;
  state: AsyncAgentRunState;
  addressable: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
  admitted: boolean;
  admissionError?: string;
  admission?: Promise<void>;
  supervisor?: WorkerSupervisor;
  terminal?: AsyncAgentTerminalResult;
  outcome?: LoopOutcome;
  diagnostic?: FailureDiagnosticV1;
  contextManifest?: ExecutionContextManifestV2;
  manifest?: WorkerReadyMessage['manifest'];
  capture?: HistoryCaptureResult;
  settlementAttempted: boolean;
  settlementDurable: boolean;
  settlementError?: string;
  cleanup?: Promise<ChildCleanupRunObservationV1>;
};

export interface ChildRunDeps {
  readonly options: WorkerHostSessionOptions;
  /** Host-resolved async agent catalog passed to the parent Worker. */
  readonly catalog: readonly WorkerAsyncAgentCatalogEntry[];
  /** Parent's current session model selection; the default source for spawns without a model. */
  readonly currentModelSelection?: () => ModelSelection;
  /** Resolve a managed Definition ref to a process-local load descriptor. */
  readonly resolveManagedModule?: (
    ref: DefinitionRevisionRef,
  ) => Promise<WorkerDefinitionLoadRequest>;
  /** Optional durable execution evidence store for child runs. */
  readonly history?: HistoryPersistencePort;
}

const syntheticHandle = (id: string): WorkerSessionHandle => ({
  id,
  commit: () => {},
  acceptCommitted: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const lastAssistantText = (
  transcript: readonly unknown[],
): string | undefined => {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index] as { role?: unknown; content?: unknown };
    if (message.role !== 'assistant') continue;
    const content = message.content;
    if (
      content !== null && typeof content === 'object' && 'kind' in content &&
      (content as { kind?: unknown }).kind === 'text'
    ) {
      const text = (content as { text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
  }
  return undefined;
};

/**
 * Host-owned registry of parent-execution-scoped async child runs. Each child owns a separate
 * Worker generation and execution. A terminal result becomes model-visible only after its
 * noncanonical settlement is durable.
 */
export class ChildRunRegistry {
  private readonly runs = new Map<string, ChildRun>();
  private readonly activeParents = new Set<string>();
  private readonly parentCleanups = new Map<
    string,
    Promise<ChildCleanupObservationV1 | undefined>
  >();

  constructor(
    private readonly deps: ChildRunDeps & { readonly build?: BuildManifestV1 },
  ) {}

  openParent(parentExecutionId: string): void {
    if (
      this.activeParents.has(parentExecutionId) ||
      this.parentCleanups.has(parentExecutionId) ||
      [...this.runs.values()].some((run) => run.parentExecutionId === parentExecutionId)
    ) {
      throw new Error(
        `async child parent scope already exists: ${parentExecutionId}`,
      );
    }
    this.activeParents.add(parentExecutionId);
  }

  async handle(
    request: AsyncAgentRequest,
    callId?: string,
    parentExecutionId?: string,
  ): Promise<AsyncAgentResponse> {
    if (parentExecutionId === undefined) {
      return {
        ok: false,
        error: 'async child operation requires an active parent execution',
      };
    }
    if (request.kind === 'spawn') {
      return await this.spawn(
        request.agent,
        request.task,
        callId,
        parentExecutionId,
        request.model,
        request.tools,
      );
    }
    const run = this.addressableRun(request.runId, parentExecutionId);
    if (run === undefined) {
      return {
        ok: false,
        error: `unknown runId for active parent: ${request.runId}`,
      };
    }
    switch (request.kind) {
      case 'status':
        if (run.terminal !== undefined && !run.settlementDurable) {
          return {
            ok: false,
            error: run.settlementError ??
              'child terminal settlement is pending',
          };
        }
        return { ok: true, kind: 'status', runId: run.runId, state: run.state };
      case 'collect':
        if (!run.settlementAttempted) await run.settled.promise;
        if (!run.settlementDurable || run.terminal === undefined) {
          return {
            ok: false,
            error: run.settlementError ?? 'child terminal settlement failed',
          };
        }
        return { ok: true, kind: 'collect', result: run.terminal };
      case 'cancel': {
        const observation = await this.cleanupRun(run);
        if (observation.durability === 'failed') {
          return {
            ok: false,
            error: observation.error ?? 'child cancellation settlement failed',
          };
        }
        return {
          ok: true,
          kind: 'cancel',
          runId: run.runId,
          state: observation.state,
        };
      }
    }
  }

  cleanupParent(
    parentExecutionId: string,
  ): Promise<ChildCleanupObservationV1 | undefined> {
    const existing = this.parentCleanups.get(parentExecutionId);
    if (existing !== undefined) return existing;
    this.activeParents.delete(parentExecutionId);
    const runs = [...this.runs.values()].filter((run) =>
      run.parentExecutionId === parentExecutionId
    );
    for (const run of runs) run.addressable = false;
    const cleanup = runs.length === 0
      ? Promise.resolve(undefined)
      : Promise.all(runs.map((run) => this.cleanupRun(run))).then((
        observations,
      ) => ({
        schemaVersion: 1 as const,
        runs: observations,
      }));
    this.parentCleanups.set(parentExecutionId, cleanup);
    return cleanup;
  }

  async cleanupAll(): Promise<ChildCleanupObservationV1 | undefined> {
    const parents = new Set(
      [...this.runs.values()].map((run) => run.parentExecutionId),
    );
    const observations = (await Promise.all(
      [...parents].map((parentExecutionId) => this.cleanupParent(parentExecutionId)),
    )).flatMap((observation) => observation?.runs ?? []);
    return observations.length === 0 ? undefined : { schemaVersion: 1, runs: observations };
  }

  releaseParent(parentExecutionId: string): void {
    for (const [runId, run] of this.runs) {
      if (run.parentExecutionId === parentExecutionId) this.runs.delete(runId);
    }
    this.activeParents.delete(parentExecutionId);
    this.parentCleanups.delete(parentExecutionId);
  }

  private addressableRun(
    runId: string,
    parentExecutionId: string,
  ): ChildRun | undefined {
    const run = this.runs.get(runId);
    return run?.addressable === true &&
        run.parentExecutionId === parentExecutionId
      ? run
      : undefined;
  }

  private async spawn(
    agent: string,
    task: string,
    callId: string | undefined,
    parentExecutionId: string,
    model?: AsyncAgentSpawnModelRequest,
    tools?: readonly string[],
  ): Promise<AsyncAgentResponse> {
    if (!this.activeParents.has(parentExecutionId)) {
      return {
        ok: false,
        error: 'parent execution no longer accepts child runs',
      };
    }
    const entry = this.deps.catalog.find((candidate) => candidate.name === agent);
    if (entry === undefined) {
      return { ok: false, error: `agent is not available: ${agent}` };
    }
    if (!this.activeParents.has(parentExecutionId)) {
      return {
        ok: false,
        error: 'parent execution no longer accepts child runs',
      };
    }
    let runModel: ModelSelection;
    if (model !== undefined) {
      try {
        runModel = selectModelFor(
          model.provider,
          model.modelId,
          model.effort as ReasoningEffort | undefined,
        );
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    } else {
      runModel = this.deps.currentModelSelection?.() ??
        this.deps.options.initialModelSelection ?? ROOT_DEFAULT_MODEL_SELECTION;
    }
    const runId = crypto.randomUUID().toLowerCase();
    const childCorrelation = `parent:${parentExecutionId}:child:${runId}`;
    const run: ChildRun = {
      runId,
      parentExecutionId,
      spawnCallId: callId,
      agent,
      task,
      model: runModel,
      ...(tools === undefined ? {} : { tools: Object.freeze([...tools]) }),
      build: this.deps.build ?? buildManifest(),
      definitionRef: entry.ref,
      createdAt: new Date().toISOString(),
      state: 'starting',
      addressable: true,
      cancelRequested: false,
      cancelSent: false,
      admitted: false,
      settlementAttempted: false,
      settlementDurable: false,
      settled: deferred(),
    };
    this.runs.set(runId, run);
    run.admission = this.admit(run);
    await run.admission;
    if (run.admissionError !== undefined) {
      run.addressable = false;
      return { ok: false, error: run.admissionError };
    }
    if (run.cancelRequested || !this.activeParents.has(parentExecutionId)) {
      this.finish(run, this.terminal(run, 'cancelled'));
      return {
        ok: false,
        error: 'parent execution settled before child start',
      };
    }
    try {
      const childOptions = await this.childOptions(run, entry, childCorrelation);
      if (run.terminal !== undefined || run.cancelRequested) {
        if (run.terminal === undefined) {
          this.finish(run, this.terminal(run, 'cancelled'));
        }
        return {
          ok: false,
          error: 'parent execution settled before child start',
        };
      }
      const supervisor = new WorkerSupervisor({
        options: childOptions,
        handleWorkerMessage: (message) => this.routeChildMessage(run, message),
        projection: () => ({
          transcript: [],
          nextTurn: 1,
          stateRevision: 1,
          modelSelection: run.model,
          privateStateFromTurn: 1,
        }),
        onGenerationReplaced: () => {},
      });
      run.supervisor = supervisor;
      await supervisor.start(() => {});
      if (run.cancelRequested || !this.activeParents.has(parentExecutionId)) {
        this.finish(run, this.terminal(run, 'cancelled'));
        return {
          ok: false,
          error: 'parent execution settled before child start',
        };
      }
      run.state = 'running';
      supervisor.send({
        kind: 'turn',
        correlation: supervisor.correlation('async-child'),
        task,
      });
      return { ok: true, kind: 'spawn', runId };
    } catch (error) {
      const message = errorText(error);
      if (message.includes(TOOL_FILTER_ERROR_CODE)) {
        this.finish(run, this.terminal(run, 'failed', message));
        return { ok: true, kind: 'spawn', runId };
      }
      this.finish(run, this.terminal(run, 'interrupted', message));
      return {
        ok: false,
        error: run.settlementError === undefined
          ? message
          : `${message}; child settlement failed: ${run.settlementError}`,
      };
    }
  }

  private async admit(run: ChildRun): Promise<void> {
    try {
      await this.deps.history?.beginExecution(this.historyInput(run));
      run.admitted = true;
    } catch (error) {
      run.admissionError = errorText(error);
    }
  }

  private async childOptions(
    run: ChildRun,
    entry: WorkerAsyncAgentCatalogEntry,
    childCorrelation: string,
  ): Promise<WorkerHostSessionOptions> {
    const isBuiltinGeneric = entry.ref.resourceId === 'builtin/generic';
    if (!isBuiltinGeneric && this.deps.resolveManagedModule === undefined) {
      throw new Error(`async agent module is unavailable: ${entry.name}`);
    }
    const loadDescriptor = isBuiltinGeneric
      ? undefined
      : await this.deps.resolveManagedModule!(entry.ref);
    return {
      handle: syntheticHandle(childCorrelation),
      workspaceRoot: this.deps.options.workspaceRoot,
      agent: 'default' as const,
      definition: entry.ref,
      ...(isBuiltinGeneric ? { modulePath: workerBuiltinModulePath('generic') } : {}),
      ...(loadDescriptor === undefined ? {} : { loadDescriptor }),
      initialModelSelection: run.model,
      ...(run.tools === undefined ? {} : { toolFilter: run.tools }),
      physicalIoMode: this.deps.options.physicalIoMode ?? 'production',
      toolDefinitions: structuredClone(this.deps.options.toolDefinitions ?? []),
      ...(this.deps.options.rootMaxSteps === undefined
        ? {}
        : { rootMaxSteps: this.deps.options.rootMaxSteps }),
      ...(this.deps.options.providerTimeoutMs === undefined
        ? {}
        : { providerTimeoutMs: this.deps.options.providerTimeoutMs }),
      ...(this.deps.options.baseInstruction === undefined
        ? {}
        : { baseInstruction: this.deps.options.baseInstruction }),
      ...(this.deps.options.providerDeclarations === undefined
        ? {}
        : { providerDeclarations: this.deps.options.providerDeclarations }),
    };
  }

  private routeChildMessage(run: ChildRun, message: WorkerToHostMessage): void {
    if (message.kind === 'ready' && message.manifest !== undefined && run.manifest === undefined) {
      run.manifest = structuredClone(message.manifest);
    }
    if (
      message.kind === 'ready' || message.kind === 'model_selected' ||
      message.kind === 'closed' || message.kind === 'commit_proposal' ||
      message.kind === 'turn_failed' || message.kind === 'worker_error'
    ) {
      run.supervisor?.messages.publish(message);
    }
    if (
      message.kind === 'commit_proposal' || message.kind === 'turn_failed' ||
      message.kind === 'worker_error'
    ) this.handleChildMessage(run, message);
  }

  private handleChildMessage(
    run: ChildRun,
    message: WorkerToHostMessage,
  ): void {
    if (run.terminal !== undefined) return;
    if (message.kind === 'commit_proposal') {
      const outcome = message.outcome ??
        proposalOutcome(run.task, message.transcript, undefined);
      const finalText = outcome.finalText ??
        lastAssistantText(message.transcript);
      try {
        run.supervisor?.send({
          kind: 'commit_acknowledgement',
          correlation: message.correlation,
          accepted: true,
        });
      } catch {
        // The terminal proposal remains the semantic child result.
      }
      this.finish(
        run,
        this.terminal(
          run,
          'completed',
          undefined,
          finalText,
        ),
        outcome,
        message.diagnostic,
        message.contextManifest,
      );
      return;
    }
    if (message.kind === 'turn_failed') {
      const state = message.outcome.stopReason === 'cancelled'
        ? 'cancelled'
        : message.outcome.stopReason === 'interrupted'
        ? 'interrupted'
        : 'failed';
      this.finish(
        run,
        this.terminal(
          run,
          state,
          message.outcome.ok ? undefined : message.outcome.error ?? `child run ${state}`,
          message.outcome.finalText,
        ),
        message.outcome,
        message.diagnostic,
        message.contextManifest,
      );
      return;
    }
    if (message.kind === 'worker_error') {
      this.finish(
        run,
        this.terminal(
          run,
          message.message.includes(TOOL_FILTER_ERROR_CODE) ? 'failed' : 'interrupted',
          message.message,
        ),
      );
    }
  }

  private terminal(
    run: ChildRun,
    state: AsyncAgentTerminalState,
    error?: string,
    finalText?: string,
  ): AsyncAgentTerminalResult {
    return {
      runId: run.runId,
      state,
      definitionRef: this.refKey(run.definitionRef),
      parentExecutionId: run.parentExecutionId,
      ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
      ...(finalText === undefined ? {} : { finalText }),
      ...(error === undefined ? {} : { error }),
    };
  }

  private finish(
    run: ChildRun,
    terminal: AsyncAgentTerminalResult,
    outcome?: LoopOutcome,
    diagnostic?: FailureDiagnosticV1,
    contextManifest?: ExecutionContextManifestV2,
  ): void {
    if (run.terminal !== undefined) return;
    const settledOutcome = outcome ?? this.syntheticOutcome(run, terminal);
    run.terminal = this.withOutcome(terminal, settledOutcome, diagnostic);
    run.outcome = settledOutcome;
    run.diagnostic = diagnostic ?? outcome?.diagnostic;
    run.contextManifest = contextManifest;
    run.state = terminal.state;
    this.settle(run);
    this.terminate(run);
    run.settled.resolve();
  }

  private settle(run: ChildRun): void {
    if (run.settlementAttempted) return;
    run.settlementAttempted = true;
    if (!run.admitted) {
      run.settlementError = run.admissionError ??
        'child execution admission is not durable';
      return;
    }
    const history = this.deps.history;
    if (history === undefined) {
      run.settlementDurable = true;
      return;
    }
    if (run.terminal === undefined || run.outcome === undefined) {
      run.settlementError = 'child terminal result is unavailable';
      return;
    }
    const outcome = run.outcome;
    try {
      const capture = history.settleNonCanonicalExecution({
        ...this.historyInput(run),
        outcome,
        ...(run.diagnostic === undefined ? {} : { diagnostic: run.diagnostic }),
        ...(run.contextManifest === undefined ? {} : { contextManifest: run.contextManifest }),
      });
      run.capture = capture;
      run.terminal = this.withCapture(run.terminal, capture);
      run.settlementDurable = true;
    } catch (error) {
      run.settlementError = errorText(error);
    }
  }

  private syntheticOutcome(
    run: ChildRun,
    terminal: AsyncAgentTerminalResult,
  ): LoopOutcome {
    const stopReason: LoopOutcome['stopReason'] = terminal.state === 'completed'
      ? 'final'
      : terminal.state === 'cancelled'
      ? 'cancelled'
      : terminal.state === 'interrupted'
      ? 'interrupted'
      : 'contract_failure';
    return {
      ok: terminal.state === 'completed',
      task: run.task,
      outcome: stopReason,
      stopReason,
      ...(terminal.state === 'completed'
        ? { finalText: terminal.finalText }
        : terminal.error === undefined
        ? {}
        : { error: terminal.error }),
      steps: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    };
  }

  private withOutcome(
    terminal: AsyncAgentTerminalResult,
    outcome: LoopOutcome,
    diagnostic?: FailureDiagnosticV1,
  ): AsyncAgentTerminalResult {
    const providerRequestCount = outcome.turnProviderRequestCount;
    const failureDiagnostic = diagnostic ?? outcome.diagnostic;
    return {
      ...terminal,
      stopReason: outcome.stopReason,
      ...(providerRequestCount === undefined ? {} : { providerRequestCount }),
      ...(failureDiagnostic === undefined ? {} : {
        diagnosticId: failureDiagnostic.diagnosticId,
        diagnosticCode: failureDiagnostic.code,
      }),
    };
  }

  private withCapture(
    terminal: AsyncAgentTerminalResult,
    capture: HistoryCaptureResult,
  ): AsyncAgentTerminalResult {
    const durability = historyCaptureDurability(capture);
    const diagnosticDurability = durability.diagnosticDurability ??
      (terminal.diagnosticId === undefined ? undefined : 'unknown');
    return {
      ...terminal,
      ...durability,
      ...(diagnosticDurability === undefined ? {} : {
        diagnosticDurability,
      }),
      ...(capture.contextDurability === undefined ? {} : {
        contextDurability: capture.contextDurability,
      }),
      ...(capture.contextPersistenceError === undefined ? {} : {
        contextPersistenceError: capture.contextPersistenceError,
      }),
    };
  }

  private cleanupRun(run: ChildRun): Promise<ChildCleanupRunObservationV1> {
    if (run.cleanup !== undefined) return run.cleanup;
    run.cleanup = this.performCleanup(run);
    return run.cleanup;
  }

  private async performCleanup(
    run: ChildRun,
  ): Promise<ChildCleanupRunObservationV1> {
    run.cancelRequested = true;
    await run.admission;
    if (run.admissionError !== undefined) {
      return {
        runId: run.runId,
        state: 'cancelled',
        durability: 'failed',
        error: run.admissionError,
      };
    }
    if (run.terminal === undefined) this.requestCancellation(run);
    if (!run.settlementAttempted) {
      const graceMs = this.deps.options.cancelSettlementGraceMs ??
        CHILD_SETTLEMENT_GRACE_MS;
      const settled = await this.waitForSettlement(run, graceMs);
      if (!settled) {
        this.finish(
          run,
          this.terminal(
            run,
            'interrupted',
            'child cancellation settlement deadline exceeded',
          ),
        );
      }
    }
    this.terminate(run);
    return {
      runId: run.runId,
      state: run.terminal?.state ?? 'interrupted',
      durability: run.settlementDurable ? 'yes' : 'failed',
      ...(run.settlementError === undefined ? {} : { error: run.settlementError }),
    };
  }

  private requestCancellation(run: ChildRun): void {
    if (run.terminal !== undefined || run.cancelSent) return;
    if (run.state === 'starting') return;
    try {
      const correlation = run.supervisor?.correlation('async-child-cancel');
      if (correlation === undefined) {
        this.finish(run, this.terminal(run, 'cancelled'));
        return;
      }
      run.cancelSent = true;
      run.supervisor!.send({ kind: 'cancel', correlation });
    } catch (error) {
      this.finish(run, this.terminal(run, 'interrupted', errorText(error)));
    }
  }

  private waitForSettlement(run: ChildRun, graceMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      run.settled.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private terminate(run: ChildRun): void {
    try {
      run.supervisor?.terminate();
    } catch {
      // The generation is already unavailable.
    }
  }

  private historyInput(run: ChildRun) {
    return {
      taskId: run.runId,
      executionId: run.runId,
      createdAt: run.createdAt,
      sessionCorrelation: `parent:${run.parentExecutionId}:child:${run.runId}`,
      sessionMode: 'no_session' as const,
      turn: 1,
      task: run.task,
      baseStateRevision: 1,
      agent: 'default' as const,
      model: run.model,
      build: run.build,
      definition: run.definitionRef,
      parentExecutionId: run.parentExecutionId,
      ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
      ...(run.manifest === undefined ? {} : { manifest: run.manifest }),
    };
  }

  private refKey(ref: DefinitionRevisionRef): string {
    return `${ref.resourceId}@sha256:${ref.revision.digest}`;
  }
}
