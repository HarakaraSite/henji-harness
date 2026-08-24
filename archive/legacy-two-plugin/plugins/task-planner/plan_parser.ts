export interface Plan {
  readonly status: 'planned';
  readonly steps: readonly { readonly id: string; readonly description: string }[];
}
export interface HarnessError {
  readonly code: 'planner_output_invalid';
  readonly message: string;
}
const error = (message: string): HarnessError => ({ code: 'planner_output_invalid', message });

export const parsePlannerOutput = (text: string): Plan | HarnessError => {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value !== 'object' || value === null ||
      !Array.isArray((value as Record<string, unknown>).steps) ||
      (value as Record<string, unknown>).status !== 'planned'
    ) return error('model output is not valid Plan JSON');
    for (const step of (value as Record<string, unknown>).steps as unknown[]) {
      if (
        typeof step !== 'object' || step === null ||
        typeof (step as Record<string, unknown>).id !== 'string' ||
        !(step as Record<string, unknown>).id ||
        typeof (step as Record<string, unknown>).description !== 'string' ||
        !(step as Record<string, unknown>).description
      ) return error('model output is not valid Plan JSON');
    }
    return value as Plan;
  } catch {
    return error('model output is not valid Plan JSON');
  }
};
