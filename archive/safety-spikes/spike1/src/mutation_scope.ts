import type { RevisionTicketV1 } from './revision_ticket.ts';
import type { DefinitionProposalV1 } from './definition_proposal.ts';
import { utf8Length } from './limits.ts';

export const validateScope = (ticket: RevisionTicketV1, proposal: DefinitionProposalV1): void => {
  if (
    ticket.mutationKind !== 'full-replacement' || proposal.mutation.kind !== ticket.mutationKind
  ) throw new Error('mutation kind rejected');
  if (ticket.allowedPaths.length !== 1 || ticket.allowedPaths[0] !== proposal.mutation.path) {
    throw new Error('scope rejected');
  }
  if (
    ticket.evidenceScope.length > 32 ||
    new Set(ticket.evidenceScope).size !== ticket.evidenceScope.length
  ) throw new Error('ticket evidence scope rejected');
  for (const ref of proposal.evidenceRefs) {
    if (!ticket.evidenceScope.includes(ref)) throw new Error('evidence scope rejected');
  }
  if (ticket.evidenceScope.reduce((n, v) => n + utf8Length(v), 0) > 4_096) {
    throw new Error('ticket evidence scope budget');
  }
};
