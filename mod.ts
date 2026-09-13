/**
 * Compose executable Agent Definitions for Henji Harness.
 *
 * Henji is a Deno agent harness intended to evolve from experience gathered
 * during ordinary use. An AI may produce a revision candidate when a human
 * asks it to, but a candidate is adopted only through an explicit human
 * action or approval.
 *
 * The Henji Host owns surfaces, lifecycle, storage, and revision bindings. A
 * headless Agent Worker evaluates a trusted executable TypeScript Definition
 * and composes its model, instructions, tools, delegation, context, and loop.
 *
 * This 0.x package is under active development. Its APIs and contracts may
 * change incompatibly between releases, so consumers should pin an exact
 * version. The package exposes only the Definition composition API; the CLI,
 * TUI, Host, persistence, self-revision workflow, and standalone native binary
 * are not JSR package entrypoints or artifacts.
 *
 * Source repository:
 * [littleisland/henji-harness](https://forge.harakara.site/littleisland/henji-harness)
 *
 * @example Define a standard Henji parent agent
 * ```ts
 * import {
 *   createDefaultAgentComposition,
 *   type ExecutableAgentDefinition,
 * } from "jsr:@henji/harness@0.1.1";
 *
 * const definition: ExecutableAgentDefinition = (input) =>
 *   createDefaultAgentComposition(input);
 *
 * export default definition;
 * ```
 *
 * @module
 */

export * from "./v0/agent/worker_agent_api.ts";
