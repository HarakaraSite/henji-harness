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
 * This pre-release package exposes only the Definition composition API. The
 * development CLI, TUI, Host, persistence, and self-revision workflow are not
 * package entrypoints. APIs may change before the first stable release.
 *
 * @example Define a standard Henji parent agent
 * ```ts
 * import {
 *   createDefaultAgentComposition,
 *   type ExecutableAgentDefinition,
 * } from "jsr:@henji/harness";
 *
 * const definition: ExecutableAgentDefinition = (input) =>
 *   createDefaultAgentComposition(input);
 *
 * export default definition;
 * ```
 *
 * @module
 */

export * from './v0/agent/worker_agent_api.ts';
