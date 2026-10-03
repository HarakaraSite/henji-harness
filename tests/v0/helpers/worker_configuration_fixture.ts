import { bundledAgentConfiguration } from '../../../v0/agent/configuration/agent_configuration.ts';
import type { WorkerConfigurationSnapshot } from '../../../v0/agent/worker/worker_configuration.ts';

/** Data-port fixture. Composition itself is verified through actual Workers in Increment 181. */
export const workerConfigurationFixture = (
  overrides: Partial<WorkerConfigurationSnapshot> = {},
): WorkerConfigurationSnapshot => ({
  schemaVersion: 1,
  configurationId: crypto.randomUUID(),
  agent: bundledAgentConfiguration().configuration,
  source: { kind: 'bundled' },
  systemInstruction: 'Data-port fixture instruction',
  instructionComponents: [],
  tools: [],
  rejections: [],
  ...overrides,
});
