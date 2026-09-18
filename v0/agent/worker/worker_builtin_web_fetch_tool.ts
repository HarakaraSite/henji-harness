import {
  createAgentResourceIdentity,
  type ExecutableToolDefinition,
  type ToolComponent,
} from '../worker_agent_api.ts';
import { createWebFetchTool } from '../tools/web_fetch.ts';

const identity = createAgentResourceIdentity('tool:web_fetch');

/** Bundled web_fetch tool Definition using the Worker's http/https net permission. */
const definition: ExecutableToolDefinition = () => {
  const component: ToolComponent = {
    identity,
    materialize: () => createWebFetchTool(),
  };
  return component;
};

export default definition;
