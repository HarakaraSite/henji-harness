import { WorkerProcessOwner } from './worker_process_owner.ts';
import { WorkerCapsule } from './worker_capsule.ts';
import type {
  WorkerCorrelation,
  WorkerErrorMessage,
  WorkerReadyMessage,
  WorkerToHostMessage,
} from './worker_protocol.ts';
import { HostMessageQueue } from './worker_host_queue.ts';
import { beginWorkerStageProbeEpoch, createWorkerStageProbeBuffer } from './worker_stage_probe.ts';
import {
  type CredentialAvailability,
  modelRouteProfileId,
  type ModelSelection,
  sameModelSelection,
} from '../provider/model_selection.ts';
import {
  type WorkerExecutionTraceEntry,
  workerHostCommandSubtype,
  workerMessageSubtype,
} from './worker_execution_artifact.ts';
import type { WorkerHostCapsule, WorkerHostSessionOptions } from './worker_host_contract.ts';
import { sameCorrelation } from './worker_host_outcome.ts';
import { isHenjiInstructionRevisionRef } from '../definitions/managed_resource_ref.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/base_instruction.ts';
import type { ConfigurationRejection } from '../configuration/agent_configuration.ts';
import type { WorkerConfigurationSnapshot } from './worker_configuration.ts';

const workerUrl = new URL('./worker_bootstrap.ts', import.meta.url);
const WORKER_RESPONSE_TIMEOUT_MS = 5_000;

export type WorkerHostStartupErrorCode =
  | 'definition_evaluation_failed'
  | 'configuration_rejected'
  | 'role_mismatch'
  | 'manifest_invalid';

export class WorkerHostStartupError extends Error {
  constructor(
    readonly code: WorkerHostStartupErrorCode,
    readonly workerStage: WorkerErrorMessage['stage'],
    message: string,
    readonly configurationRejections?: readonly ConfigurationRejection[],
  ) {
    super(message);
    this.name = 'WorkerHostStartupError';
  }
}

/** Read-only canonical projection the supervisor needs to build a start command. */
interface WorkerSupervisorProjection {
  readonly stateRevision: number;
  readonly modelSelection: ModelSelection;
}

interface WorkerSupervisorHost {
  readonly options: WorkerHostSessionOptions;
  /** Route one inbound Worker message to the coordinator's receive pipeline. */
  handleWorkerMessage(message: WorkerToHostMessage): void;
  /** The canonical projection at the moment a start command is built. */
  projection(): WorkerSupervisorProjection;
  /** Ask Data to create an endpoint and return its Agent-facing peer port. */
  attachGeneration(correlation: WorkerCorrelation): Promise<MessagePort>;
  /** Called after a successful generation replacement so the coordinator can reset its view. */
  onGenerationReplaced(): void;
}

export const validCredentialAvailability = (
  value: CredentialAvailability | undefined,
  selection: ModelSelection,
): value is CredentialAvailability =>
  value !== undefined && value.authProfile === selection.authProfile &&
  (value.status === 'present' || value.status === 'missing' ||
    value.status === 'unknown');

const validStartupSnapshot = (
  value: WorkerReadyMessage['startupSnapshot'],
): value is NonNullable<WorkerReadyMessage['startupSnapshot']> => {
  if (
    value === undefined || !Array.isArray(value.skillNames) ||
    value.context !== undefined
  ) {
    return false;
  }
  if (
    value.instructionSource !== undefined &&
    value.instructionSource !== 'AGENTS.md' &&
    value.instructionSource !== 'AGENTS.MD'
  ) return false;
  return value.skillNames.every((name) => typeof name === 'string' && name.length > 0) &&
    new Set(value.skillNames).size === value.skillNames.length;
};

const validBaseInstructionManifest = (
  value:
    | NonNullable<
      NonNullable<WorkerReadyMessage['manifest']>['baseInstruction']
    >
    | undefined,
  selected: SelectedHenjiBaseInstruction | undefined,
): boolean => {
  if (selected === undefined) {
    return value === undefined || value.selectionSource === 'built-in';
  }
  if (value === undefined || typeof value !== 'object' || value === null) {
    return false;
  }
  return value.slot === selected.slot &&
    value.selectionSource === selected.selectionSource &&
    value.contentDigest === selected.contentDigest &&
    isHenjiInstructionRevisionRef(value.ref) &&
    JSON.stringify(value.ref) === JSON.stringify(selected.ref);
};

const validConfigurationSnapshot = (
  value: WorkerReadyMessage['configuration'],
): value is WorkerConfigurationSnapshot => {
  if (value === undefined || typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as WorkerConfigurationSnapshot;
  return candidate.schemaVersion === 1 &&
    typeof candidate.configurationId === 'string' &&
    candidate.configurationId.length > 0 &&
    typeof candidate.agent?.name === 'string' &&
    candidate.agent.name.length > 0 &&
    typeof candidate.agent.revision === 'string' &&
    typeof candidate.agent.instruction === 'string' &&
    Array.isArray(candidate.agent.tools) &&
    Array.isArray(candidate.agent.agents) &&
    (candidate.source?.kind === 'bundled' ||
      candidate.source?.kind === 'external') &&
    typeof candidate.systemInstruction === 'string' &&
    Array.isArray(candidate.instructionComponents) &&
    Array.isArray(candidate.tools) &&
    Array.isArray(candidate.rejections);
};

/**
 * Owns the ephemeral Worker generation: capsule lifecycle, protocol transport, generation
 * identity, ready-manifest validation, replacement and forced interruption. It owns no canonical
 * Session or journal state.
 */
export class WorkerSupervisor {
  readonly instanceCorrelation = crypto.randomUUID().toLowerCase();
  messages = new HostMessageQueue();
  readonly bootstrapTrace: WorkerExecutionTraceEntry[] = [];
  stageProbeBuffer = createWorkerStageProbeBuffer();
  stageProbeEpoch = 0;
  lastWorkerSequenceReceived = 0;
  lastWorkerSequenceBuffered = 0;
  lastWorkerSequenceDurable = 0;

  private capsule: WorkerHostCapsule;
  private unsubscribe: () => void;
  private generation = crypto.randomUUID().toLowerCase();
  private correlationValue: WorkerCorrelation | undefined;
  private manifest: WorkerReadyMessage['manifest'];
  private configuration: WorkerConfigurationSnapshot | undefined;
  private startupSnapshot: WorkerReadyMessage['startupSnapshot'];
  private credential: CredentialAvailability | undefined;
  private unavailable = false;
  private needsReplacement = false;
  private replacement: Promise<void> | undefined;
  private traceSequence = 0;
  private processOwner = this.createProcessOwner();

  constructor(private readonly host: WorkerSupervisorHost) {
    this.capsule = host.options.capsuleFactory?.(workerUrl) ??
      new WorkerCapsule(workerUrl);
    this.unsubscribe = this.capsule.subscribe((message) => this.receive(message));
  }

  private createProcessOwner(): WorkerProcessOwner {
    return new WorkerProcessOwner((reply) => {
      if (!this.unavailable) this.capsule.send(reply);
    });
  }

  private receive(message: WorkerToHostMessage): void {
    if (message.kind === 'process_request') {
      void this.processOwner.handle(message);
    } else this.host.handleWorkerMessage(message);
  }

  cancelProcessExecution(executionId: string): void {
    void this.processOwner.cancelExecution(executionId);
  }

  finishProcessExecution(executionId: string): void {
    this.processOwner.finishExecution(executionId);
  }

  waitForProcessCleanup(executionId?: string): Promise<void> {
    return this.processOwner.wait(executionId);
  }

  get options(): WorkerHostSessionOptions {
    return this.host.options;
  }

  get workerGeneration(): string {
    return this.generation;
  }

  get currentManifest(): WorkerReadyMessage['manifest'] {
    return this.manifest;
  }

  get currentConfiguration(): WorkerConfigurationSnapshot | undefined {
    return this.configuration;
  }

  get currentStartupSnapshot(): WorkerReadyMessage['startupSnapshot'] {
    return this.startupSnapshot;
  }

  get credentialAvailability(): CredentialAvailability | undefined {
    return this.credential;
  }

  get isUnavailable(): boolean {
    return this.unavailable;
  }

  get generationNeedsReplacement(): boolean {
    return this.needsReplacement;
  }

  get currentCorrelation(): WorkerCorrelation | undefined {
    return this.correlationValue;
  }

  workerResponseTimeoutMs(): number {
    return this.options.workerResponseTimeoutMs ?? WORKER_RESPONSE_TIMEOUT_MS;
  }

  correlation(command: string): WorkerCorrelation {
    return {
      session: this.options.descriptor.id,
      instanceCorrelation: this.instanceCorrelation,
      workerGeneration: this.generation,
      baseStateRevision: this.host.projection().stateRevision,
      command,
    };
  }

  noteWorkerSequenceReceived(message: WorkerToHostMessage): void {
    if (
      'sequence' in message && Number.isSafeInteger(message.sequence) &&
      Number(message.sequence) > this.lastWorkerSequenceReceived
    ) this.lastWorkerSequenceReceived = Number(message.sequence);
  }

  trace(
    direction: WorkerExecutionTraceEntry['direction'],
    kind: WorkerExecutionTraceEntry['kind'],
    semanticSubtype: string,
    correlation: WorkerCorrelation,
    ackAccepted?: boolean,
    sink?: WorkerExecutionTraceEntry[],
  ): void {
    const entry: WorkerExecutionTraceEntry = {
      direction,
      kind,
      semanticSubtype,
      sequence: ++this.traceSequence,
      correlation: structuredClone(correlation),
      ...(ackAccepted === undefined ? {} : { ackAccepted }),
    };
    if (sink !== undefined) sink.push(entry);
    else this.bootstrapTrace.push(entry);
  }

  send(
    command: import('./worker_protocol.ts').WorkerHostCommand,
    sink?: WorkerExecutionTraceEntry[],
    transfer?: Transferable[],
  ): void {
    const subtype = workerHostCommandSubtype(command);
    this.trace(
      'host_to_worker',
      subtype.kind,
      subtype.semanticSubtype,
      command.correlation,
      subtype.ackAccepted,
      sink,
    );
    this.capsule.send(command, transfer);
  }

  receiveTrace(
    message: WorkerToHostMessage,
    sink?: WorkerExecutionTraceEntry[],
  ): void {
    const subtype = workerMessageSubtype(message);
    const correlation = 'correlation' in message && message.correlation !== undefined
      ? message.correlation
      : this.correlationValue ?? this.correlation('worker_error');
    this.trace(
      'worker_to_host',
      subtype.kind,
      subtype.semanticSubtype,
      correlation,
      undefined,
      sink,
    );
  }

  markUnavailable(): void {
    if (!this.unavailable) {
      this.unavailable = true;
      void this.processOwner.close().catch(() => {});
      this.capsule.terminate();
    }
    this.messages.fail(new Error('Worker transport unavailable'));
  }

  markUnavailableForReplacement(): void {
    this.needsReplacement = true;
    this.markUnavailable();
  }

  async replaceGeneration(): Promise<void> {
    if (!this.needsReplacement) return;
    if (this.replacement !== undefined) return await this.replacement;
    this.replacement = (async () => {
      this.unsubscribe();
      this.messages.fail(new Error('Worker generation replaced'));
      this.messages = new HostMessageQueue();
      try {
        this.capsule.terminate();
      } catch {
        // The old generation is already unavailable.
      }
      await this.processOwner.close();
      this.processOwner = this.createProcessOwner();
      this.generation = crypto.randomUUID().toLowerCase();
      this.stageProbeBuffer = createWorkerStageProbeBuffer();
      this.stageProbeEpoch = 0;
      this.lastWorkerSequenceReceived = 0;
      this.lastWorkerSequenceBuffered = 0;
      this.lastWorkerSequenceDurable = 0;
      this.bootstrapTrace.length = 0;
      this.traceSequence = 0;
      this.manifest = undefined;
      this.configuration = undefined;
      this.startupSnapshot = undefined;
      this.credential = undefined;
      this.unavailable = false;
      this.capsule = this.options.capsuleFactory?.(workerUrl) ??
        new WorkerCapsule(workerUrl);
      this.unsubscribe = this.capsule.subscribe((message) => this.receive(message));
      this.host.onGenerationReplaced();
      try {
        await this.start();
        this.needsReplacement = false;
      } catch (error) {
        this.markUnavailable();
        throw error;
      }
    })();
    try {
      await this.replacement;
    } finally {
      this.replacement = undefined;
    }
  }

  async ensureGeneration(): Promise<void> {
    if (this.needsReplacement) await this.replaceGeneration();
    if (this.unavailable) {
      await this.processOwner.wait();
      throw new Error('agent session unavailable');
    }
  }

  beginTurnStageProbeEpoch(): void {
    this.stageProbeEpoch = this.stageProbeEpoch >= 0x7fff_ffff ? 1 : this.stageProbeEpoch + 1;
    try {
      beginWorkerStageProbeEpoch(this.stageProbeBuffer, this.stageProbeEpoch);
    } catch {
      // Diagnostics never narrow or fail turn admission.
    }
  }

  async start(): Promise<void> {
    const projection = this.host.projection();
    const correlation = this.correlation('start');
    const readyPromise = this.messages.wait((
      message,
    ): message is WorkerReadyMessage | WorkerErrorMessage =>
      (message.kind === 'ready' &&
        sameCorrelation(message.correlation, correlation)) ||
      (message.kind === 'worker_error' &&
        (message.correlation === undefined ||
          sameCorrelation(message.correlation, correlation))), 5_000);
    this.correlationValue = correlation;
    let dataPort: MessagePort | undefined;
    try {
      try {
        const agentDataPort = await this.host.attachGeneration(correlation);
        dataPort = agentDataPort;
        this.send(
          {
            kind: 'start',
            correlation,
            dataPort: agentDataPort,
            agentChoice: this.options.agentChoice,
            configRoot: this.options.configRoot,
            ...(this.options.enableAsyncAgents === undefined
              ? {}
              : { enableAsyncAgents: this.options.enableAsyncAgents }),
            ...(this.options.toolFilter === undefined
              ? {}
              : { toolFilter: this.options.toolFilter }),
            workspaceRoot: this.options.workspaceRoot,
            physicalIoMode: this.options.physicalIoMode ?? 'production',
            ...(this.options.rootMaxSteps === undefined
              ? {}
              : { rootMaxSteps: this.options.rootMaxSteps }),
            ...(this.options.providerTimeoutMs === undefined
              ? {}
              : { providerTimeoutMs: this.options.providerTimeoutMs }),
            diagnosticStageBuffer: this.stageProbeBuffer,
            ...(this.options.auxiliaryStageGapMs === undefined ? {} : {
              auxiliaryStageGapMs: this.options.auxiliaryStageGapMs,
            }),
            ...(this.options.baseInstruction === undefined
              ? {}
              : { baseInstruction: this.options.baseInstruction }),
            ...(this.options.providerDeclarations === undefined
              ? {}
              : { providerDeclarations: this.options.providerDeclarations }),
          },
          undefined,
          [agentDataPort],
        );
      } catch {
        dataPort?.close();
        this.markUnavailable();
        // markUnavailable rejects the registered waiter; consume it before returning the error.
        await readyPromise.catch(() => {});
        throw new Error('Worker transport unavailable');
      }
      const ready = await readyPromise;
      if (ready.kind === 'worker_error') {
        if (ready.configurationRejections !== undefined) {
          throw new WorkerHostStartupError(
            'configuration_rejected',
            'configuration',
            ready.message,
            structuredClone(ready.configurationRejections),
          );
        }
        throw new WorkerHostStartupError(
          'definition_evaluation_failed',
          ready.stage,
          ready.message,
        );
      }
      const expectedRole = 'parent';
      if (
        ready.manifest !== undefined && ready.manifest.role !== expectedRole
      ) {
        throw new WorkerHostStartupError(
          'role_mismatch',
          'composition',
          'Worker effective role did not match the Host root role',
        );
      }
      const namedChoice = this.options.agentChoice.name;
      const expectedConfigurationName = namedChoice !== undefined &&
          namedChoice !== 'default'
        ? namedChoice
        : undefined;
      if (
        ready.manifest === undefined ||
        !validConfigurationSnapshot(ready.configuration) ||
        (expectedConfigurationName !== undefined &&
          ready.configuration.agent.name !== expectedConfigurationName) ||
        !sameModelSelection(
          ready.manifest.rootModel,
          projection.modelSelection,
        ) ||
        ready.manifest.profileId !==
          modelRouteProfileId(projection.modelSelection) ||
        !validBaseInstructionManifest(
          ready.manifest.baseInstruction,
          this.options.baseInstruction,
        ) ||
        !Number.isSafeInteger(ready.manifest.maxSteps) ||
        ready.manifest.maxSteps <= 0 ||
        (this.options.rootMaxSteps !== undefined &&
          ready.manifest.maxSteps !== this.options.rootMaxSteps) ||
        !validStartupSnapshot(ready.startupSnapshot) ||
        !validCredentialAvailability(
          ready.credentialAvailability,
          projection.modelSelection,
        )
      ) {
        throw new WorkerHostStartupError(
          'manifest_invalid',
          'composition',
          'Worker manifest or configuration did not match Host selection',
        );
      }
      this.manifest = ready.manifest;
      this.configuration = structuredClone(ready.configuration);
      this.startupSnapshot = {
        ...(ready.startupSnapshot.instructionSource === undefined
          ? {}
          : { instructionSource: ready.startupSnapshot.instructionSource }),
        skillNames: [...ready.startupSnapshot.skillNames],
      };
      this.credential = structuredClone(ready.credentialAvailability);
    } finally {
      this.correlationValue = undefined;
    }
  }

  setCurrentCorrelation(correlation: WorkerCorrelation | undefined): void {
    this.correlationValue = correlation;
  }

  setManifest(manifest: WorkerReadyMessage['manifest']): void {
    this.manifest = manifest;
  }

  setCredentialAvailability(value: CredentialAvailability | undefined): void {
    this.credential = value;
  }

  setStartupSnapshot(value: WorkerReadyMessage['startupSnapshot']): void {
    this.startupSnapshot = value;
  }

  terminate(): Promise<void> {
    this.unsubscribe();
    this.messages.fail(new Error('Worker host session closed'));
    this.unavailable = true;
    const cleanup = this.processOwner.close();
    try {
      this.capsule.terminate();
    } catch { /* Already terminated. */ }
    return cleanup;
  }
}
