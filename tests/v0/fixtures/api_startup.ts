import type { ApiStartupView } from '../../../v0/api/contract.ts';

/** Complete public startup value for remote TUI HTTP fixtures. */
export const apiStartupFixture = (overrides: Partial<ApiStartupView> = {}): ApiStartupView => ({
  status: 'evaluated',
  productVersion: '0.1.0',
  workspace: '/tmp/remote-workspace',
  agentId: 'default',
  model: {
    provider: 'openrouter-responses',
    profileId: 'test',
    modelId: 'test/model',
    effort: 'high',
  },
  sessionMode: { kind: 'exact' },
  instructions: { loaded: false, source: 'none' },
  skills: { count: 0, names: [], omitted: 0 },
  trust: { hardSandbox: false, osUserTools: ['bash', 'edit', 'write'] },
  credentialVerification: 'before_each_provider_request',
  ...overrides,
});
