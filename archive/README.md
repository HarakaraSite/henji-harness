# Archive

This directory contains inactive historical material retained for provenance and rollback context.
Nothing here is part of the current `v0` build, test, or runtime path.

- `legacy-two-plugin/`: the stopped pre-v0 `src/`, `plugins/`, non-v0 tests, and root Deno config.
- `safety-spikes/`: Spike 0–2 implementations, tests, configs, bootstrap script, and evidence.
- `history/`: superseded plans, results, delivered inputs, and former requirement labels such as FR5
  that remain only as implementation and acceptance evidence.

Current product direction is defined by `docs/concepts/`, `docs/architecture/`, and `docs/roadmap.md`.
Active implementation and command authority are `v0/` and `deno.v0.json`; `.handoff/handoff.md` only
maintains resumption state. Archived files must not be imported, executed, or treated as current
requirements unless a later explicit decision restores them.
