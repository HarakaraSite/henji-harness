/**
 * Compose executable Agent Definitions for Henji Harness.
 *
 * The name Henji comes from the Japanese word 返事, meaning "reply" or
 * "response."
 *
 * Henji is a Deno agent harness being developed toward experience-driven
 * self-revision. That workflow is not yet implemented. In the intended
 * workflow, an AI may produce a revision candidate when a human asks it to,
 * and only an explicit human action or approval can adopt it.
 *
 * In the current Henji runtime, the Host owns the TUI and headless surfaces,
 * Worker lifecycle, SQLite-backed history, and exact Agent Definition
 * selection for Sessions. A headless Agent Worker evaluates built-in or
 * installed trusted executable TypeScript Definitions and assembles the
 * current model, instructions, tools, and synchronous planner delegation.
 * General Surface replacement, durable AgentInstance revision transitions,
 * and Definition-configurable context and loop components are not yet
 * implemented.
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
 * } from "jsr:@henji/harness@0.4.0";
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
