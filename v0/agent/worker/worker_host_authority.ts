import type { Message } from '../core/contracts.ts';
import { indexSessionHistory } from '../session/session_history.ts';
import {
  type DefinitionRevisionRef,
  normalizeSessionTitle,
  type SemanticContextCheckpointV1,
  type SessionModelChange,
  type SessionRecord,
  type SessionRecordV6,
  type SessionTurnExecutionAttribution,
  type SessionTurnModelAttribution,
  validateSessionRecordV6,
} from '../session/session_store.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import type { WorkerHostSessionOptions } from './worker_host_contract.ts';
import type { ActiveSessionProjection } from './worker_host_types.ts';
import type { WorkerCommitProposalMessage } from './worker_protocol.ts';

/**
 * Owns the canonical Session projection: transcript, state revision, checkpoint, model selection
 * history, title, and the record construction/validation used for admission, commit proposals, and
 * projection updates. It performs no Worker transport and owns no journal state.
 */
export class SessionAuthority {
  readonly projection: ActiveSessionProjection;
  readonly build: BuildManifestV1;
  readonly createdAt: string;
  private autoCompactionNotice: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;

  constructor(
    private readonly options: WorkerHostSessionOptions,
    record: SessionRecordV6 | undefined,
  ) {
    const nextTurn = record?.nextTurn ?? 1;
    const defaultSelection = options.initialModelSelection ??
      ROOT_DEFAULT_MODEL_SELECTION;
    const modelSelection = record === undefined
      ? structuredClone(defaultSelection)
      : structuredClone(record.activeModel);
    this.projection = {
      sessionId: options.handle.id,
      transcript: record === undefined ? [] : structuredClone(record.transcript) as Message[],
      nextTurn,
      stateRevision: record?.stateRevision ?? 1,
      modelSelection,
      modelChanges: record === undefined
        ? [{
          effectiveFromTurn: nextTurn,
          changedAt: new Date().toISOString(),
          selection: structuredClone(modelSelection),
        }]
        : structuredClone(record.modelChanges) as SessionModelChange[],
      turnModels: record === undefined
        ? []
        : structuredClone(record.turnModels) as SessionTurnModelAttribution[],
      turnExecutions: record === undefined ? [] : structuredClone(
        record.turnExecutions,
      ) as SessionTurnExecutionAttribution[],
      title: record?.title ?? null,
      ...(options.handle.checkpoint === undefined
        ? {}
        : { checkpoint: structuredClone(options.handle.checkpoint) }),
    };
    this.build = buildManifest();
    this.createdAt = record?.createdAt ?? new Date().toISOString();
  }

  get sessionId(): string {
    return this.projection.sessionId;
  }

  modelSelectionSnapshot(): ModelSelection {
    return structuredClone(this.projection.modelSelection);
  }

  transcriptSnapshot(): readonly Message[] {
    return structuredClone(this.projection.transcript);
  }

  checkpointSnapshot(): SemanticContextCheckpointV1 | undefined {
    return this.projection.checkpoint === undefined
      ? undefined
      : structuredClone(this.projection.checkpoint);
  }

  definition(): DefinitionRevisionRef {
    return structuredClone(this.options.definition);
  }

  consumeAutoCompactionNotice(): {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | null {
    const notice = this.autoCompactionNotice;
    this.autoCompactionNotice = undefined;
    return notice === undefined ? null : structuredClone(notice);
  }

  recordCheckpointNotice(notice: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  }): void {
    this.autoCompactionNotice = notice;
  }

  clearCheckpointNotice(): void {
    this.autoCompactionNotice = undefined;
  }

  applyCheckpoint(checkpoint: SemanticContextCheckpointV1): void {
    this.projection.checkpoint = structuredClone(checkpoint);
  }

  applyModelSelection(
    selection: ModelSelection,
    changes: SessionModelChange[],
    stateRevision: number,
  ): void {
    this.projection.modelSelection = structuredClone(selection);
    this.projection.modelChanges = changes;
    this.projection.stateRevision = stateRevision;
  }

  applyTitle(title: string, stateRevision: number): void {
    this.projection.title = title;
    this.projection.stateRevision = stateRevision;
  }

  applyCommitted(record: SessionRecordV6): void {
    this.projection.transcript = structuredClone(
      record.transcript,
    ) as Message[];
    this.projection.nextTurn = record.nextTurn;
    this.projection.stateRevision = record.stateRevision;
    this.projection.turnModels = structuredClone(
      record.turnModels,
    ) as SessionTurnModelAttribution[];
    this.projection.turnExecutions = structuredClone(
      record.turnExecutions,
    ) as SessionTurnExecutionAttribution[];
  }

  admissionSessionRecord(): SessionRecordV6 | undefined {
    if (this.options.handle.record !== undefined) return undefined;
    if (this.options.durableCanonicalHistory !== true) return undefined;
    const record: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: this.createdAt,
      title: null,
      stateRevision: this.projection.stateRevision,
      nextTurn: this.projection.nextTurn,
      transcript: [],
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.projection.modelSelection),
      modelChanges: structuredClone(this.projection.modelChanges),
      turnModels: [],
      turnExecutions: [],
    };
    if (!validateSessionRecordV6(record)) {
      throw new Error('empty session record invalid');
    }
    return record;
  }

  proposalRecord(
    proposal: WorkerCommitProposalMessage,
  ): SessionRecordV6 | undefined {
    const committedTurn = proposal.nextTurn - 1;
    const record: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      title: this.projection.title,
      stateRevision: this.projection.stateRevision + 1,
      nextTurn: proposal.nextTurn,
      transcript: structuredClone(proposal.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.projection.modelSelection),
      modelChanges: structuredClone(this.projection.modelChanges),
      turnModels: [
        ...structuredClone(this.projection.turnModels),
        {
          turn: proposal.nextTurn - 1,
          selection: structuredClone(this.projection.modelSelection),
        },
      ],
      turnExecutions: [
        ...structuredClone(this.projection.turnExecutions),
        {
          turn: committedTurn,
          build: structuredClone(this.build),
          definition: structuredClone(this.options.definition),
        },
      ],
    };
    return validateSessionRecordV6(record) ? record : undefined;
  }

  modelSelectionRecord(
    selection: ModelSelection,
    changes: SessionModelChange[],
    stateRevision: number,
    changedAt: string,
  ): SessionRecordV6 {
    const record: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: changedAt,
      title: this.projection.title,
      stateRevision,
      nextTurn: this.projection.nextTurn,
      transcript: structuredClone(this.projection.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(selection),
      modelChanges: changes,
      turnModels: structuredClone(this.projection.turnModels),
      turnExecutions: structuredClone(this.projection.turnExecutions),
    };
    if (!validateSessionRecordV6(record)) {
      throw new Error('model selection record invalid');
    }
    return record;
  }

  titleRecord(
    title: string,
    stateRevision: number,
    changedAt: string,
  ): SessionRecordV6 {
    const record: SessionRecordV6 = {
      schemaVersion: 6,
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agent: this.options.agent,
      createdAt: this.createdAt,
      updatedAt: changedAt,
      title,
      stateRevision,
      nextTurn: this.projection.nextTurn,
      transcript: structuredClone(this.projection.transcript),
      definition: structuredClone(this.options.definition),
      activeModel: structuredClone(this.projection.modelSelection),
      modelChanges: structuredClone(this.projection.modelChanges),
      turnModels: structuredClone(this.projection.turnModels),
      turnExecutions: structuredClone(this.projection.turnExecutions),
    };
    if (!validateSessionRecordV6(record)) {
      throw new Error('session title record invalid');
    }
    return record;
  }

  normalizeTitle(value: string): string {
    return normalizeSessionTitle(value);
  }

  completedTurnCount(): number {
    return indexSessionHistory(this.projection.transcript)?.turns.length ?? 0;
  }

  currentPosition(): {
    readonly sessionId: string;
    readonly createdAt: string;
    readonly title?: string;
    readonly agent: SessionRecord['agent'];
    readonly committedTurn: number;
    readonly messageCount: number;
    readonly checkpoint?: Pick<
      SemanticContextCheckpointV1,
      'coveredThroughTurn' | 'retainedFromTurn'
    >;
  } {
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      ...(this.projection.title === null ? {} : { title: this.projection.title }),
      agent: this.options.agent,
      committedTurn: this.projection.nextTurn - 1,
      messageCount: this.projection.transcript.length,
      ...(this.projection.checkpoint === undefined ? {} : {
        checkpoint: {
          coveredThroughTurn: this.projection.checkpoint.coveredThroughTurn,
          retainedFromTurn: this.projection.checkpoint.retainedFromTurn,
        },
      }),
    };
  }
}
