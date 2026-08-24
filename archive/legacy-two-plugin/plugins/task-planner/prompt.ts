export interface PlanInput {
  readonly task: string;
  readonly context?: string;
  readonly constraints?: readonly string[];
}

export const createPlanPrompt = (input: PlanInput): string => {
  const context = input.context ? `\nContext: ${input.context}` : '';
  const constraints = input.constraints?.length
    ? `\nConstraints: ${input.constraints.join('; ')}`
    : '';
  return `Return only JSON with {"status":"planned","steps":[{"id":"...","description":"..."}]}.\nTask: ${input.task}${context}${constraints}`;
};
