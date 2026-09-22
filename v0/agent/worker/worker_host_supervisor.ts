import { readWorkerModuleRevision, WorkerCapsule } from './worker_capsule.ts';
import type {
  WorkerCorrelation,
  WorkerDefinitionLoadRequest,
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
import {
  isHenjiInstructionRevisionRef,
  isToolDefinitionRevisionRef,
  type ToolDefinitionRevisionRef,
} from '../definitions/managed_resource_ref.ts';
import type { SelectedHenjiBaseInstruction } from '../instructions/base_instruction.ts';
import { validateWorkerContextSnapshot } from '../history/context_attribution.ts';

const workerUrl = new URL('./worker_bootstrap.ts', import.meta.url);
const WORKER_RESPONSE_TIMEOUT_MS = 5_000;

export type WorkerHostStartupErrorCode =
  | 'module_invalid'
  | 'definition_evaluation_failed'
  | 'role_mismatch'
  | 'manifest_invalid';

export class WorkerHostStartupError extends Error {
  constructor(
    readonly code: WorkerHostStartupErrorCode,
    readonly workerStage: WorkerErrorMessage['stage'],
    message: string,
  ) {
    super(message);
    this.name = 'WorkerHostStartupError';
  }
}

/** Read-only canonical projection the supervisor needs to build a start command. */
export interface WorkerSupervisorProjection {
  readonly transcript: readonly unknown[];
  readonly nextTurn: number;
  readonly stateRevision: number;
  readonly checkpoint?: unknown;
  readonly modelSelection: ModelSelection;
}

export interface WorkerSupervisorHost {
  readonly options: WorkerHostSessionOptions;
  /** Route one inbound Worker message to the coordinator's receive pipeline. */
  handleWorkerMessage(message: WorkerToHostMessage): void;
  /** The canonical projection at the moment a start command is built. */
  projection(): WorkerSupervisorProjection;
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
  if (value === undefined || !Array.isArray(value.skillNames)) return false;
  if (
    value.instructionSource !== undefined &&
    value.instructionSource !== 'AGENTS.md' &&
    value.instructionSource !== 'AGENTS.MD'
  ) return false;
  return value.skillNames.every((name) => typeof name === 'string' && name.length > 0) &&
    new Set(value.skillNames).size === value.skillNames.length &&
    (value.context === undefined ||
      validateWorkerContextSnapshot(value.context));
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

const toolAttributionKey = (
  toolIdentity: string,
  ref: ToolDefinitionRevisionRef,
): string => `${toolIdentity}:${ref.resourceId}@sha256:${ref.revision.digest}`;

const validToolManifest = (
  value: NonNullable<WorkerReadyMessage['manifest']>['tools'],
  requested: readonly import('./worker_protocol.ts').WorkerToolDefinitionLoadRequest[] | undefined,
): boolean => {
  const expectedKeys = new Set(
    (requested ?? []).map((tool) => toolAttributionKey(tool.toolIdentity, tool.ref)),
  );
  const actual = value ?? [];
  const actualKeys = actual.map((tool) =>
    isToolDefinitionRevisionRef(tool.ref)
      ? toolAttributionKey(tool.toolIdentity, tool.ref)
      : undefined
  );
  return actualKeys.every((key) => key !== undefined && expectedKeys.has(key)) &&
    new Set(actualKeys).size === actualKeys.length;
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
  private startupSnapshot: WorkerReadyMessage['startupSnapshot'];
  private credential: CredentialAvailability | undefined;
  private unavailable = false;
  private needsReplacement = false;
  private replacement: Promise<void> | undefined;
  private traceSequence = 0;

  constructor(private readonly host: WorkerSupervisorHost) {
    this.capsule = host.options.capsuleFactory?.(workerUrl) ??
      new WorkerCapsule(workerUrl);
    this.unsubscribe = this.capsule.subscribe((message) => this.host.handleWorkerMessage(message));
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
      session: this.options.handle.id,
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
    if (this.options.historyPersistence?.capturesProtocolTrace?.() === false) return;
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
    this.capsule.send(command);
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

  markUnavailable(onClearBuffer: () => void): void {
    onClearBuffer();
    if (!this.unavailable) {
      this.unavailable = true;
      this.capsule.terminate();
    }
    this.messages.fail(new Error('Worker transport unavailable'));
  }

  markUnavailableForReplacement(onClearBuffer: () => void): void {
    this.needsReplacement = true;
    this.markUnavailable(onClearBuffer);
  }

  async replaceGeneration(onClearBuffer: () => void): Promise<void> {
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
      this.generation = crypto.randomUUID().toLowerCase();
      this.stageProbeBuffer = createWorkerStageProbeBuffer();
      this.stageProbeEpoch = 0;
      this.lastWorkerSequenceReceived = 0;
      this.lastWorkerSequenceBuffered = 0;
      this.lastWorkerSequenceDurable = 0;
      this.bootstrapTrace.length = 0;
      this.traceSequence = 0;
      this.manifest = undefined;
      this.startupSnapshot = undefined;
      this.credential = undefined;
      this.unavailable = false;
      this.capsule = this.options.capsuleFactory?.(workerUrl) ??
        new WorkerCapsule(workerUrl);
      this.unsubscribe = this.capsule.subscribe((message) =>
        this.host.handleWorkerMessage(message)
      );
      this.host.onGenerationReplaced();
      try {
        await this.start(onClearBuffer);
        this.needsReplacement = false;
      } catch (error) {
        this.markUnavailable(onClearBuffer);
        throw error;
      }
    })();
    try {
      await this.replacement;
    } finally {
      this.replacement = undefined;
    }
  }

  async ensureGeneration(onClearBuffer: () => void): Promise<void> {
    if (this.needsReplacement) await this.replaceGeneration(onClearBuffer);
    if (this.unavailable) throw new Error('agent session unavailable');
  }

  beginTurnStageProbeEpoch(): void {
    this.stageProbeEpoch = this.stageProbeEpoch >= 0x7fff_ffff ? 1 : this.stageProbeEpoch + 1;
    try {
      beginWorkerStageProbeEpoch(this.stageProbeBuffer, this.stageProbeEpoch);
    } catch {
      // Diagnostics never narrow or fail turn admission.
    }
  }

  async start(onClearBuffer: () => void): Promise<void> {
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
    let revision: WorkerDefinitionLoadRequest;
    if (this.options.loadDescriptor !== undefined) {
      revision = this.options.loadDescriptor;
    } else if (this.options.modulePath !== undefined) {
      revision = await readWorkerModuleRevision(this.options.modulePath);
    } else {
      throw new WorkerHostStartupError(
        'module_invalid',
        'module_pre_read',
        'Worker Definition physical descriptor is unavailable',
      );
    }
    this.correlationValue = correlation;
    try {
      this.send({
        kind: 'start',
        correlation,
        module: revision,
        ...(this.options.toolDefinitions === undefined
          ? {}
          : { toolDefinitions: this.options.toolDefinitions }),
        workspaceRoot: this.options.workspaceRoot,
        physicalIoMode: this.options.physicalIoMode ?? 'production',
        rootRole: this.options.agent === 'planner' ? 'planner' : 'parent',
        ...(this.options.rootMaxSteps === undefined
          ? {}
          : { rootMaxSteps: this.options.rootMaxSteps }),
        ...(this.options.providerTimeoutMs === undefined
          ? {}
          : { providerTimeoutMs: this.options.providerTimeoutMs }),
        diagnosticStageBuffer: this.stageProbeBuffer,
        initialTranscript: projection.transcript as never,
        nextTurn: projection.nextTurn,
        ...(projection.checkpoint === undefined
          ? {}
          : { checkpoint: projection.checkpoint as never }),
        modelSelection: projection.modelSelection,
        ...(this.options.baseInstruction === undefined
          ? {}
          : { baseInstruction: this.options.baseInstruction }),
        ...(this.options.providerDeclarations === undefined
          ? {}
          : { providerDeclarations: this.options.providerDeclarations }),
      });
    } catch {
      this.markUnavailable(onClearBuffer);
      throw new Error('Worker transport unavailable');
    }
    try {
      const ready = await readyPromise;
      if (ready.kind === 'worker_error') {
        throw new WorkerHostStartupError(
          ready.stage === 'module_pre_read' ? 'module_invalid' : 'definition_evaluation_failed',
          ready.stage,
          ready.message,
        );
      }
      const expectedRole = this.options.agent === 'planner' ? 'planner' : 'parent';
      if (
        ready.manifest !== undefined && ready.manifest.role !== expectedRole
      ) {
        throw new WorkerHostStartupError(
          'role_mismatch',
          'module_validation',
          'Worker Definition effective role did not match its declared role',
        );
      }
      if (
        ready.manifest === undefined ||
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
        !validToolManifest(
          ready.manifest.tools,
          this.options.toolDefinitions,
        ) ||
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
          'module_validation',
          'Worker manifest did not match Host selection',
        );
      }
      this.manifest = ready.manifest;
      this.startupSnapshot = ready.startupSnapshot;
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

  terminate(): void {
    this.unsubscribe();
    this.messages.fail(new Error('Worker host session closed'));
    this.capsule.terminate();
  }
}
