import type { LoopOutcome } from '../core/contracts.ts';
import type { ContextView, ExecutionView } from '../../api/contract.ts';
import type { CredentialAvailability, ModelSelection } from '../provider/model_selection.ts';
import type { WorkerReadyMessage } from './worker_protocol.ts';
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

  get agentChoice(): WorkerHostSessionOptions['descriptor']['agentChoice'] {
    return this.coordinator.agentChoice;
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

  effectiveConfigSnapshot() {
    return this.coordinator.effectiveConfigSnapshot();
  }

  pendingRecallSnapshot() {
    return this.coordinator.pendingRecallSnapshot();
  }

  credentialAvailabilitySnapshot(): CredentialAvailability | undefined {
    return this.coordinator.credentialAvailabilitySnapshot();
  }

  /** Presence-only display refresh; never starts work or moves a credential value. */
  async refreshCredentialAvailability(): Promise<
    CredentialAvailability | undefined
  > {
    return await this.coordinator.refreshCredentialAvailability();
  }

  requestCount(): number {
    return this.coordinator.requestCount();
  }

  runtimeSnapshot() {
    return this.coordinator.runtimeSnapshot();
  }

  consumeAutoCompactionNotice(): Promise<
    {
      readonly coveredThroughTurn: number;
      readonly retainedFromTurn: number;
    } | null
  > {
    return this.coordinator.consumeAutoCompactionNotice();
  }

  async selectModel(
    selection: ModelSelection,
  ): Promise<'selected' | 'unchanged' | 'busy' | 'unavailable'> {
    return await this.coordinator.selectModel(selection);
  }

  renameTitle(
    value: string,
  ): Promise<'renamed' | 'unchanged' | 'busy' | 'unavailable'> {
    return this.coordinator.renameTitle(value);
  }

  async prepareRecall(id?: string): Promise<{
    readonly sourceExecutionId: string;
    readonly evidence: 'available' | 'unavailable';
  }> {
    return await this.coordinator.prepareRecall(id);
  }

  clearPendingRecall(): Promise<boolean> {
    return this.coordinator.clearPendingRecall();
  }

  async submit(
    task: string,
  ): Promise<Omit<LoopOutcome, 'transcript'>> {
    return await this.coordinator.submit(task);
  }

  admit(
    task: string,
    executionId?: string,
    initiallyCancelled = false,
  ): ReturnType<ExecutionCoordinator['admit']> {
    return this.coordinator.admit(task, executionId, initiallyCancelled);
  }

  cancelActiveTurn(): 'requested' | 'already_requested' | 'idle' {
    return this.coordinator.cancelActiveTurn();
  }

  steerActiveTurn(text: string): Promise<'accepted' | 'already_accepted' | 'idle'> {
    return this.coordinator.steerActiveTurn(text);
  }

  isAvailable(): boolean {
    return this.coordinator.isAvailable();
  }

  currentPosition(): ReturnType<ExecutionCoordinator['currentPosition']> {
    return this.coordinator.currentPosition();
  }

  executionSnapshot(): ExecutionView | undefined {
    return this.coordinator.executionSnapshot();
  }

  contextSnapshot(): ContextView {
    return this.coordinator.contextSnapshot();
  }

  async close(): Promise<void> {
    await this.coordinator.close();
  }
}
