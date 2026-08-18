# Henji Harness

Henji Harness is a self-revising agent harness for Deno.

This repository begins with a deliberately narrow implementation spike for two
TypeScript plugins:

- `model-adapter`
- `task-planner`

The approved spike brief is stored in
[`docs/spikes/model-adapter-task-planner.md`](docs/spikes/model-adapter-task-planner.md).

The spike tests process isolation, the host/model-broker boundary, and the
planner/plugin protocol. It is not yet a v1 implementation or proof of
self-revision.
