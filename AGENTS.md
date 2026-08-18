# AGENTS.md

## Current phase

- This repository is in an implementation-spike phase, not v1 development.
- The approved scope is `docs/spikes/model-adapter-task-planner.md`.
- Before implementation, create an implementation plan and stop for Human Gate 2.
- Do not select a provider or model without user confirmation.
- Do not expand the spike into tool execution, plugin self-revision, automatic
  promotion, or a general plugin framework.

## Development lifecycle

- Treat an approved plan as continuing authorization through its next explicit
  human gate. Within that plan, continue through implementation, tests, review,
  and evidence without requesting approval after every slice.
- Obtain explicit user authorization before modifying repository files. A clear
  request such as "implement this plan" is authorization for that scope.
- Classify changes as `local-fix`, `plan-delta`, `concept-review`, or `park`.
- For an unplanned bug, report the cause, evidence, impact, proposed fix, and
  verification before changing it; continue unaffected approved work.
- Stop and return to Discovery when the concept assumptions fail or the approved
  scope must materially change.
- At completion, prepare an acceptance package mapping requirements to direct
  evidence, tests, review results, deviations, and remaining risks.
- Do not release, tag, publish, force-push, alter secrets, or change repository
  settings without explicit human approval.

## Spike safety boundaries

- Run untrusted plugins in separate Deno processes with deny-by-default permissions.
- Keep provider credentials and endpoint resolution in the Supervisor-owned broker.
- Plugin stdout is protocol-only; diagnostics go to stderr.
- Enforce timeout and message/output size limits at the process boundary.
