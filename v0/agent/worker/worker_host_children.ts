import type {
  AsyncAgentRequest,
  AsyncAgentResponse,
  AsyncAgentRunState,
  AsyncAgentTerminalResult,
} from '../tools/async_agents.ts';
import type { WorkerSessionHandle } from '../session/session_store_contract.ts';
import type { HistoryPersistencePort } from '../history/history_store_contract.ts';
import type { LoopOutcome } from '../core/contracts.ts';
import { buildManifest, type BuildManifestV1 } from '../runtime/build_manifest.ts';
import type { DefinitionRevisionRef } from '../session/session_store.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import { roleDefaultModelSelection } from '../provider/model_catalog.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import type { WorkerAsyncAgentCatalogEntry, WorkerToHostMessage } from './worker_protocol.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import { WorkerSupervisor } from './worker_host_supervisor.ts';
import {
  bundledToolDefinitionLoadRequests,
  workerBuiltinModulePath,
} from './worker_definition_revision.ts';
import type { WorkerDefinitionLoadRequest } from './worker_protocol.ts';

type ChildRun = {
  readonly runId: string;
  readonly parentExecutionId: string;
  readonly spawnCallId?: string;
  readonly agent: string;
  readonly agentLabel: 'default' | 'planner';
  readonly task: string;
  readonly model: ModelSelection;
  readonly build: BuildManifestV1;
  readonly definitionRef: DefinitionRevisionRef;
  state: AsyncAgentRunState;
  supervisor?: WorkerSupervisor;
  terminal?: AsyncAgentTerminalResult;
  readonly waiters: (() => void)[];
};

export interface ChildRunDeps {
  readonly options: WorkerHostSessionOptions;
  /** Host-resolved async agent catalog passed to the parent Worker. */
  readonly catalog: readonly WorkerAsyncAgentCatalogEntry[];
  /** Resolve a managed Definition ref to a process-local load descriptor. */
  readonly resolveManagedModule?: (
    ref: DefinitionRevisionRef,
  ) => Promise<WorkerDefinitionLoadRequest>;
  /** Optional durable execution evidence store for child runs. */
  readonly history?: HistoryPersistencePort;
}

const childDefaultSelection = (agent: string): ModelSelection =>
  agent === 'planner'
    ? roleDefaultModelSelection('subagent:planner')
    : ROOT_DEFAULT_MODEL_SELECTION;

const syntheticHandle = (id: string): WorkerSessionHandle => ({
  id,
  commit: () => {},
  acceptCommitted: () => {},
  rollback: () => {},
  installCheckpoint: () => {},
  rollbackCheckpoint: () => {},
  close: () => Promise.resolve(),
});

const lastAssistantText = (transcript: readonly unknown[]): string | undefined => {
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
 * Host-owned registry of async child runs. Each child owns a separate Worker generation and a
 * separate execution; terminal results are returned only through collect and never committed to a
 * canonical Session.
 */
export class ChildRunRegistry {
  private readonly runs = new Map<string, ChildRun>();

  constructor(private readonly deps: ChildRunDeps & { readonly build?: BuildManifestV1 }) {}

  async handle(request: AsyncAgentRequest, callId?: string): Promise<AsyncAgentResponse> {
    switch (request.kind) {
      case 'spawn':
        return await this.spawn(request.agent, request.task, callId);
      case 'status': {
        const run = this.runs.get(request.runId);
        return run === undefined
          ? { ok: false, error: `unknown runId: ${request.runId}` }
          : { ok: true, kind: 'status', runId: run.runId, state: run.state };
      }
      case 'collect': {
        const run = this.runs.get(request.runId);
        if (run === undefined) return { ok: false, error: `unknown runId: ${request.runId}` };
        if (run.terminal === undefined) {
          await new Promise<void>((resolve) => run.waiters.push(resolve));
        }
        return { ok: true, kind: 'collect', result: run.terminal! };
      }
      case 'cancel': {
        const run = this.runs.get(request.runId);
        if (run === undefined) return { ok: false, error: `unknown runId: ${request.runId}` };
        this.cancelRun(run);
        return { ok: true, kind: 'cancel', runId: run.runId, state: run.state };
      }
    }
  }

  cancelAll(): void {
    for (const run of this.runs.values()) {
      if (run.terminal === undefined) this.cancelRun(run);
    }
  }

  private async spawn(
    agent: string,
    task: string,
    callId?: string,
  ): Promise<AsyncAgentResponse> {
    const entry = this.deps.catalog.find((candidate) => candidate.name === agent);
    if (entry === undefined) {
      return { ok: false, error: `agent is not available: ${agent}` };
    }
    const parentExecutionId = this.deps.options.handle.id;
    const runId = crypto.randomUUID().toLowerCase();
    const childCorrelation = `parent:${parentExecutionId}:child:${runId}`;
    const run: ChildRun = {
      runId,
      parentExecutionId,
      spawnCallId: callId,
      agent,
      agentLabel: agent === 'planner' ? 'planner' : 'default',
      task,
      model: childDefaultSelection(agent),
      build: this.deps.build ?? buildManifest(),
      definitionRef: entry.ref,
      state: 'starting',
      waiters: [],
    };
    this.runs.set(runId, run);
    try {
      this.deps.history?.beginExecution(this.historyInput(run));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const childOptions = await this.childOptions(entry, childCorrelation);
      const supervisor = new WorkerSupervisor({
        options: childOptions,
        handleWorkerMessage: (message) => this.routeChildMessage(run, message),
        projection: () => ({
          transcript: [],
          nextTurn: 1,
          stateRevision: 1,
          modelSelection: run.model,
        }),
        onGenerationReplaced: () => {},
      });
      run.supervisor = supervisor;
      await supervisor.start(() => {});
      run.state = 'running';
      supervisor.send({
        kind: 'turn',
        correlation: supervisor.correlation('async-child'),
        task,
      });
      return { ok: true, kind: 'spawn', runId };
    } catch (error) {
      run.state = 'failed';
      run.terminal = {
        runId,
        state: 'failed',
        definitionRef: this.refKey(entry.ref),
        parentExecutionId,
        ...(callId === undefined ? {} : { spawnCallId: callId }),
        error: error instanceof Error ? error.message : String(error),
      };
      this.resolveWaiters(run);
      return { ok: false, error: run.terminal.error! };
    }
  }

  private async childOptions(
    entry: WorkerAsyncAgentCatalogEntry,
    childCorrelation: string,
  ): Promise<WorkerHostSessionOptions> {
    let modulePath: string | undefined;
    let loadDescriptor: WorkerDefinitionLoadRequest | undefined;
    if (entry.name === 'planner') {
      modulePath = workerBuiltinModulePath('planner');
    } else if (this.deps.resolveManagedModule !== undefined) {
      loadDescriptor = await this.deps.resolveManagedModule(entry.ref);
    } else {
      throw new Error(`async agent module is unavailable: ${entry.name}`);
    }
    return {
      handle: syntheticHandle(childCorrelation),
      workspaceRoot: this.deps.options.workspaceRoot,
      agent: entry.name === 'planner' ? 'planner' : 'default',
      definition: entry.ref,
      ...(modulePath === undefined ? {} : { modulePath }),
      ...(loadDescriptor === undefined ? {} : { loadDescriptor }),
      physicalIoMode: this.deps.options.physicalIoMode ?? 'production',
      toolDefinitions: await bundledToolDefinitionLoadRequests(),
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
      message.kind === 'ready' || message.kind === 'model_selected' ||
      message.kind === 'closed' || message.kind === 'commit_proposal' ||
      message.kind === 'turn_failed' || message.kind === 'worker_error'
    ) {
      run.supervisor?.messages.publish(message);
    }
    if (
      message.kind === 'commit_proposal' || message.kind === 'turn_failed' ||
      message.kind === 'worker_error'
    ) {
      this.handleChildMessage(run, message);
    }
  }

  private handleChildMessage(run: ChildRun, message: WorkerToHostMessage): void {
    if (run.terminal !== undefined) return;
    if (message.kind === 'commit_proposal') {
      const finalText = message.outcome?.finalText ??
        lastAssistantText(message.transcript);
      run.state = 'completed';
      run.terminal = {
        runId: run.runId,
        state: 'completed',
        definitionRef: this.refKey(run.definitionRef),
        parentExecutionId: run.parentExecutionId,
        ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
        ...(finalText === undefined ? {} : { finalText }),
      };
      try {
        run.supervisor?.send({
          kind: 'commit_acknowledgement',
          correlation: message.correlation,
          accepted: true,
        });
      } catch {
        // The child generation is unavailable; the terminal result is already retained.
      }
      this.settle(run);
      this.resolveWaiters(run);
      run.supervisor?.terminate();
      return;
    }
    if (message.kind === 'turn_failed') {
      const cancelled = message.outcome.stopReason === 'cancelled';
      run.state = cancelled ? 'cancelled' : 'failed';
      run.terminal = {
        runId: run.runId,
        state: run.state,
        definitionRef: this.refKey(run.definitionRef),
        parentExecutionId: run.parentExecutionId,
        ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
        ...(message.outcome.ok ? {} : { error: message.outcome.error ?? 'child run failed' }),
      };
      this.settle(run);
      run.supervisor?.terminate();
      this.resolveWaiters(run);
      return;
    }
    if (message.kind === 'worker_error') {
      run.state = 'interrupted';
      run.terminal = {
        runId: run.runId,
        state: 'interrupted',
        definitionRef: this.refKey(run.definitionRef),
        parentExecutionId: run.parentExecutionId,
        ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
        error: message.message,
      };
      this.settle(run);
      run.supervisor?.terminate();
      this.resolveWaiters(run);
    }
  }

  private historyInput(run: ChildRun) {
    return {
      taskId: run.runId,
      executionId: run.runId,
      createdAt: new Date().toISOString(),
      sessionCorrelation: `parent:${run.parentExecutionId}:child:${run.runId}`,
      sessionMode: 'no_session' as const,
      turn: 1,
      task: run.task,
      baseStateRevision: 1,
      agent: run.agentLabel,
      model: run.model,
      build: run.build,
      definition: run.definitionRef,
      parentExecutionId: run.parentExecutionId,
      ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
    };
  }

  private settle(run: ChildRun): void {
    const history = this.deps.history;
    if (history === undefined || run.terminal === undefined) return;
    const state = run.terminal.state;
    const outcome: LoopOutcome = {
      ok: state === 'completed',
      task: run.task,
      outcome: state === 'completed'
        ? 'final'
        : state === 'cancelled'
        ? 'cancelled'
        : 'contract_failure',
      stopReason: state === 'completed'
        ? 'final'
        : state === 'cancelled'
        ? 'cancelled'
        : 'contract_failure',
      ...(state === 'completed'
        ? { finalText: run.terminal.finalText }
        : { error: run.terminal.error ?? `child run ${state}` }),
      steps: 0,
      toolCallCount: 0,
      toolResultCount: 0,
      transcript: [],
    };
    try {
      history.settleNonCanonicalExecution({
        ...this.historyInput(run),
        outcome,
      });
    } catch {
      // Durable child evidence is best-effort; the in-memory terminal result is retained.
    }
  }

  private cancelRun(run: ChildRun): void {
    if (run.terminal !== undefined) return;
    try {
      const correlation = run.supervisor?.correlation('async-child-cancel');
      if (correlation !== undefined) {
        run.supervisor!.send({ kind: 'cancel', correlation });
      } else {
        run.state = 'cancelled';
        run.terminal = {
          runId: run.runId,
          state: 'cancelled',
          definitionRef: this.refKey(run.definitionRef),
          parentExecutionId: run.parentExecutionId,
          ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
        };
        this.resolveWaiters(run);
      }
    } catch {
      run.state = 'interrupted';
      run.terminal = {
        runId: run.runId,
        state: 'interrupted',
        definitionRef: this.refKey(run.definitionRef),
        parentExecutionId: run.parentExecutionId,
        ...(run.spawnCallId === undefined ? {} : { spawnCallId: run.spawnCallId }),
      };
      this.resolveWaiters(run);
    }
  }

  private resolveWaiters(run: ChildRun): void {
    const waiters = run.waiters.splice(0, run.waiters.length);
    for (const waiter of waiters) waiter();
  }

  private refKey(ref: DefinitionRevisionRef): string {
    return `${ref.resourceId}@sha256:${ref.revision.digest}`;
  }
}
