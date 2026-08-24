import type { JsonValue } from '../../spike0/src/definition_content.ts';
import { normalizeJsonObject } from '../../spike0/src/definition_content.ts';
import type { RevisionBudgetV1 } from './limits.ts';
import { utf8Length } from './limits.ts';

export type RevisionPath = 'source' | 'manifest' | 'pluginOwnedTests' | 'config';
export type CandidateOrigin = 'ai' | 'human' | 'third-party' | 'legacy';

export interface ProposalSubmissionV1 {
  readonly schemaVersion: 'proposal-submission/v1';
  readonly replacement: JsonValue;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly expectedEffect: string;
  readonly knownRisks: readonly string[];
}

export interface SubmissionEnvelopeV1 {
  readonly submissionId: string;
  readonly ticketId: string;
  readonly authorizedPath: RevisionPath;
  readonly origin: CandidateOrigin;
  readonly originEvidence: Record<string, JsonValue>;
  readonly hostPluginId: string;
  readonly hostNamespace: string;
  readonly normalizerDigest: string;
}

export interface DefinitionProposalV1
  extends Omit<ProposalSubmissionV1, 'schemaVersion' | 'replacement'> {
  readonly schemaVersion: 'definition-proposal/v1';
  readonly proposalId: string;
  readonly submissionId: string;
  readonly ticketId: string;
  readonly mutation: {
    readonly kind: 'full-replacement';
    readonly path: RevisionPath;
    readonly value: JsonValue;
  };
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const exact = (value: unknown, keys: readonly string[], path: string): Record<string, unknown> => {
  if (!plain(value)) throw new Error(`${path}: plain object required`);
  const actual = Object.keys(value);
  if (
    Reflect.ownKeys(value).length !== actual.length || actual.some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k))
  ) {
    throw new Error(`${path}: exact fields required`);
  }
  return value;
};

const strings = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${path}: string array required`);
  }
  return [...value];
};

export const normalizeSubmission = (
  value: unknown,
  budget: RevisionBudgetV1,
): ProposalSubmissionV1 => {
  const root = exact(value, [
    'schemaVersion',
    'replacement',
    'reason',
    'evidenceRefs',
    'expectedEffect',
    'knownRisks',
  ], '$');
  if (root.schemaVersion !== 'proposal-submission/v1') {
    throw new Error('invalid submission version');
  }
  if (typeof root.reason !== 'string' || typeof root.expectedEffect !== 'string') {
    throw new Error('narrative strings required');
  }
  const evidenceRefs = strings(root.evidenceRefs, '$.evidenceRefs');
  const knownRisks = strings(root.knownRisks, '$.knownRisks');
  if (new Set(evidenceRefs).size !== evidenceRefs.length) throw new Error('duplicate evidence ref');
  if (evidenceRefs.length > budget.maxEvidenceRefs || knownRisks.length > budget.maxKnownRisks) {
    throw new Error('list budget exceeded');
  }
  if (
    utf8Length(root.reason) > budget.maxReasonBytes ||
    utf8Length(root.expectedEffect) > budget.maxExpectedEffectBytes
  ) throw new Error('narrative budget exceeded');
  if (
    evidenceRefs.some((v) => utf8Length(v) > budget.maxEvidenceRefBytesEach) ||
    evidenceRefs.reduce((n, v) => n + utf8Length(v), 0) > budget.maxEvidenceRefBytesTotal
  ) throw new Error('evidence budget exceeded');
  if (
    knownRisks.some((v) => utf8Length(v) > budget.maxKnownRiskBytesEach) ||
    knownRisks.reduce((n, v) => n + utf8Length(v), 0) > budget.maxKnownRiskBytesTotal
  ) throw new Error('risk budget exceeded');
  const holder = normalizeJsonObject({ replacement: root.replacement }, '$');
  return {
    schemaVersion: 'proposal-submission/v1',
    replacement: holder.replacement,
    reason: root.reason,
    evidenceRefs,
    expectedEffect: root.expectedEffect,
    knownRisks,
  };
};

export const buildProposal = (
  submission: ProposalSubmissionV1,
  envelope: SubmissionEnvelopeV1,
  proposalId: string,
): DefinitionProposalV1 =>
  structuredClone({
    schemaVersion: 'definition-proposal/v1',
    proposalId,
    submissionId: envelope.submissionId,
    ticketId: envelope.ticketId,
    mutation: {
      kind: 'full-replacement',
      path: envelope.authorizedPath,
      value: submission.replacement,
    },
    reason: submission.reason,
    evidenceRefs: submission.evidenceRefs,
    expectedEffect: submission.expectedEffect,
    knownRisks: submission.knownRisks,
  });
