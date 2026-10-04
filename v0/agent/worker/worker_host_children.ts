import type {
  AsyncAgentProgress,
  AsyncAgentRequest,
  AsyncAgentResponse,
  AsyncAgentRunState,
  AsyncAgentSpawnModelRequest,
  AsyncAgentTerminalResult,
  AsyncAgentTerminalState,
} from '../tools/async_agents.ts';
import type {
  DataExecutionControlInput,
  DataSessionDescriptor,
  DataSessionTerminalResult,
} from '../data/session_data_owner.ts';
import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import { type ChatGPTAuthService, createChatGPTAuthService } from '../provider/chatgpt_auth.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import type {
  ChatGPTModelSelection,
  ModelSelection,
  ReasoningEffort,
} from '../provider/model_selection.ts';
import { selectModelFor } from '../provider/model_catalog.ts';
import { TOOL_FILTER_ERROR_CODE } from '../definitions/tool_filter.ts';
import type {
  WorkerAsyncAgentCatalogEntry,
  WorkerCorrelation,
  WorkerToHostMessage,
} from './worker_protocol.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import { WorkerHostStartupError, WorkerSupervisor } from './worker_host_supervisor.ts';
import { sameCorrelation } from './worker_host_outcome.ts';
import type {
  ChildCleanupObservationV1,
  ChildCleanupRunObservationV1,
} from './worker_child_contract.ts';

const CHILD_SETTLEMENT_GRACE_MS = 5_000;

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

type ChildExecutionControlFact = DataExecutionControlInput extends infer Fact
  ? Fact extends { readonly controlSequence: number } ? Omit<Fact, 'controlSequence'>
  : never
  : never;

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
  readonly agentChoice: AgentConfigurationChoice;
  readonly task: string;
  readonly model: ModelSelection;
  readonly chatgptRegistrationId: string | null;
  readonly tools?: readonly string[];
  readonly sessionId: string;
  readonly createdAt: string;
  readonly settled: Deferred;
  readonly startupComplete: Deferred;
  state: AsyncAgentRunState;
  progress: AsyncAgentProgress;
  addressable: boolean;
  cancelRequested: boolean;
  cancelSent: boolean;
  cancelRequestRecorded: boolean;
  admitted: boolean;
  controlSequence: number;
  controlWrites: Promise<void>;
  pendingControlFacts: DataExecutionControlInput[];
  admissionError?: string;
  admission?: Promise<void>;
  executionAdmission?: Promise<void>;
  executionAdmissionError?: string;
  descriptor?: DataSessionDescriptor;
  executionCorrelation?: WorkerCorrelation;
  cancelCorrelation?: WorkerCorrelation;
  supervisor?: WorkerSupervisor;
  terminal?: AsyncAgentTerminalResult;
  settlementAttempted: boolean;
  forceSettlementRequested: boolean;
  forcedSettlement?: Promise<void>;
  physicalCleanup?: Promise<void>;
  finalizing?: Promise<void>;
  settlementDurable: boolean;
  settlementError?: string;
  cleanup?: Promise<ChildCleanupRunObservationV1>;
};

export interface ChildRunDeps {
  readonly options: WorkerHostSessionOptions;
  /** Names declared by the active parent's accepted configuration snapshot. */
  readonly currentCatalog: () => readonly string[];
  /** Parent's current session model selection; the default source for spawns without a model. */
  readonly currentModelSelection?: () => ModelSelection;
  /** Shared same-store account selection lookup used only when an explicit ChatGPT child spawns. */
  readonly chatgptAuth?: Pick<ChatGPTAuthService, 'selectedRegistrationId'>;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Host-owned registry of parent-execution-scoped async child runs. Each child owns a separate
 * Worker generation and execution. A terminal result becomes model-visible only after its
 * noncanonical settlement is durable.
 */
export class ChildRunRegistry {
  private readonly runs = new Map<string, ChildRun>();
  private readonly activeParents = new Map<string, string | null>();
  private readonly parentCleanups = new Map<
    string,
    Promise<ChildCleanupObservationV1 | undefined>
  >();

  constructor(private readonly deps: ChildRunDeps) {}

  private async selectedChatGPTRegistrationId(): Promise<string | undefined> {
    if (this.deps.chatgptAuth !== undefined) {
      return await this.deps.chatgptAuth.selectedRegistrationId();
    }
    const auth = createChatGPTAuthService({
      ...(this.deps.options.configRoot === undefined
        ? {}
        : { configRoot: this.deps.options.configRoot }),
    });
    try {
      return await auth.selectedRegistrationId();
    } finally {
      await auth.close();
    }
  }

  openParent(
    parentExecutionId: string,
    chatgptRegistrationId: string | null = null,
  ): void {
    if (
      this.activeParents.has(parentExecutionId) ||
      this.parentCleanups.has(parentExecutionId) ||
      [...this.runs.values()].some((run) => run.parentExecutionId === parentExecutionId)
    ) {
      throw new Error(
        `async child parent scope already exists: ${parentExecutionId}`,
      );
    }
    this.activeParents.set(parentExecutionId, chatgptRegistrationId);
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
        if (run.terminal !== undefined) await run.settled.promise;
        if (run.terminal !== undefined && !run.settlementDurable) {
          return {
            ok: false,
            error: run.settlementError ??
              'child terminal settlement is pending',
          };
        }
        return {
          ok: true,
          kind: 'status',
          runId: run.runId,
          state: run.state,
          agent: run.agent,
          progress: structuredClone(run.progress),
        };
      case 'collect':
        await run.settled.promise;
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
    if (!this.deps.currentCatalog().includes(agent)) {
      return { ok: false, error: `agent is not available: ${agent}` };
    }
    const entry: WorkerAsyncAgentCatalogEntry = {
      name: agent,
      choice: { name: agent },
    };
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
        this.deps.options.descriptor.modelSelection ??
        ROOT_DEFAULT_MODEL_SELECTION;
    }
    let chatgptRegistrationId: string | null = null;
    if (runModel.provider === 'openai-chatgpt') {
      chatgptRegistrationId = model === undefined
        ? this.activeParents.get(parentExecutionId) ?? null
        : (await this.selectedChatGPTRegistrationId().catch(() => undefined)) ??
          null;
      runModel = {
        ...(runModel as ChatGPTModelSelection),
        registrationId: chatgptRegistrationId,
      };
    }
    const runId = crypto.randomUUID().toLowerCase();
    const childCorrelation = `parent:${parentExecutionId}:child:${runId}`;
    const createdAt = new Date().toISOString();
    const run: ChildRun = {
      runId,
      parentExecutionId,
      spawnCallId: callId,
      agent,
      agentChoice: entry.choice,
      task,
      model: runModel,
      chatgptRegistrationId,
      ...(tools === undefined ? {} : { tools: Object.freeze([...tools]) }),
      sessionId: childCorrelation,
      createdAt,
      state: 'starting',
      startupComplete: deferred(),
      progress: { phase: 'starting', updatedAt: createdAt },
      addressable: true,
      cancelRequested: false,
      cancelSent: false,
      cancelRequestRecorded: false,
      admitted: false,
      controlSequence: 0,
      controlWrites: Promise.resolve(),
      pendingControlFacts: [],
      settlementAttempted: false,
      forceSettlementRequested: false,
      settlementDurable: false,
      settled: deferred(),
    };
    this.runs.set(runId, run);
    run.admission = this.openDataSession(run);
    try {
      await run.admission;
      if (run.admissionError !== undefined) {
        run.addressable = false;
        this.runs.delete(runId);
        return { ok: false, error: run.admissionError };
      }
      if (run.cancelRequested || !this.activeParents.has(parentExecutionId)) {
        await this.settleUnstartedTerminal(
          run,
          'cancelled',
          'cancelled before child startup',
        );
        return {
          ok: false,
          error: 'parent execution settled before child start',
        };
      }
      try {
        const childOptions = this.childOptions(run, entry);
        if (run.terminal !== undefined || run.cancelRequested) {
          if (run.terminal === undefined) {
            await this.settleUnstartedTerminal(
              run,
              'cancelled',
              'cancelled during child startup',
            );
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
            stateRevision: run.descriptor!.stateRevision,
            modelSelection: run.descriptor!.modelSelection,
          }),
          attachGeneration: (correlation) =>
            this.deps.options.data.attachGeneration(run.sessionId, correlation),
          onGenerationReplaced: () => {},
        });
        run.supervisor = supervisor;
        await supervisor.start();
        if (run.cancelRequested || !this.activeParents.has(parentExecutionId)) {
          await this.settleUnstartedTerminal(
            run,
            'cancelled',
            'cancelled during child startup',
          );
          return {
            ok: false,
            error: 'parent execution settled before child start',
          };
        }
        const correlation = supervisor.correlation('async-child');
        run.executionCorrelation = correlation;
        const executionAdmission = this.deps.options.data.executionAdmit(
          run.sessionId,
          {
            executionId: run.runId,
            taskId: run.runId,
            task: run.task,
            correlation,
            createdAt: run.createdAt,
            parentExecutionId: run.parentExecutionId,
            ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
          },
        ).then((admission) => {
          run.descriptor = admission.descriptor;
          run.admitted = true;
          this.flushPendingExecutionControls(run);
        }).catch((error: unknown) => {
          run.executionAdmissionError = errorText(error);
          throw error;
        });
        run.executionAdmission = executionAdmission;
        await executionAdmission;
        if (run.cancelRequested || !this.activeParents.has(parentExecutionId)) {
          this.requestCancellation(run);
          this.finishWithoutData(run, this.terminal(run, 'cancelled'));
          return {
            ok: false,
            error: 'parent execution settled before child start',
          };
        }
        run.state = 'running';
        supervisor.send({
          kind: 'turn',
          executionId: run.runId,
          correlation,
          task,
          chatgptRegistrationId: run.chatgptRegistrationId,
        });
        return { ok: true, kind: 'spawn', runId };
      } catch (error) {
        const message = errorText(error);
        if (
          error instanceof WorkerHostStartupError &&
          error.code === 'configuration_rejected'
        ) {
          const reasons = error.configurationRejections?.map((rejection) =>
            `${rejection.target} ${rejection.name}: ${rejection.reason}`
          ) ?? [];
          const detail = reasons.length === 0 ? message : `${message}: ${reasons.join('; ')}`;
          await this.completeLocal(
            run,
            this.terminal(run, 'failed', detail),
            true,
          );
          return { ok: false, error: detail };
        }
        if (message.includes(TOOL_FILTER_ERROR_CODE)) {
          this.finishWithoutData(run, this.terminal(run, 'failed', message));
          return { ok: true, kind: 'spawn', runId };
        }
        if (run.admitted || run.executionAdmissionError !== undefined) {
          this.finishWithoutData(
            run,
            this.terminal(run, 'interrupted', message),
          );
        } else {
          await this.settleUnstartedTerminal(
            run,
            run.cancelRequested ? 'cancelled' : 'interrupted',
            run.cancelRequested ? 'cancelled during child startup' : message,
          );
        }
        return {
          ok: false,
          error: run.settlementError === undefined
            ? message
            : `${message}; child settlement failed: ${run.settlementError}`,
        };
      }
    } finally {
      run.startupComplete.resolve();
    }
  }

  private async openDataSession(run: ChildRun): Promise<void> {
    try {
      const descriptor = await this.deps.options.data.openSession({
        persistence: 'none',
        agent: run.agent,
        agentChoice: run.agentChoice,
        sessionId: run.sessionId,
        initialModelSelection: run.model,
      });
      run.descriptor = descriptor;
    } catch (error) {
      run.admissionError = errorText(error);
    }
  }

  private childOptions(
    run: ChildRun,
    entry: WorkerAsyncAgentCatalogEntry,
  ): WorkerHostSessionOptions {
    return {
      data: this.deps.options.data,
      descriptor: run.descriptor!,
      workspaceRoot: this.deps.options.workspaceRoot,
      configRoot: this.deps.options.configRoot,
      agentChoice: entry.choice,
      runtimeIdentity: {
        role: 'child',
        parentExecutionId: run.parentExecutionId,
        ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
      },
      enableAsyncAgents: false,
      chatgptRegistrationId: run.chatgptRegistrationId,
      ...(this.deps.options.capsuleFactory === undefined
        ? {}
        : { capsuleFactory: this.deps.options.capsuleFactory }),
      ...(run.tools === undefined ? {} : { toolFilter: run.tools }),
      physicalIoMode: this.deps.options.physicalIoMode ?? 'production',
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
    if (
      message.kind === 'ready' || message.kind === 'worker_error' ||
      message.kind === 'closed' || message.kind === 'turn_settled'
    ) {
      run.supervisor?.messages.publish(message);
    }
    if (run.terminal === undefined) {
      this.updateProgress(run, message);
    }
    if (
      message.kind === 'cancel_received' &&
      (run.executionCorrelation !== undefined &&
          sameCorrelation(message.correlation, run.executionCorrelation) ||
        run.cancelCorrelation !== undefined &&
          sameCorrelation(message.correlation, run.cancelCorrelation))
    ) {
      this.recordExecutionControl(run, {
        kind: 'cancel_received',
        correlation: message.correlation,
        workerSequence: message.sequence,
        result: message.result,
        observedAt: message.observedAt,
      });
    }
    if (message.kind === 'proposal_ready' || message.kind === 'failure_ready') {
      void this.settleChildMessage(run, message);
    } else if (message.kind === 'worker_error' && run.admitted) {
      void this.failChild(run, message.message);
    }
  }

  private updateProgress(run: ChildRun, message: WorkerToHostMessage): void {
    const updatedAt = new Date().toISOString();
    const current = run.progress;
    if (message.kind === 'request_started') {
      run.progress = {
        ...current,
        phase: current.lastTool?.state === 'running' ? 'tool' : 'model',
        updatedAt,
        modelStep: message.modelStep,
        requestOrdinal: message.requestOrdinal,
      };
    } else if (message.kind === 'child_progress') {
      const { progress } = message;
      run.progress = {
        ...current,
        phase: progress.phase,
        updatedAt,
        ...(progress.modelStep === undefined ? {} : {
          modelStep: progress.modelStep,
        }),
        ...(progress.requestOrdinal === undefined ? {} : {
          requestOrdinal: progress.requestOrdinal,
        }),
        ...(progress.lastTool === undefined ? {} : {
          lastTool: structuredClone(progress.lastTool),
        }),
      };
    }
  }

  private async settleChildMessage(
    run: ChildRun,
    message: Extract<
      WorkerToHostMessage,
      { kind: 'proposal_ready' | 'failure_ready' }
    >,
  ): Promise<void> {
    if (
      run.terminal !== undefined || run.settlementAttempted || !run.admitted
    ) return;
    run.settlementAttempted = true;
    try {
      const result = message.kind === 'proposal_ready'
        ? await this.deps.options.data.settleChildExecution(run.sessionId, {
          executionId: run.runId,
          proposalId: message.proposalId,
          finalDataSequence: message.finalDataSequence,
          decision: { accepted: true },
        })
        : await this.deps.options.data.settleChildExecution(run.sessionId, {
          executionId: message.executionId,
          finalDataSequence: message.finalDataSequence,
        });
      const acknowledged = this.sendCommitAcknowledgement(run, message.correlation, result);
      if (acknowledged) {
        await run.supervisor!.messages.wait((value): value is Extract<
          WorkerToHostMessage,
          { kind: 'turn_settled' | 'worker_error' }
        > =>
          (value.kind === 'turn_settled' &&
            sameCorrelation(value.correlation, message.correlation)) ||
          (value.kind === 'worker_error' && (value.correlation === undefined ||
            sameCorrelation(value.correlation, message.correlation)))
        );
      }
      await this.completeFromData(run, result);
    } catch (error) {
      if (run.forceSettlementRequested) return;
      await this.completeLocal(
        run,
        this.terminal(run, 'interrupted', errorText(error)),
        false,
        errorText(error),
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
      parentExecutionId: run.parentExecutionId,
      ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
      ...(finalText === undefined ? {} : { finalText }),
      ...(error === undefined ? {} : { error }),
    };
  }

  private async failChild(run: ChildRun, message: string): Promise<void> {
    if (run.terminal !== undefined || run.settlementAttempted) return;
    if (!run.admitted) {
      await this.completeLocal(
        run,
        this.terminal(
          run,
          message.includes(TOOL_FILTER_ERROR_CODE) ? 'failed' : 'interrupted',
          message,
        ),
        true,
      );
      return;
    }
    run.settlementAttempted = true;
    await this.terminateWorker(run);
    try {
      const result = await this.deps.options.data.sealGeneration(
        run.sessionId,
        {
          executionId: run.runId,
          decision: 'interrupted',
          reason: message,
        },
      );
      await this.completeFromData(run, result);
    } catch (error) {
      if (run.forceSettlementRequested) return;
      await this.completeLocal(
        run,
        this.terminal(run, 'interrupted', errorText(error)),
        false,
        errorText(error),
      );
    }
  }

  private finishWithoutData(
    run: ChildRun,
    terminal: AsyncAgentTerminalResult,
  ): void {
    if (run.terminal !== undefined || run.settlementAttempted) return;
    if (run.admitted) {
      run.settlementAttempted = true;
      void (async () => {
        await this.terminateWorker(run);
        try {
          const result = await this.deps.options.data.sealGeneration(
            run.sessionId,
            {
              executionId: run.runId,
              decision: terminal.state === 'cancelled' ? 'cancelled' : 'interrupted',
              reason: terminal.error ?? `child run ${terminal.state}`,
            },
          );
          await this.completeFromData(run, result);
        } catch (error) {
          await this.completeLocal(
            run,
            this.terminal(run, 'interrupted', errorText(error)),
            false,
            errorText(error),
          );
        }
      })();
      return;
    }
    void this.completeLocal(run, terminal, true);
  }

  private async settleUnstartedTerminal(
    run: ChildRun,
    decision: 'cancelled' | 'interrupted',
    reason: string,
  ): Promise<void> {
    if (run.settlementAttempted || run.terminal !== undefined) return;
    run.settlementAttempted = true;
    await this.completeLocal(run, this.terminal(run, decision, reason), true);
  }

  private async completeFromData(
    run: ChildRun,
    result: DataSessionTerminalResult,
  ): Promise<void> {
    if (run.terminal !== undefined) return;
    const outcome = result.outcome;
    const state: AsyncAgentTerminalState = result.accepted
      ? 'completed'
      : outcome.stopReason === 'cancelled'
      ? 'cancelled'
      : outcome.stopReason === 'interrupted'
      ? 'interrupted'
      : 'failed';
    const error = outcome.ok ? undefined : outcome.error ?? `child run ${state}`;
    const terminal: AsyncAgentTerminalResult = {
      ...this.terminal(run, state, error, outcome.finalText),
      stopReason: outcome.stopReason,
      ...(outcome.turnProviderRequestCount === undefined ? {} : {
        providerRequestCount: outcome.turnProviderRequestCount,
      }),
      ...(outcome.diagnostic === undefined ? {} : {
        diagnosticId: outcome.diagnostic.diagnosticId,
        diagnosticCode: outcome.diagnostic.code,
      }),
      ...(result.capture?.diagnosticDurability === undefined ? {} : {
        diagnosticDurability: result.capture.diagnosticDurability,
      }),
      ...(result.capture?.diagnosticPersistenceError === undefined ? {} : {
        diagnosticPersistenceError: result.capture.diagnosticPersistenceError,
      }),
      ...(result.capture?.contextDurability === undefined ? {} : {
        contextDurability: result.capture.contextDurability,
      }),
      ...(result.capture?.contextPersistenceError === undefined ? {} : {
        contextPersistenceError: result.capture.contextPersistenceError,
      }),
    };
    await this.completeLocal(run, terminal, result.durable, undefined, true);
  }

  private async completeLocal(
    run: ChildRun,
    terminal: AsyncAgentTerminalResult,
    durable: boolean,
    error?: string,
    gracefulClose = false,
  ): Promise<void> {
    if (run.terminal === undefined) {
      run.terminal = terminal;
      run.state = terminal.state;
      run.progress = {
        ...run.progress,
        phase: 'settled',
        updatedAt: new Date().toISOString(),
      };
      run.settlementDurable = durable;
      run.settlementError = error;
    }
    if (run.finalizing === undefined) {
      run.finalizing = (async () => {
        try {
          await this.terminate(run, gracefulClose);
        } catch (cause) {
          run.settlementDurable = false;
          run.settlementError = errorText(cause);
        } finally {
          run.settled.resolve();
        }
      })();
    }
    await run.finalizing;
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
    this.requestCancellation(run);
    await run.admission;
    const graceMs = this.deps.options.cancelSettlementGraceMs ??
      CHILD_SETTLEMENT_GRACE_MS;
    const startupFinished = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      run.startupComplete.promise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!startupFinished && run.terminal === undefined) {
      await this.terminateWorker(run);
    }
    await run.startupComplete.promise;
    const executionAdmission = run.executionAdmission;
    if (executionAdmission !== undefined) {
      await executionAdmission.catch(() => {});
    }
    if (run.admissionError !== undefined) {
      await this.terminate(run);
      if (run.terminal === undefined) {
        await this.completeLocal(
          run,
          this.terminal(run, 'interrupted', run.admissionError),
          false,
          run.admissionError,
        );
      }
      return {
        runId: run.runId,
        state: run.terminal?.state ?? 'interrupted',
        durability: 'failed',
        error: run.admissionError,
      };
    }
    if (run.executionAdmissionError !== undefined && !run.admitted) {
      if (run.terminal === undefined) {
        await this.completeLocal(
          run,
          this.terminal(run, 'interrupted', run.executionAdmissionError),
          false,
          run.executionAdmissionError,
        );
      } else {
        await run.settled.promise;
      }
      return {
        runId: run.runId,
        state: run.terminal?.state ?? 'interrupted',
        durability: 'failed',
        error: run.executionAdmissionError,
      };
    }
    if (!run.admitted) {
      await this.completeLocal(run, this.terminal(run, 'cancelled'), true);
    } else if (run.terminal === undefined) {
      const settled = await this.waitForSettlement(run, graceMs);
      if (!settled && run.terminal === undefined) {
        await this.forceSealAfterSettlementDeadline(run);
      }
    }
    if (run.terminal === undefined) {
      await run.settled.promise;
    }
    await this.terminate(run);
    return {
      runId: run.runId,
      state: run.terminal?.state ?? 'interrupted',
      durability: run.settlementDurable ? 'yes' : 'failed',
      ...(run.settlementError === undefined ? {} : { error: run.settlementError }),
    };
  }

  private requestCancellation(run: ChildRun): void {
    if (run.terminal !== undefined) return;
    if (!run.cancelRequested) run.cancelRequested = true;
    if (!run.cancelRequestRecorded) {
      run.cancelRequestRecorded = true;
      this.recordExecutionControl(run, { kind: 'cancel_requested' });
    }
    if (run.cancelSent) return;
    const supervisor = run.supervisor;
    if (supervisor === undefined) return;
    const correlation = run.executionCorrelation ??
      supervisor.correlation('async-child-cancel');
    const attempted = this.prepareExecutionControl(run, {
      kind: 'cancel_sent',
    });
    run.cancelSent = true;
    try {
      supervisor.cancelProcessExecution(run.runId);
      supervisor.send({ kind: 'cancel', correlation });
      this.queueExecutionControl(run, attempted);
    } catch (error) {
      this.queueExecutionControl(run, {
        kind: 'cancel_failed',
        controlSequence: attempted.controlSequence,
        observedAt: attempted.observedAt,
      });
      this.finishWithoutData(
        run,
        this.terminal(run, 'interrupted', errorText(error)),
      );
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

  private forceSealAfterSettlementDeadline(run: ChildRun): Promise<void> {
    if (run.forcedSettlement !== undefined) return run.forcedSettlement;
    run.forceSettlementRequested = true;
    run.settlementAttempted = true;
    run.forcedSettlement = (async () => {
      await this.terminateWorker(run);
      if (run.terminal !== undefined) return;
      try {
        const result = await this.deps.options.data.sealGeneration(
          run.sessionId,
          {
            executionId: run.runId,
            decision: 'interrupted',
            reason: 'child cancellation settlement deadline exceeded',
          },
        );
        await this.completeFromData(run, result);
      } catch (error) {
        await this.completeLocal(
          run,
          this.terminal(run, 'interrupted', errorText(error)),
          false,
          errorText(error),
        );
      }
    })();
    return run.forcedSettlement;
  }

  private sendCommitAcknowledgement(
    run: ChildRun,
    correlation: WorkerCorrelation,
    result: DataSessionTerminalResult,
  ): boolean {
    const accepted = result.accepted && result.durable;
    this.recordExecutionControl(run, {
      kind: 'acknowledgement_requested',
      accepted,
    });
    const attempted = this.prepareExecutionControl(run, {
      kind: 'acknowledgement_sent',
      accepted,
    });
    try {
      if (run.supervisor === undefined) {
        throw new Error('child Worker is unavailable for acknowledgement');
      }
      run.supervisor.send({
        kind: 'commit_acknowledgement',
        correlation,
        accepted,
        settlement: {
          accepted: result.accepted,
          adopted: result.canonical,
          durable: result.durable,
          stateRevision: result.stateRevision,
          terminalOutcome: {
            ok: result.outcome.ok,
            outcome: result.outcome.outcome,
            stopReason: result.outcome.stopReason,
            ...(result.outcome.error === undefined ? {} : { error: result.outcome.error }),
          },
        },
      });
      this.queueExecutionControl(run, attempted);
      return true;
    } catch {
      this.queueExecutionControl(run, {
        kind: 'acknowledgement_failed',
        accepted,
        controlSequence: attempted.controlSequence,
        observedAt: attempted.observedAt,
      });
      // Data has committed the child turn; a closed Worker cannot change that result.
      return false;
    }
  }

  private prepareExecutionControl(
    run: ChildRun,
    fact: ChildExecutionControlFact,
  ): DataExecutionControlInput {
    return {
      ...fact,
      observedAt: fact.observedAt ?? new Date().toISOString(),
      controlSequence: ++run.controlSequence,
    } as DataExecutionControlInput;
  }

  private recordExecutionControl(
    run: ChildRun,
    fact: ChildExecutionControlFact,
  ): void {
    this.queueExecutionControl(run, this.prepareExecutionControl(run, fact));
  }

  private queueExecutionControl(
    run: ChildRun,
    input: DataExecutionControlInput,
  ): void {
    if (!run.admitted) {
      run.pendingControlFacts.push(input);
      return;
    }
    this.persistExecutionControl(run, input);
  }

  private flushPendingExecutionControls(run: ChildRun): void {
    for (const input of run.pendingControlFacts.splice(0)) {
      this.persistExecutionControl(run, input);
    }
  }

  private persistExecutionControl(
    run: ChildRun,
    input: DataExecutionControlInput,
  ): void {
    run.controlWrites = run.controlWrites.catch(() => undefined).then(
      async () => {
        try {
          const descriptor = await this.deps.options.data
            .recordExecutionControl(
              run.sessionId,
              run.runId,
              input,
            );
          if (
            run.descriptor !== undefined &&
            descriptor.latestExecution?.executionId === run.runId
          ) {
            run.descriptor = {
              ...run.descriptor,
              latestExecution: structuredClone(descriptor.latestExecution),
            };
          }
        } catch {
          // Control facts are auxiliary; a failed write cannot replace a child terminal result.
        }
      },
    );
  }

  private terminateWorker(run: ChildRun, gracefulClose = false): Promise<void> {
    if (run.physicalCleanup !== undefined) return run.physicalCleanup;
    const supervisor = run.supervisor;
    if (supervisor === undefined) return Promise.resolve();
    return run.physicalCleanup = (async () => {
      let result: 'complete' | 'failed' = 'complete';
      let cleanupError: unknown;
      try {
        const closed = gracefulClose
          ? await supervisor.close()
          : (await supervisor.terminate(), undefined);
        if (
          closed?.hookFailures !== undefined && closed.hookFailures.length > 0
        ) {
          if (run.terminal !== undefined) {
            run.terminal = {
              ...run.terminal,
              runtimeStopFailures: closed.hookFailures.flatMap((failure) =>
                failure.phase === 'runtime_stop'
                  ? [{
                    name: failure.name,
                    ...(failure.path === undefined ? {} : { path: failure.path }),
                    phase: 'runtime_stop' as const,
                    reason: failure.reason,
                  }]
                  : []
              ),
            };
          }
        }
      } catch (error) {
        result = 'failed';
        cleanupError = error;
      }
      this.recordExecutionControl(run, {
        kind: 'process_cleanup_finished',
        result,
      });
      await run.controlWrites;
      if (result === 'failed') throw cleanupError;
    })();
  }

  private async terminate(run: ChildRun, gracefulClose = false): Promise<void> {
    await this.terminateWorker(run, gracefulClose);
    if (run.descriptor !== undefined) {
      await this.deps.options.data.closeSession(run.sessionId);
      run.descriptor = undefined;
    }
  }
}
