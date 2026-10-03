/**
 * Public API for implementing Henji tools.
 *
 * Henji is a Deno agent harness being developed toward experience-driven
 * self-revision. Agent behavior is configured with JSON files; this package
 * exposes the Worker-local tool factory contract used by external tools.
 *
 * The 0.x API may change incompatibly between releases. The CLI, TUI, Host,
 * persistence, and standalone binary are not package entrypoints or artifacts.
 *
 * Source repository:
 * [littleisland/henji-harness](https://forge.harakara.site/littleisland/henji-harness)
 *
 * @module
 */

export * from './v0/agent/tool_api.ts';
