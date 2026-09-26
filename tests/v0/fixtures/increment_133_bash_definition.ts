import {
  createAgentResourceIdentity,
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from '@henji/agent';

/** Deterministic model; tool components are the production bundled bash and bash_output. */
const definition: ExecutableAgentDefinition = (input) =>
  createDefaultAgentComposition({
    ...input,
    physicalIo: {
      ...input.physicalIo,
      createModel: () => ({
        generate: (request) => {
          const last = request.transcript.at(-1)!;
          if (last.role === 'tool') {
            return Promise.resolve({ kind: 'final', text: last.content[0].text });
          }
          const task = [...request.transcript].reverse().find((message) => message.role === 'user');
          if (task?.content.kind !== 'text') throw new Error('missing bash probe task');
          const call = JSON.parse(task.content.text);
          return Promise.resolve({
            kind: 'tool_calls',
            calls: [{ callId: 'bash-probe', ...call }],
          });
        },
      }),
    },
  }, { tools: ['tool:bash', 'tool:bash_output'].map(createAgentResourceIdentity) });
export default definition;
