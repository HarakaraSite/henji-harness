import type { DefinitionContentV1 } from '../../spike0/src/definition_content.ts';
import type { RevisionBudgetV1 } from './limits.ts';
import type { RevisionPath } from './definition_proposal.ts';

export interface RevisionTicketV1 {
  readonly schemaVersion: 'revision-ticket/v1';
  readonly ticketId: string;
  readonly target: {
    readonly pluginId: string;
    readonly namespace: string;
    readonly kind: 'text-transform';
  };
  readonly exactBase: {
    readonly revisionId: string;
    readonly contentHash: string;
    readonly deploymentStateDigest: string | null;
  };
  readonly allowedPaths: readonly RevisionPath[];
  readonly mutationKind: 'full-replacement';
  readonly budget: RevisionBudgetV1;
  readonly evidenceScope: readonly string[];
  readonly admissionProfile: string;
  readonly policyVersion: string;
}

export interface LiveRevisionContextV1 {
  readonly baseRevisionId: string;
  readonly baseContentHash: string;
  readonly deploymentStateDigest: string | null;
  readonly policyVersion: string;
}
export interface BaseDefinitionSnapshotV1 {
  readonly schemaVersion: 'base-definition-snapshot/v1';
  readonly revisionId: string;
  readonly contentHash: string;
  readonly target: RevisionTicketV1['target'];
  readonly resourceProfileDigest: string;
  readonly canonicalByteCount: number;
  readonly structuralDepth: number;
  readonly structuralEntryCount: number;
  readonly content: DefinitionContentV1;
}

export interface TicketStoreSnapshot {
  readonly tickets: Readonly<Record<string, RevisionTicketV1>>;
}
