import type { LoopOutcome, Message } from '../core/contracts.ts';
import type {
  DefinitionRevisionRef,
  SemanticContextCheckpointV1,
} from '../session/session_store.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import type { WorkerReadyMessage } from './worker_protocol.ts';
import type { RecalledExecutionContext } from './recalled_execution_context.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import { ExecutionCoordinator } from './worker_host_coordinator.ts';
export {
  WorkerHostStartupError,
  type WorkerHostStartupErrorCode,
} from './worker_host_supervisor.ts';
export {
  WorkerRecallSelectionError,
  type WorkerRecallSelectionErrorCode,
} from './worker_host_coordinator.ts';

/**
 * Session facade used by TUI/headless Surfaces. It exposes submit/cancel/steer/history/navigation
 * entry points and delegates every execution to one `ExecutionCoordinator`. It owns no Worker
 * lifecycle, journal, or canonical Session state.
 */
export class WorkerHostSession {
  static async open(
    options: WorkerHostSessionOptions,
  ): Promise<WorkerHostSession> {
    const coordinator = await ExecutionCoordinator.open(options);
    return new WorkerHostSession(coordinator);
  }

  private constructor(private readonly coordinator: ExecutionCoordinator) {}

  get definition(): DefinitionRevisionRef {
    return this.coordinator.definition;
  }

  get sessionId(): string {
    return this.coordinator.sessionId;
  }

  modelSelectionSnapshot(): ModelSelection {
    return this.coordinator.modelSelectionSnapshot();
  }

  startupSnapshot(): NonNullable<WorkerReadyMessage['startupSnapshot']> {
    return this.coordinator.startupSnapshot();
  }

  credentialAvailabilitySnapshot(): CredentialAvailability | undefined {
    return this.coordinator.credentialAvailabilitySnapshot();
  }

  requestCount(): number {
    return this.coordinator.requestCount();
  }

  consumeAutoCompactionNotice(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null {
    return this.coordinator.consumeAutoCompactionNotice();
  }

  async selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'> {
    return await this.coordinator.selectModel(selection);
  }

  renameTitle(
    value: string,
  ): 'renamed' | 'unchanged' | 'busy' | 'unavailable' {
    return this.coordinator.renameTitle(value);
  }

  async prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }> {
    return await this.coordinator.prepareRecall(id);
  }

  clearPendingRecall(): boolean {
    return this.coordinator.clearPendingRecall();
  }

  async submit(
    task: string,
    recalledContext?: RecalledExecutionContext,
  ): Promise<LoopOutcome> {
    return await this.coordinator.submit(task, recalledContext);
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    return this.coordinator.cancelActiveTurn();
  }

  steerActiveTurn(text: string): 'accepted' | 'already_accepted' | 'idle' {
    return this.coordinator.steerActiveTurn(text);
  }

  isAvailable(): boolean {
    return this.coordinator.isAvailable();
  }

  transcriptSnapshot(): readonly Message[] {
    return this.coordinator.transcriptSnapshot();
  }

  currentPosition(): ReturnType<ExecutionCoordinator['currentPosition']> {
    return this.coordinator.currentPosition();
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.coordinator.checkpointSnapshot();
  }

  async close(): Promise<void> {
    await this.coordinator.close();
  }
}
