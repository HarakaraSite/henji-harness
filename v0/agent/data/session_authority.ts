import type { AgentConfigurationChoice } from '../configuration/configuration_resolver.ts';
import type { Message } from '../core/contracts.ts';
import {
  normalizeSessionTitle,
  type SemanticContextCheckpointV1,
  type SessionModelChange,
  type SessionRecord,
  type WorkerSessionMetadataWrite,
  type WorkerSessionOwnerState,
} from '../session/session_store.ts';
import type { BuildManifestV1 } from '../runtime/build_manifest.ts';
import { buildManifest } from '../runtime/build_manifest.ts';
import type { ModelSelection } from '../provider/model_selection.ts';
import { ROOT_DEFAULT_MODEL_SELECTION } from '../provider/openrouter_model_catalog.ts';
import { causalTranscriptIndex } from '../session/session_record_codec.ts';
import type { WorkerCommitProposalMessage } from '../worker/worker_protocol.ts';

interface SessionAuthorityOptions {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly agent: SessionRecord['agent'];
  readonly agentChoice: AgentConfigurationChoice;
  readonly initialModelSelection?: ModelSelection;
  readonly checkpoint?: SemanticContextCheckpointV1;
}

type ActiveSessionProjection = {
  readonly sessionId: string;
  transcript: Message[];
  nextTurn: number;
  stateRevision: number;
  checkpoint?: SemanticContextCheckpointV1;
  modelSelection: ModelSelection;
  privateStateFromTurn: number;
  title: string | null;
};

/** Owns only the current canonical context and compact state needed for the next generation. */
export class SessionAuthority {
  readonly projection: ActiveSessionProjection;
  readonly build: BuildManifestV1;
  readonly createdAt: string;
  readonly agentChoiceValue: AgentConfigurationChoice;
  private configuredAgent: string;
  #pendingModelChanges: SessionModelChange[];
  private autoCompactionNotice: {
    readonly coveredThroughTurn: number;
    readonly retainedFromTurn: number;
  } | undefined;

  constructor(
    private readonly options: SessionAuthorityOptions,
    state: WorkerSessionOwnerState | undefined,
  ) {
    this.configuredAgent = state?.agent ?? options.agent;
    this.agentChoiceValue = structuredClone(
      state?.agentChoice ?? options.agentChoice,
    );
    const nextTurn = state?.nextTurn ?? 1;
    const defaultSelection = options.initialModelSelection ??
      ROOT_DEFAULT_MODEL_SELECTION;
    const modelSelection = state === undefined
      ? structuredClone(defaultSelection)
      : structuredClone(state.activeModel);
    this.createdAt = state?.createdAt ?? new Date().toISOString();
    this.projection = {
      sessionId: state?.sessionId ?? options.sessionId,
      // The opened-session read transfers its one canonical transcript to this owner.
      transcript: state === undefined ? [] : state.transcript as Message[],
      nextTurn,
      stateRevision: state?.stateRevision ?? 1,
      modelSelection,
      privateStateFromTurn: state?.privateStateFromTurn ?? 1,
      title: state?.title ?? null,
      ...(options.checkpoint === undefined
        ? {}
        : { checkpoint: structuredClone(options.checkpoint) }),
    };
    this.#pendingModelChanges = state === undefined
      ? [{
        effectiveFromTurn: nextTurn,
        changedAt: this.createdAt,
        selection: structuredClone(modelSelection),
      }]
      : [];
    this.build = buildManifest();
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

  agentChoice(): AgentConfigurationChoice {
    return structuredClone(this.agentChoiceValue);
  }

  setConfiguredAgent(name: string): void {
    this.configuredAgent = name;
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

  modelChange(
    selection: ModelSelection,
    changedAt: string,
  ): SessionModelChange {
    return {
      effectiveFromTurn: this.projection.nextTurn,
      changedAt,
      selection: structuredClone(selection),
    };
  }

  metadataWrite(input: {
    readonly updatedAt: string;
    readonly stateRevision: number;
    readonly title?: string | null;
    readonly modelSelection?: ModelSelection;
    readonly modelChange?: SessionModelChange;
  }): WorkerSessionMetadataWrite {
    const additional = input.modelChange === undefined ? [] : [input.modelChange];
    return {
      sessionId: this.sessionId,
      workspaceRoot: this.options.workspaceRoot,
      agentChoice: this.agentChoice(),
      createdAt: this.createdAt,
      updatedAt: input.updatedAt,
      title: input.title ?? this.projection.title,
      stateRevision: input.stateRevision,
      nextTurn: this.projection.nextTurn,
      activeModel: structuredClone(
        input.modelSelection ?? this.projection.modelSelection,
      ),
      modelChangesToAppend: [
        ...this.#pendingModelChanges,
        ...additional.map((change) => structuredClone(change)),
      ],
    };
  }

  initialMetadataWrite(): WorkerSessionMetadataWrite | undefined {
    if (this.#pendingModelChanges.length === 0) return undefined;
    return this.metadataWrite({
      updatedAt: this.createdAt,
      stateRevision: this.projection.stateRevision,
    });
  }

  metadataWriteCommitted(): void {
    this.#pendingModelChanges = [];
  }

  applyModelSelection(
    selection: ModelSelection,
    change: SessionModelChange,
    stateRevision: number,
  ): void {
    if (
      this.projection.modelSelection.provider !== selection.provider ||
      this.projection.modelSelection.modelId !== selection.modelId
    ) this.projection.privateStateFromTurn = change.effectiveFromTurn;
    this.projection.modelSelection = structuredClone(selection);
    this.projection.stateRevision = stateRevision;
  }

  applyTitle(title: string, stateRevision: number): void {
    this.projection.title = title;
    this.projection.stateRevision = stateRevision;
  }

  applyCommitted(
    messageSuffix: readonly Message[],
    nextTurn: number,
    stateRevision: number,
  ): void {
    // Prepared messages become canonical only after the SQLite adoption transaction commits.
    this.projection.transcript.push(...messageSuffix);
    this.projection.nextTurn = nextTurn;
    this.projection.stateRevision = stateRevision;
  }

  normalizeTitle(value: string): string {
    return normalizeSessionTitle(value);
  }

  privateStateFromTurn(): number {
    return this.projection.privateStateFromTurn;
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
      agent: this.configuredAgent,
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

  proposalSuffix(proposal: WorkerCommitProposalMessage): readonly Message[] | undefined {
    const messageCount = this.projection.transcript.length;
    if (
      proposal.nextTurn !== this.projection.nextTurn + 1 ||
      proposal.transcript.length < messageCount
    ) return undefined;
    // The canonical prefix was validated when it was opened or committed. New proposals
    // append exactly one complete turn after that immutable owner state.
    const suffix = proposal.transcript.slice(messageCount);
    const suffixIndex = causalTranscriptIndex(suffix);
    if (
      suffixIndex === undefined || suffixIndex.turns.length !== 1
    ) return undefined;
    // WorkerRuntime begins each turn with a snapshot of generationContext.initialTranscript,
    // then runAgentTurn clones it and appends this turn. Keep only that appended suffix here.
    return structuredClone(suffix) as Message[];
  }

  messageSuffix(transcript: readonly Message[]): readonly Message[] {
    return structuredClone(
      transcript.slice(this.projection.transcript.length),
    ) as Message[];
  }
}
