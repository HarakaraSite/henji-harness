import { HENJI_COMMON_INSTRUCTION } from '../../v0/agent/instructions/henji_common.ts';
import {
  type BaseInstructionFileSystem,
  builtinHenjiBaseInstruction,
  HENJI_BASE_INSTRUCTION_FILE_ID,
  HenjiInstructionError,
  resolveHenjiBaseInstruction,
  verifyBuiltinHenjiBaseInstructionIdentity,
  verifySelectedHenjiBaseInstruction,
} from '../../v0/agent/instructions/base_instruction.ts';

const assert: (condition: unknown, message?: string) => asserts condition = (
  condition,
  message = 'assertion failed',
) => {
  if (!condition) throw new Error(message);
};

const assertEquals = (actual: unknown, expected: unknown): void => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${left} !== ${right}`);
};

const encoder = new TextEncoder();
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        bytes.slice().buffer as ArrayBuffer,
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

const fileSystemOf = (bytes: Uint8Array): BaseInstructionFileSystem => ({
  readFile: () => Promise.resolve(bytes),
});

Deno.test('Increment 103 built-in base instruction is the minimal core', () => {
  assert(HENJI_COMMON_INSTRUCTION.includes('You are Henji'));
  assert(HENJI_COMMON_INSTRUCTION.includes('do not display credential values'));
  assert(!HENJI_COMMON_INSTRUCTION.includes('Before changing implementation'));
  assert(!HENJI_COMMON_INSTRUCTION.includes('faithful artifact'));
  assert(!HENJI_COMMON_INSTRUCTION.includes('reuse successful tool results'));
  const builtin = builtinHenjiBaseInstruction();
  assertEquals(builtin.selectionSource, 'built-in');
  assertEquals(builtin.ref.resourceId, 'builtin/henji-base');
  assertEquals(builtin.content, HENJI_COMMON_INSTRUCTION);
});

Deno.test('Increment 103 resolves a user instruction.md as the external base', async () => {
  const content = 'Custom external instruction.\nSecond line.\n';
  const bytes = encoder.encode(content);
  const resolved = await resolveHenjiBaseInstruction(
    '/config',
    fileSystemOf(bytes),
  );
  assertEquals(resolved.selectionSource, 'external');
  assertEquals(resolved.ref.resourceId, HENJI_BASE_INSTRUCTION_FILE_ID);
  assertEquals(resolved.ref.revision.digest, await sha256Hex(bytes));
  assertEquals(resolved.contentDigest, `sha256:${await sha256Hex(bytes)}`);
  assertEquals(resolved.content, content);
  assert(await verifySelectedHenjiBaseInstruction(resolved));
});

Deno.test('Increment 103 falls back to the built-in core without a user file', async () => {
  const resolved = await resolveHenjiBaseInstruction('/config', {
    readFile: () => Promise.reject(new Deno.errors.NotFound()),
  });
  assertEquals(resolved.selectionSource, 'built-in');
  assertEquals(resolved.content, HENJI_COMMON_INSTRUCTION);
});

Deno.test('Increment 103 rejects invalid content and read failures before the turn', async () => {
  let invalid = '';
  try {
    await resolveHenjiBaseInstruction(
      '/config',
      fileSystemOf(encoder.encode('   \n')),
    );
  } catch (error) {
    invalid = error instanceof HenjiInstructionError ? error.code : 'unexpected';
  }
  assertEquals(invalid, 'instruction_invalid');

  let io = '';
  try {
    await resolveHenjiBaseInstruction('/config', {
      readFile: () => Promise.reject(new Deno.errors.PermissionDenied()),
    });
  } catch (error) {
    io = error instanceof HenjiInstructionError ? error.code : 'unexpected';
  }
  assertEquals(io, 'instruction_io_failure');
});

Deno.test('Increment 103 built-in instruction identity matches the minimal content', async () => {
  assert(await verifyBuiltinHenjiBaseInstructionIdentity());
});

Deno.test('Increment 103 template keeps the moved detailed policy', async () => {
  const template = await Deno.readTextFile(
    'docs/operations/base-instruction-template.md',
  );
  assert(template.includes('Before changing implementation'));
  assert(
    template.includes('Prefer the smallest change that satisfies the request.'),
  );
  assert(template.includes('faithful artifact'));
  assert(template.includes('reuse successful tool results'));
});
