import type { ToolFactory } from '../../../v0/agent/tool_api.ts';

/** External JSON-configured tool for exercising Host-owned physical process lifetime. */
const processProbe: ToolFactory = (input) => ({
  name: 'process_probe',
  fileAccess: 'unmanaged' as const,
  description: 'Increment 133 physical process lifetime probe',
  inputSchema: { type: 'object', properties: { mode: { type: 'string' } } },
  execute: async (value, context) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('missing mode');
    }
    const mode = (value as { readonly mode?: unknown }).mode;
    if (typeof mode !== 'string') throw new Error('missing mode');
    if (mode === 'answer') return 'process probe finished';
    const executor = input.processExecutor;
    if (executor === undefined) {
      throw new Error('process executor is unavailable');
    }
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
      cwd: input.workspace.root,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    }, {
      callId: context !== undefined && 'callId' in context ? context.callId : undefined,
    });
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
});

export default processProbe;
