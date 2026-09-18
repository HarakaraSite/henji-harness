import type { AgentResourceIdentity } from '../definitions/resource_identity.ts';
import type { Tool } from './tools.ts';
import type { Workspace, WorkToolSeams } from './work_tools.ts';
import type { BashOutputStore } from './bash_output.ts';
import type { WebSearchBackend } from './web_search.ts';

/** Worker-local runtime values supplied when one selected tool Definition becomes a Tool. */
export interface ToolComponentBindings {
  readonly workspace: Workspace;
  readonly workTools: WorkToolSeams;
  readonly bashOutputStore: BashOutputStore;
  readonly webSearchBackend?: WebSearchBackend;
}

/** Executable tool component. Functions stay inside the Worker and never enter manifests. */
export interface ToolComponent {
  readonly identity: AgentResourceIdentity;
  materialize(bindings: ToolComponentBindings): Tool;
}
