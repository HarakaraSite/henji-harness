# Built-in instructions

This directory owns the source components used to build the system instruction for Henji's built-in
agents.

The canonical composition order is implemented in `compose.ts`: Henji common, agent role, active
tool guidelines, workspace instruction, skill manifest, then runtime facts. `roles/` keeps
agent-specific policy separate from the shared Henji text. `runtime_facts.ts` currently contributes
only the canonical current working directory.

Project instructions are discovered only from `AGENTS.md` (or the compatibility spelling
`AGENTS.MD`) at the workspace root. There is no Henji-global AGENTS file.

These TypeScript sources are directly editable in the development launcher. A future standalone
executable may embed them and require rebuild/reinstall; revision, replacement, rollback, and
self-modification are separate roadmap work.
