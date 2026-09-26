import {
  createAgentResourceIdentity,
  createDefaultAgentComposition,
  type ExecutableAgentDefinition,
} from '@henji/agent';

/** A real Worker tool exercises the supplied physical seam without provider requests. */
const definition: ExecutableAgentDefinition = (input) => {
  const composition = createDefaultAgentComposition({
    ...input,
    physicalIo: {
      ...input.physicalIo,
      createModel: () => ({
        generate: (request) => {
          const last = request.transcript.at(-1)!;
          if (last.role === 'tool') {
            return Promise.resolve({ kind: 'final', text: 'process probe finished' });
          }
          const task = [...request.transcript].reverse().find((message) => message.role === 'user');
          if (task?.content.kind !== 'text') throw new Error('missing probe task');
          return Promise.resolve({
            kind: 'tool_calls',
            calls: [{
              callId: 'process-probe',
              name: 'process_probe',
              arguments: { mode: task.content.text },
            }],
          });
        },
      }),
    },
    toolDefinitions: [{
      identity: createAgentResourceIdentity('tool:process_probe'),
      materialize: (bindings) => ({
        name: 'process_probe',
        description: 'Increment 133 physical lifetime probe',
        inputSchema: { type: 'object' },
        execute: async (args, context) => {
          if (typeof args !== 'object' || args === null || Array.isArray(args)) {
            throw new Error('missing mode');
          }
          const mode = (args as { mode: string }).mode;
          if (mode === 'answer') return 'no process';
          const executor = bindings.processExecutor!;
          const background = mode === 'background';
          const operation = executor.start({
            executable: '/bin/bash',
            args: [
              '--noprofile',
              '--norc',
              '-c',
              background
                ? 'sleep 60 & printf "%s" $! > pid; printf raw-process-stdout; printf raw-process-stderr >&2'
                : "trap '' TERM; printf '%s' $$ > pid; while :; do sleep 10; done",
            ],
            cwd: bindings.workspace.root,
            env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
          }, { callId: context !== undefined && 'callId' in context ? context.callId : undefined });
          if (background) {
            await operation.status;
            await Promise.all([operation.stdout.cancel(), operation.stderr.cancel()]);
            await operation.release();
            return 'background retained';
          }
          await operation.status;
          await Promise.all([operation.stdout.cancel(), operation.stderr.cancel()]);
          // Deliberately ignore cooperative cancellation so Host replacement must own cleanup.
          if (mode !== 'cancellable') await new Promise<void>(() => {});
          return 'unreachable';
        },
      }),
    }],
  }, { tools: [createAgentResourceIdentity('tool:process_probe')] });
  return composition;
};
export default definition;
