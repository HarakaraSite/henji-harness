import {
  createAgentResourceIdentity,
  type ExecutableToolDefinition,
  type ToolComponent,
} from '../worker_agent_api.ts';
import { createWebSearchTool, OpenRouterSonarWebSearchBackend } from '../tools/web_search.ts';

const identity = createAgentResourceIdentity('tool:web_search');

/**
 * Bundled web_search tool Definition. It uses the Worker-local provider request seam for the
 * Sonar route; provider-free compositions supply their own backend binding.
 */
const definition: ExecutableToolDefinition = (input) => {
  const requestProvider = input.physicalIo.requestProvider;
  const component: ToolComponent = {
    identity,
    materialize(bindings) {
      if (bindings.webSearchBackend !== undefined) {
        return createWebSearchTool(bindings.webSearchBackend);
      }
      if (requestProvider === undefined) {
        throw new Error('web search provider request seam is unavailable');
      }
      return createWebSearchTool(new OpenRouterSonarWebSearchBackend({ requestProvider }));
    },
  };
  return component;
};

export default definition;
