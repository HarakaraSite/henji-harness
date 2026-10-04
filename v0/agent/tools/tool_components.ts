import type { ProcessExecutor } from '../runtime/process_contract.ts';
import type { AgentResourceIdentity } from '../definitions/resource_identity.ts';
import type { Tool } from './tools.ts';
import type { Workspace, WorkToolSeams } from './work_tools.ts';
import type { BashOutputStore } from './bash_output.ts';

/** Worker-local runtime values supplied when one selected tool Definition becomes a Tool. */
export interface ToolComponentBindings {
  readonly processExecutor?: ProcessExecutor;
  readonly workspace: Workspace;
  readonly workTools: WorkToolSeams;
  readonly bashOutputStore: BashOutputStore;
}

/** Executable tool component. Functions stay inside the Worker and never enter manifests. */
export interface ToolComponent {
  readonly identity: AgentResourceIdentity;
  materialize(bindings: ToolComponentBindings): Tool;
}
