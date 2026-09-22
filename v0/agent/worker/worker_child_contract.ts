import type { AsyncAgentTerminalState } from '../tools/async_agents.ts';

export interface ChildCleanupRunObservationV1 {
  readonly runId: string;
  readonly state: AsyncAgentTerminalState;
  readonly durability: 'yes' | 'failed';
  readonly error?: string;
}

export interface ChildCleanupObservationV1 {
  readonly schemaVersion: 1;
  readonly runs: readonly ChildCleanupRunObservationV1[];
}
