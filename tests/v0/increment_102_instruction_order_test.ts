import { HENJI_COMMON_INSTRUCTION } from '../../v0/agent/instructions/henji_common.ts';
import { PLANNER_AGENT_INSTRUCTION } from '../../v0/agent/instructions/roles/planner.ts';
import {
  builtinHenjiBaseInstruction,
  verifyBuiltinHenjiBaseInstructionIdentity,
} from '../../v0/agent/instructions/managed_instruction.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

Deno.test('Increment 102 common instruction requires configuration-first ordering', () => {
  assert(
    HENJI_COMMON_INSTRUCTION.includes(
      'Before changing implementation, check whether the request can be satisfied by existing configuration, declaration, or data.',
    ),
  );
  assert(
    HENJI_COMMON_INSTRUCTION.includes(
      'first obtain the external contract from official documentation and confirm which existing extension point covers it.',
    ),
  );
  assert(
    HENJI_COMMON_INSTRUCTION.includes(
      'Investigate implementation internals only when the external contract cannot be met through existing configuration, or when the user asks about the implementation.',
    ),
  );
  assert(
    HENJI_COMMON_INSTRUCTION.includes(
      'Prefer the smallest change that satisfies the request.',
    ),
  );
});

Deno.test('Increment 102 planner role is limited to the smallest sufficient change', () => {
  assert(
    PLANNER_AGENT_INSTRUCTION.includes(
      'Inspect only the workspace context needed to decide the smallest sufficient change for the task',
    ),
  );
  assert(!PLANNER_AGENT_INSTRUCTION.includes('Inspect the available workspace context needed'));
});

Deno.test('Increment 102 built-in instruction identity matches the revised content', async () => {
  assert(await verifyBuiltinHenjiBaseInstructionIdentity());
  const builtin = builtinHenjiBaseInstruction();
  assert(builtin.content === HENJI_COMMON_INSTRUCTION);
  assert(builtin.content.includes('Prefer the smallest change that satisfies the request.'));
});
