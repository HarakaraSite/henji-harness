import { assertEquals, assertStringIncludes } from '@std/assert';
import { parsePlannerOutput } from '../../plugins/task-planner/plan_parser.ts';
import { createPlanPrompt } from '../../plugins/task-planner/prompt.ts';

Deno.test('planner prompt contains task, context, and constraints without provider data', () => {
  const prompt = createPlanPrompt({
    task: 'Write a plan',
    context: 'Repository',
    constraints: ['No tools'],
  });
  assertStringIncludes(prompt, 'Task: Write a plan');
  assertStringIncludes(prompt, 'Context: Repository');
  assertStringIncludes(prompt, 'Constraints: No tools');
});

Deno.test('planner parses valid Plan JSON and rejects malformed output', () => {
  assertEquals(parsePlannerOutput('{"status":"planned","steps":[]}'), {
    status: 'planned',
    steps: [],
  });
  assertEquals(parsePlannerOutput('not-json'), {
    code: 'planner_output_invalid',
    message: 'model output is not valid Plan JSON',
  });
});
