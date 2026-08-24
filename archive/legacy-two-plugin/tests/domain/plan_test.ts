import { assertEquals } from '@std/assert';
import { parsePlan } from '../../src/domain/plan.ts';

Deno.test('parsePlan accepts a planned plan with steps', () => {
  assertEquals(
    parsePlan({ status: 'planned', steps: [{ id: 'one', description: 'Inspect input' }] }),
    {
      status: 'planned',
      steps: [{ id: 'one', description: 'Inspect input' }],
    },
  );
});

Deno.test('parsePlan rejects invalid step shapes', () => {
  assertEquals(
    parsePlan({ status: 'planned', steps: [{ id: '', description: 'Inspect input' }] }),
    {
      code: 'invalid_plan',
      message: 'each plan step requires non-empty id and description strings',
    },
  );
});
