# Repeatable personal basic Harness local results

## Scope and gate

- Plan: `docs/repeatable-personal-basic-harness-plan.md` (Revision 8 / H-016)
- Scope: Increment 0–3 local implementation and offline verification only
- Environment: ai-dev guest, Deno 2.9.4 configured by `deno.v0.json`
- Real provider, credential lookup for acceptance, external write, attempt/state operation, commit,
  push, release, and acceptance were not performed.

## Requirements to evidence

| Requirement | Direct evidence |
| --- | --- |
| One-command basic interface | `v0/cli/main.ts` dispatches `basic run --task ... --confirm-external-call` |
| One request, retry 0, no continuation/tool dispatch | `basicOpenRouterModel` uses the shared single-fetch primitive; basic CLI invokes its model seam once; tests cover request count and passive tool-shaped response |
| State/extension/attempt/budget independence | Basic execution path does not call state, runner, extension, or attempt APIs; test passes an unused state path and verifies no directory is created |
| Finite input/output/time | Existing 76 KiB message, 256 KiB request, 1 MiB response, and 30-second provider bounds are shared; basic task/context/constraint byte validation and tests are present |
| Credential and request boundary | Host environment or local dummy injection is the only credential source; fixed URL/body and redirect rejection are retained; tests inspect authorization separately and verify response/error serialization does not include the dummy value |
| Passive raw response and optional parse | Terminal output includes `responseText`, `parse`, `requestCount`, `durationMs`, and `outcome`; non-Plan output remains exit-0 raw data |
| Repeatability after failure | Offline test runs a failed command followed by a successful independent command with no recovery state |

## Offline verification

- `deno task --config deno.v0.json v0:gate`: passed (`check`, `fmt`, `lint`, 29 tests)
- `git diff --check`: passed
- Test suite includes 31 tests after the follow-up P2 fixes; no provider endpoint was contacted.

## Follow-up review fixes

- P2-1: `v0/cli/main.ts` now performs one structural option parse for `basic run`; missing values or
  flag-shaped values for task/context/constraints fail before model invocation. Focused regressions
  confirm request count 0.
- P2-2: a network-free fetch spy covers the production default fixed URL, `redirect: 'error'`,
  Authorization-only dummy placement, and sanitized non-2xx failure without reading credentials or
  contacting a provider.

## Acceptance boundary and remaining risk

Real provider acceptance is intentionally not included in this handoff. The follow-up review findings
were limited to the two P2 fixes above; the next gate must inspect the scoped diff, then a separately authorized human acceptance may run
at most the planned basic commands. Trusted-local remains a same-user trust assumption rather than
a general untrusted-code sandbox or production security guarantee.
