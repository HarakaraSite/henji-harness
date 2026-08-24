import { MAX_REVISION_BUDGET } from './limits.ts';
import type { RevisionOutcomeLedgerV1 } from './revision_outcome.ts';
import type {
  BaseDefinitionSnapshotV1,
  LiveRevisionContextV1,
  RevisionTicketV1,
} from './revision_ticket.ts';
import { canonicalBytes } from '../../spike0/src/canonical_content.ts';
import { normalizeDefinitionContent } from '../../spike0/src/definition_content.ts';
import { INTAKE_LIMITS, measureStructureBounded } from './limits.ts';

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[], path: string): Record<string, unknown> => {
  if (!plain(value)) throw new Error(`${path}: object required`);
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) throw new Error(`${path}: exact fields required`);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !('value' in d)) throw new Error(`${path}: data properties required`);
  }
  return value;
};
const text = (value: unknown, path: string): string => {
  if (typeof value !== 'string') throw new Error(`${path}: string required`);
  return value;
};
const hash = (value: unknown, path: string): string => {
  const v = text(value, path);
  if (!/^sha256:[0-9a-f]{64}$/.test(v)) throw new Error(`${path}: hash required`);
  return v;
};
const origin = (value: unknown): void => {
  if (!['ai', 'human', 'third-party', 'legacy'].includes(String(value))) {
    throw new Error('origin');
  }
};
const target = (value: unknown, path: string): void => {
  const item = exact(value, ['pluginId', 'namespace', 'kind'], path);
  text(item.pluginId, `${path}.pluginId`);
  text(item.namespace, `${path}.namespace`);
  if (item.kind !== 'text-transform') throw new Error(`${path}.kind`);
};

export const validateTicketRuntime = (input: RevisionTicketV1): void => {
  const root = exact(input, [
    'schemaVersion',
    'ticketId',
    'target',
    'exactBase',
    'allowedPaths',
    'mutationKind',
    'budget',
    'evidenceScope',
    'admissionProfile',
    'policyVersion',
  ], '$ticket');
  if (root.schemaVersion !== 'revision-ticket/v1' || root.mutationKind !== 'full-replacement') {
    throw new Error('ticket literals');
  }
  text(root.ticketId, 'ticketId');
  text(root.admissionProfile, 'admissionProfile');
  text(root.policyVersion, 'policyVersion');
  target(root.target, 'target');
  const base = exact(
    root.exactBase,
    ['revisionId', 'contentHash', 'deploymentStateDigest'],
    'exactBase',
  );
  text(base.revisionId, 'revisionId');
  hash(base.contentHash, 'contentHash');
  if (base.deploymentStateDigest !== null) text(base.deploymentStateDigest, 'deployment digest');
  if (
    !Array.isArray(root.allowedPaths) || root.allowedPaths.length !== 1 ||
    !['source', 'manifest', 'pluginOwnedTests', 'config'].includes(String(root.allowedPaths[0]))
  ) throw new Error('allowedPaths');
  if (!Array.isArray(root.evidenceScope) || root.evidenceScope.some((v) => typeof v !== 'string')) {
    throw new Error('evidenceScope');
  }
  if (
    root.evidenceScope.length > INTAKE_LIMITS.maxTicketEvidenceScopeEntries ||
    root.evidenceScope.reduce(
        (n, value) => n + new TextEncoder().encode(String(value)).byteLength,
        0,
      ) >
      INTAKE_LIMITS.maxTicketEvidenceScopeBytesTotal
  ) throw new Error('evidenceScope budget');
  const budgetKeys = Object.keys(MAX_REVISION_BUDGET);
  const budget = exact(root.budget, budgetKeys, 'budget');
  if (budget.schemaVersion !== 'revision-budget/v1') throw new Error('budget version');
};

export const validateContextRuntime = (
  base: BaseDefinitionSnapshotV1,
  live: LiveRevisionContextV1,
): void => {
  const b = exact(base, [
    'schemaVersion',
    'revisionId',
    'contentHash',
    'target',
    'resourceProfileDigest',
    'canonicalByteCount',
    'structuralDepth',
    'structuralEntryCount',
    'content',
  ], '$base');
  if (b.schemaVersion !== 'base-definition-snapshot/v1') throw new Error('base version');
  text(b.revisionId, 'base revision');
  hash(b.contentHash, 'base hash');
  hash(b.resourceProfileDigest, 'profile hash');
  for (const key of ['canonicalByteCount', 'structuralDepth', 'structuralEntryCount']) {
    if (!Number.isSafeInteger(b[key]) || Number(b[key]) < 0) throw new Error('base metric');
  }
  target(b.target, '$base.target');
  measureStructureBounded(b.content, INTAKE_LIMITS.maxBaseDepth, INTAKE_LIMITS.maxBaseEntries);
  normalizeDefinitionContent(b.content);
  const l = exact(live, [
    'baseRevisionId',
    'baseContentHash',
    'deploymentStateDigest',
    'policyVersion',
  ], '$live');
  text(l.baseRevisionId, 'live revision');
  hash(l.baseContentHash, 'live hash');
  text(l.policyVersion, 'policy');
  if (l.deploymentStateDigest !== null) text(l.deploymentStateDigest, 'deployment');
};

export const validateLedgerRuntime = (ledger: RevisionOutcomeLedgerV1): void => {
  const root = exact(ledger, ['schemaVersion', 'entries'], '$ledger');
  if (root.schemaVersion !== 'revision-outcome-ledger/v1' || !Array.isArray(root.entries)) {
    throw new Error('ledger schema');
  }
  if (root.entries.length > INTAKE_LIMITS.maxLedgerEntries) throw new Error('ledger count');
  let total = 0;
  const ids = new Set<string>();
  for (const entry of root.entries) {
    if (!plain(entry) || !['accepted', 'rejected'].includes(String(entry.status))) {
      throw new Error('ledger entry');
    }
    const accepted = entry.status === 'accepted';
    exact(
      entry,
      accepted
        ? ['status', 'submission', 'processing', 'processingKey', 'candidate']
        : ['status', 'submission', 'processing', 'processingKey', 'rejection'],
      'ledger entry',
    );
    const submission = exact(entry.submission, [
      'submissionId',
      'originalContentHash',
      'ticketId',
      'authorizedPath',
      'origin',
      'originEvidenceDigest',
      'hostPluginId',
      'hostNamespace',
      'normalizerDigest',
      'intakeProfileDigest',
    ], 'submission binding');
    const id = text(submission.submissionId, 'submissionId');
    hash(submission.originalContentHash, 'raw hash');
    text(submission.ticketId, 'ticketId');
    if (
      !['source', 'manifest', 'pluginOwnedTests', 'config'].includes(
        String(submission.authorizedPath),
      )
    ) {
      throw new Error('authorizedPath');
    }
    origin(submission.origin);
    hash(submission.originEvidenceDigest, 'origin evidence digest');
    text(submission.hostPluginId, 'host plugin');
    text(submission.hostNamespace, 'host namespace');
    hash(submission.normalizerDigest, 'normalizer digest');
    hash(submission.intakeProfileDigest, 'profile digest');
    const processing = entry.processing === null ? null : exact(entry.processing, [
      'submissionBindingDigest',
      'proposalDigest',
      'ticketDigest',
      'baseSnapshotDigest',
      'liveContextDigest',
      'provenanceDigest',
      'revisionBudgetDigest',
    ], 'processing');
    if (processing) Object.values(processing).forEach((value) => hash(value, 'processing digest'));
    if (entry.processingKey !== null) hash(entry.processingKey, 'processing key');
    if (accepted) {
      if (!processing || typeof entry.processingKey !== 'string') {
        throw new Error('accepted processing');
      }
      const candidate = exact(entry.candidate, [
        'proposalId',
        'sealedProposalId',
        'ticketDigest',
        'proposalDigest',
        'provenance',
        'resolvedContent',
        'contentHash',
        'revision',
      ], 'candidate');
      hash(candidate.proposalId, 'proposal id');
      hash(candidate.sealedProposalId, 'sealed proposal id');
      hash(candidate.ticketDigest, 'ticket digest');
      hash(candidate.proposalDigest, 'proposal digest');
      const provenance = exact(candidate.provenance, [
        'origin',
        'originalContentHash',
        'normalizerDigest',
        'hostPluginId',
        'hostNamespace',
        'originEvidenceDigest',
      ], 'provenance');
      origin(provenance.origin);
      hash(provenance.originalContentHash, 'provenance raw hash');
      hash(provenance.normalizerDigest, 'provenance normalizer');
      text(provenance.hostPluginId, 'provenance plugin');
      text(provenance.hostNamespace, 'provenance namespace');
      hash(provenance.originEvidenceDigest, 'provenance evidence');
      normalizeDefinitionContent(candidate.resolvedContent);
      hash(candidate.contentHash, 'candidate hash');
      const revision = exact(candidate.revision, [
        'schemaVersion',
        'revisionId',
        'contentHash',
        'baseRevisionId',
        'baseContentHash',
        'provenanceDigest',
        'proposalDigest',
        'ticketDigest',
        'createdAt',
        'revisionDigest',
      ], 'revision');
      if (revision.schemaVersion !== 'definition-revision/v1') throw new Error('revision version');
      if (!/^revision:[0-9a-f]{64}$/.test(text(revision.revisionId, 'revision id'))) {
        throw new Error('revision id');
      }
      hash(revision.contentHash, 'revision content');
      text(revision.baseRevisionId, 'revision base id');
      hash(revision.baseContentHash, 'revision base hash');
      hash(revision.provenanceDigest, 'revision provenance');
      hash(revision.proposalDigest, 'revision proposal');
      hash(revision.ticketDigest, 'revision ticket');
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text(revision.createdAt, 'createdAt'))
      ) {
        throw new Error('createdAt');
      }
      hash(revision.revisionDigest, 'revision digest');
    } else {
      if ((entry.processing === null) !== (entry.processingKey === null)) {
        throw new Error('rejection processing');
      }
      const rejection = exact(entry.rejection, [
        'intakeId',
        'proposalId',
        'ticketId',
        'origin',
        'originalContentHash',
        'stage',
        'code',
        'detailsDigest',
      ], 'rejection');
      text(rejection.intakeId, 'intakeId');
      if (rejection.proposalId !== null) hash(rejection.proposalId, 'rejection proposal');
      if (rejection.ticketId !== null) text(rejection.ticketId, 'rejection ticket');
      origin(rejection.origin);
      hash(rejection.originalContentHash, 'rejection raw hash');
      if (
        !['intake', 'ticket', 'stale', 'scope', 'budget', 'merge', 'seal'].includes(
          String(rejection.stage),
        )
      ) {
        throw new Error('rejection stage');
      }
      text(rejection.code, 'rejection code');
      hash(rejection.detailsDigest, 'rejection details');
    }
    if (ids.has(id)) throw new Error('duplicate ledger submission');
    ids.add(id);
    const size = canonicalBytes(entry).byteLength;
    if (size > INTAKE_LIMITS.maxOutcomeCanonicalBytes) throw new Error('outcome size');
    total += size;
  }
  if (
    total > INTAKE_LIMITS.maxLedgerOutcomeBytes ||
    canonicalBytes(ledger).byteLength > INTAKE_LIMITS.maxLedgerCanonicalBytes
  ) throw new Error('ledger size');
};
