# AGENTS current-phase archive through 024071a

The historical `AGENTS.md` current-phase ledger through commit `024071a` remains available with:

```sh
git show 024071a:AGENTS.md
```

The durable policy is maintained in `AGENTS.md`. The accumulated handoff checkpoints were preserved
in [the handoff archive through 2026-09-26](handoff-through-2026-09-26.md); `.handoff/handoff.md`
now holds only the current resumption state. The ledger was removed from the active agent
instruction file on 2026-09-02 because its accumulated test counts, review closures, and gate
history were no longer current instructions and were anchoring planning, implementation, and review
on verification machinery instead of product behavior.

This archive is historical only. It does not define current requirements or authorization.
