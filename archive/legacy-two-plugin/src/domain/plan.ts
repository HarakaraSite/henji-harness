import { error, type HarnessError } from './errors.ts';

export interface PlanInput {
  readonly task: string;
  readonly context?: string;
  readonly constraints?: readonly string[];
}

export interface PlanStep {
  readonly id: string;
  readonly description: string;
}

export interface Plan {
  readonly status: 'planned';
  readonly steps: readonly PlanStep[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parsePlan = (value: unknown): Plan | HarnessError => {
  if (!isRecord(value) || value.status !== 'planned' || !Array.isArray(value.steps)) {
    return error('invalid_plan', 'plan requires status "planned" and a steps array');
  }
  for (const step of value.steps) {
    if (
      !isRecord(step) || typeof step.id !== 'string' || step.id.length === 0 ||
      typeof step.description !== 'string' || step.description.length === 0
    ) {
      return error('invalid_plan', 'each plan step requires non-empty id and description strings');
    }
  }
  return { status: 'planned', steps: value.steps as PlanStep[] };
};
