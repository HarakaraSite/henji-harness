import type { ProcessExecutor } from './runtime/process_contract.ts';
import type { Workspace, WorkToolSeams } from './tools/work_tools.ts';
import type { BashOutputStore } from './tools/bash_output.ts';
import type { WebSearchBackend } from './tools/web_search.ts';
import type { AuthProfileId, CredentialAvailabilityStatus } from './provider/model_selection.ts';
import type { SkillCatalog } from './definitions/skills.ts';
import type { ProviderRequestFn } from './provider/auxiliary_request.ts';
import type { Tool } from './tools/tools.ts';

export const TOOL_API_CONTRACT = 'henji-tool/v1';

/** All runtime values are Worker-local. A factory runs once at Worker startup. */
export interface ToolFactoryInput {
  readonly processExecutor?: ProcessExecutor;
  readonly workspace: Workspace;
  readonly workTools: WorkToolSeams;
  readonly bashOutputStore: BashOutputStore;
  readonly webSearchBackend?: WebSearchBackend;
  readonly skillCatalog: SkillCatalog;
  readonly requestProvider?: ProviderRequestFn;
  readonly credentialAvailability?: (
    authProfile: AuthProfileId,
    registrationId?: string | null,
  ) => Promise<CredentialAvailabilityStatus>;
}

/** External module default export. Loading never calls the returned Tool.execute. */
export type ToolFactory = (input: ToolFactoryInput) => Tool | PromiseLike<Tool>;

export { type Tool, type ToolContext, ToolInputError } from './tools/tools.ts';
export type { JsonValue, ToolExecutionResult } from './core/contracts.ts';
export type {
  ProcessCommand,
  ProcessExecutor,
  ProcessOperation,
} from './runtime/process_contract.ts';
export type { Workspace } from './tools/work_tools.ts';
export type { ProviderRequestFn } from './provider/auxiliary_request.ts';
