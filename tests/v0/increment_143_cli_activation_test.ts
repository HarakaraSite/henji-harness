import { deepStrictEqual } from 'node:assert';
import { parseRemoteTuiInvocation } from '../../v0/agent/cli/remote_tui_cli.ts';

Deno.test('Remote CLI sends explicit activation to Core without a local provider catalog', () => {
  deepStrictEqual(
    parseRemoteTuiInvocation([
      '--connect',
      'http://127.0.0.1:5270',
      '--new',
      '--agent',
      'generic',
      '--max-steps',
      '7',
      '--provider-timeout-ms',
      '40000',
      '--root-provider',
      'provider-declared-only-in-core',
    ]),
    {
      url: 'http://127.0.0.1:5270',
      target: { kind: 'new' },
      activation: {
        agent: 'generic',
        maxSteps: 7,
        providerTimeoutMs: 40_000,
        rootProvider: 'provider-declared-only-in-core',
      },
    },
  );
});
