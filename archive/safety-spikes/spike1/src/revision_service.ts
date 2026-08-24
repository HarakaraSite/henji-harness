import { canonicalBytes, contentHash } from '../../spike0/src/canonical_content.ts';
import { normalizeDefinitionContent } from '../../spike0/src/definition_content.ts';
import { projectRevisionView, resolveRevisionView } from '../../spike0/src/revision_view.ts';
import {
  buildProposal,
  normalizeSubmission,
  type SubmissionEnvelopeV1,
} from './definition_proposal.ts';
import type { RevisionIdentityPort } from './definition_revision.ts';
import { domainDigest, rawDigest } from './digests.ts';
import {
  type BoundedSubmissionFrameV1,
  decodeBoundedJson,
  IntakeError,
  isBoundedSubmissionFrame,
} from './intake_json.ts';
import {
  INTAKE_LIMITS,
  MAX_REVISION_BUDGET,
  measureStructureBounded,
  type RevisionBudgetV1,
  utf8Length,
} from './limits.ts';
import { validateScope } from './mutation_scope.ts';
import { NORMALIZER_DIGEST } from './normalizer_identity.ts';
import type { RevisionCounters } from './observability.ts';
import type { IntakeProvenanceV1 } from './provenance.ts';
import {
  validateContextRuntime,
  validateLedgerRuntime,
  validateTicketRuntime,
} from './runtime_schema.ts';
import type { BaseDefinitionSnapshotV1 } from './base_definition_snapshot.ts';
import type { LiveRevisionContextV1 } from './revision_context.ts';
import type { RevisionTicketV1, TicketStoreSnapshot } from './revision_ticket.ts';
import type {
  ProcessingBindingV1,
  ProposalRejectionV1,
  RevisionOutcomeLedgerV1,
  RevisionOutcomeV1,
  RevisionServiceResultV1,
  SubmissionBindingV1,
} from './revision_outcome.ts';

export interface RevisionRequestV1 {
  readonly frame: BoundedSubmissionFrameV1;
  readonly envelope: SubmissionEnvelopeV1;
  readonly tickets: TicketStoreSnapshot;
  readonly base: BaseDefinitionSnapshotV1;
  readonly live: LiveRevisionContextV1;
  readonly ledger: RevisionOutcomeLedgerV1;
}
export interface RevisionDependencies {
  readonly identity: RevisionIdentityPort;
  readonly counters: RevisionCounters;
}

const digest = (domain: string, value: unknown) => domainDigest(`henji/spike1/${domain}/v1`, value);
const same = (a: unknown, b: unknown): boolean => {
  const left = canonicalBytes(a);
  const right = canonicalBytes(b);
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
};
const freeze = <T>(value: T): T => {
  if (ArrayBuffer.isView(value)) return value;
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const cloned = <T>(value: T): T => freeze(structuredClone(value));

const budgetWithinMaximum = (budget: RevisionBudgetV1): boolean =>
  Object.entries(MAX_REVISION_BUDGET).every(([key, maximum]) =>
    key === 'schemaVersion' ||
    (Number.isSafeInteger((budget as unknown as Record<string, unknown>)[key]) &&
      Number((budget as unknown as Record<string, unknown>)[key]) >= 0 &&
      Number((budget as unknown as Record<string, unknown>)[key]) <= Number(maximum))
  );

const append = (
  ledger: RevisionOutcomeLedgerV1,
  outcome: RevisionOutcomeV1,
): RevisionOutcomeLedgerV1 =>
  cloned({ schemaVersion: 'revision-outcome-ledger/v1', entries: [...ledger.entries, outcome] });

export const revise = async (
  requestInput: RevisionRequestV1,
  deps: RevisionDependencies,
): Promise<RevisionServiceResultV1> => {
  if (
    !isBoundedSubmissionFrame(requestInput.frame) ||
    requestInput.frame.bytes.byteLength > INTAKE_LIMITS.maxRawBytes
  ) {
    validateLedgerRuntime(requestInput.ledger);
    const ledger = cloned(requestInput.ledger);
    return {
      status: 'refused',
      refusal: {
        status: 'refused',
        code: 'oversize_input',
        submissionId: null,
        detailsDigest: await digest('service-refusal', {
          code: 'oversize_input',
          submissionId: null,
          details: 'redacted',
        }),
      },
      ledger,
    };
  }
  const request = cloned(requestInput);
  const { ledger, envelope } = request;
  validateLedgerRuntime(ledger);
  const ledgerBytes = canonicalBytes(ledger).byteLength;
  if (
    ledger.entries.length > INTAKE_LIMITS.maxLedgerEntries ||
    ledgerBytes > INTAKE_LIMITS.maxLedgerCanonicalBytes ||
    new Set(ledger.entries.map((entry) => entry.submission.submissionId)).size !==
      ledger.entries.length
  ) throw new Error('invalid ledger snapshot');
  for (
    const id of [
      envelope.submissionId,
      envelope.ticketId,
      envelope.hostPluginId,
      envelope.hostNamespace,
      envelope.normalizerDigest,
    ]
  ) {
    if (utf8Length(id) > INTAKE_LIMITS.maxTrustedIdBytesEach) {
      throw new Error('trusted identifier exceeds limit');
    }
  }
  if (envelope.normalizerDigest !== NORMALIZER_DIGEST) {
    throw new Error('normalizer identity mismatch');
  }
  if (
    canonicalBytes(envelope.originEvidence).byteLength >
      INTAKE_LIMITS.maxOriginEvidenceCanonicalBytes
  ) {
    throw new Error('origin evidence exceeds limit');
  }

  const originalContentHash = await rawDigest('henji/spike1/raw/v1', request.frame.bytes);
  const originEvidenceDigest = await digest('origin-evidence', envelope.originEvidence);
  const intakeProfileDigest = await digest('intake-profile', INTAKE_LIMITS);
  const submission: SubmissionBindingV1 = cloned({
    submissionId: envelope.submissionId,
    originalContentHash,
    ticketId: envelope.ticketId,
    authorizedPath: envelope.authorizedPath,
    origin: envelope.origin,
    originEvidenceDigest,
    hostPluginId: envelope.hostPluginId,
    hostNamespace: envelope.hostNamespace,
    normalizerDigest: envelope.normalizerDigest,
    intakeProfileDigest,
  });
  const previous = ledger.entries.find((entry) =>
    entry.submission.submissionId === submission.submissionId
  );
  if (previous) {
    if (same(previous.submission, submission)) {
      return { status: 'replayed', outcome: previous, ledger };
    }
    return {
      status: 'refused',
      refusal: {
        status: 'refused',
        code: 'submission_conflict',
        submissionId: submission.submissionId,
        detailsDigest: await digest('service-refusal', {
          code: 'submission_conflict',
          submissionId: submission.submissionId,
          details: 'redacted',
        }),
      },
      ledger,
    };
  }
  const outcomeTotal = ledger.entries.reduce((n, entry) => n + canonicalBytes(entry).byteLength, 0);
  if (
    ledger.entries.length + 1 > INTAKE_LIMITS.maxLedgerEntries ||
    outcomeTotal + INTAKE_LIMITS.maxOutcomeCanonicalBytes > INTAKE_LIMITS.maxLedgerOutcomeBytes
  ) {
    return {
      status: 'refused',
      refusal: {
        status: 'refused',
        code: 'ledger_capacity',
        submissionId: submission.submissionId,
        detailsDigest: await digest('service-refusal', {
          code: 'ledger_capacity',
          submissionId: submission.submissionId,
          details: 'redacted',
        }),
      },
      ledger,
    };
  }

  let proposalId: string | null = null;
  let processing: ProcessingBindingV1 | null = null;
  let processingKey: string | null = null;
  const reject = async (
    stage: ProposalRejectionV1['stage'],
    code: string,
  ): Promise<RevisionServiceResultV1> => {
    const rejection: ProposalRejectionV1 = {
      intakeId: submission.submissionId,
      proposalId,
      ticketId: envelope.ticketId,
      origin: envelope.origin,
      originalContentHash,
      stage,
      code,
      detailsDigest: await digest('rejection-details', { stage, code }),
    };
    const outcome: RevisionOutcomeV1 = cloned({
      status: 'rejected',
      submission,
      processing,
      processingKey,
      rejection,
    });
    const next = append(ledger, outcome);
    return { status: 'recorded', outcome, ledger: next };
  };

  let decoded: unknown;
  try {
    decoded = decodeBoundedJson(request.frame, INTAKE_LIMITS);
  } catch (error) {
    return await reject('intake', error instanceof IntakeError ? error.code : 'decode_failed');
  }
  let preliminary;
  try {
    preliminary = normalizeSubmission(decoded, MAX_REVISION_BUDGET);
  } catch {
    return await reject('intake', 'submission_invalid');
  }

  deps.counters.ticketLookup++;
  const ticket: RevisionTicketV1 | undefined = request.tickets.tickets[envelope.ticketId];
  if (!ticket) {
    return await reject('ticket', 'invalid_ticket');
  }
  try {
    validateTicketRuntime(ticket);
  } catch {
    return await reject('ticket', 'invalid_ticket_schema');
  }
  if (ticket.ticketId !== envelope.ticketId) {
    return await reject('ticket', 'ticket_identity_mismatch');
  }
  try {
    validateContextRuntime(request.base, request.live);
  } catch {
    return await reject('ticket', 'invalid_base_context_schema');
  }
  if (!budgetWithinMaximum(ticket.budget)) return await reject('ticket', 'invalid_ticket_budget');
  if (
    canonicalBytes(ticket).byteLength > INTAKE_LIMITS.maxTicketCanonicalBytes ||
    [ticket.admissionProfile, ticket.policyVersion].some((value) =>
      utf8Length(value) > INTAKE_LIMITS.maxTrustedMetadataBytesEach
    )
  ) return await reject('ticket', 'ticket_size');
  try {
    normalizeSubmission(decoded, ticket.budget);
  } catch {
    return await reject('budget', 'ticket_budget');
  }
  const submissionDigest = await digest('submission-binding', submission);
  proposalId = await digest('proposal-id', {
    submissionBindingDigest: submissionDigest,
    submission: preliminary,
  });
  const proposal = buildProposal(preliminary, envelope, proposalId);
  const proposalDigest = await digest('proposal', proposal);
  const ticketDigest = await digest('ticket', ticket);
  const { content: _content, ...baseMetadata } = request.base;
  const baseSnapshotDigest = await digest('base-snapshot', baseMetadata);
  const liveContextDigest = await digest('live-context', request.live);
  const provenance: IntakeProvenanceV1 = cloned({
    origin: envelope.origin,
    originalContentHash,
    normalizerDigest: envelope.normalizerDigest,
    hostPluginId: envelope.hostPluginId,
    hostNamespace: envelope.hostNamespace,
    originEvidenceDigest,
  });
  const provenanceDigest = await digest('provenance', provenance);
  const revisionBudgetDigest = await digest('revision-budget', ticket.budget);
  processing = cloned({
    submissionBindingDigest: submissionDigest,
    proposalDigest,
    ticketDigest,
    baseSnapshotDigest,
    liveContextDigest,
    provenanceDigest,
    revisionBudgetDigest,
  });
  processingKey = await digest('processing', processing);

  if (
    ticket.exactBase.revisionId !== request.base.revisionId ||
    ticket.exactBase.contentHash !== request.base.contentHash ||
    ticket.target.pluginId !== request.base.target.pluginId ||
    ticket.target.namespace !== request.base.target.namespace ||
    ticket.target.kind !== request.base.target.kind ||
    request.live.baseRevisionId !== ticket.exactBase.revisionId ||
    request.live.baseContentHash !== ticket.exactBase.contentHash ||
    request.live.deploymentStateDigest !== ticket.exactBase.deploymentStateDigest ||
    request.live.policyVersion !== ticket.policyVersion ||
    envelope.hostPluginId !== ticket.target.pluginId ||
    envelope.hostNamespace !== ticket.target.namespace
  ) return await reject('stale', 'exact_base_mismatch');
  try {
    validateScope(ticket, proposal);
  } catch {
    return await reject('scope', 'scope');
  }
  if (
    canonicalBytes(proposal.mutation.value).byteLength > ticket.budget.maxReplacementCanonicalBytes
  ) return await reject('budget', 'replacement');
  if (
    proposal.mutation.path === 'pluginOwnedTests' &&
    (!Array.isArray(proposal.mutation.value) ||
      proposal.mutation.value.length > ticket.budget.maxPluginOwnedTests)
  ) return await reject('budget', 'plugin_owned_tests');
  if (proposal.mutation.path === 'config') {
    try {
      measureStructureBounded(
        proposal.mutation.value,
        ticket.budget.maxConfigDepth,
        ticket.budget.maxConfigEntries,
      );
    } catch {
      return await reject('budget', 'config_structure');
    }
  }

  let baseMeasure;
  try {
    baseMeasure = measureStructureBounded(
      request.base.content,
      INTAKE_LIMITS.maxBaseDepth,
      INTAKE_LIMITS.maxBaseEntries,
    );
  } catch {
    return await reject('budget', 'base_structure');
  }
  if (request.base.resourceProfileDigest !== intakeProfileDigest) {
    return await reject('budget', 'base_profile');
  }
  if (
    request.base.structuralDepth !== baseMeasure.depth ||
    request.base.structuralEntryCount !== baseMeasure.entries ||
    baseMeasure.depth > INTAKE_LIMITS.maxBaseDepth ||
    baseMeasure.entries > INTAKE_LIMITS.maxBaseEntries
  ) return await reject('budget', 'base_structure');
  const base = normalizeDefinitionContent(request.base.content);
  deps.counters.hash++;
  const actualBaseHash = await contentHash(base);
  const baseBytes = canonicalBytes(base).byteLength;
  if (
    baseBytes !== request.base.canonicalByteCount ||
    baseBytes > INTAKE_LIMITS.maxBaseCanonicalBytes || actualBaseHash !== request.base.contentHash
  ) return await reject('stale', 'base_snapshot');
  if (
    ticket.target.pluginId !== base.identity.pluginId ||
    ticket.target.namespace !== base.identity.namespace
  ) return await reject('stale', 'base_identity');

  const view = projectRevisionView(base) as unknown as Record<string, unknown>;
  view[proposal.mutation.path] = structuredClone(proposal.mutation.value);
  deps.counters.merge++;
  let resolved;
  try {
    resolved = await resolveRevisionView(base, ticket.exactBase.contentHash, view);
  } catch {
    return await reject('merge', 'resolution');
  }
  const resolvedBytes = canonicalBytes(resolved).byteLength;
  if (resolvedBytes > ticket.budget.maxResolvedCanonicalBytes) {
    return await reject('budget', 'resolved');
  }
  const resolvedHash = await contentHash(resolved);
  const sealedProposalId = await digest('sealed-proposal', {
    proposalDigest,
    ticketDigest,
    baseSnapshotDigest,
    liveContextDigest,
    provenanceDigest,
    contentHash: resolvedHash,
  });
  deps.counters.id++;
  const revisionId = deps.identity.issueRevisionId();
  deps.counters.clock++;
  const createdAt = deps.identity.now();
  if (
    !/^revision:[0-9a-f]{64}$/.test(revisionId) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt)
  ) throw new Error('trusted identity port violated its contract');
  const revisionWithoutDigest = {
    schemaVersion: 'definition-revision/v1' as const,
    revisionId,
    contentHash: resolvedHash,
    baseRevisionId: request.base.revisionId,
    baseContentHash: request.base.contentHash,
    provenanceDigest,
    proposalDigest,
    ticketDigest,
    createdAt,
  };
  const revision = {
    ...revisionWithoutDigest,
    revisionDigest: await digest('revision', revisionWithoutDigest),
  };
  const candidate = cloned({
    proposalId,
    sealedProposalId,
    ticketDigest,
    proposalDigest,
    provenance,
    resolvedContent: resolved,
    contentHash: resolvedHash,
    revision,
  });
  const outcome: RevisionOutcomeV1 = cloned({
    status: 'accepted',
    submission,
    processing,
    processingKey,
    candidate,
  });
  if (canonicalBytes(outcome).byteLength > INTAKE_LIMITS.maxOutcomeCanonicalBytes) {
    throw new Error('reserved outcome bound violated');
  }
  const next = append(ledger, outcome);
  if (canonicalBytes(next).byteLength > INTAKE_LIMITS.maxLedgerCanonicalBytes) {
    throw new Error('reserved ledger bound violated');
  }
  return { status: 'recorded', outcome, ledger: next };
};
