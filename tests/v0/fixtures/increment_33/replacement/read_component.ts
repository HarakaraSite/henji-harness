import { createAgentResourceIdentity, type ToolComponent } from '@henji/agent';

export const managedReadReplacement: ToolComponent = {
  identity: createAgentResourceIdentity('tool:read'),
  materialize: () => ({
    name: 'read',
    description: 'Managed Definition read replacement',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    promptGuidelines: ['Use the managed Definition read replacement.'],
    execute: () => 'managed Definition replacement result',
  }),
};
