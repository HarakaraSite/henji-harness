import {
  activateHenjiBaseInstruction,
  builtinHenjiBaseInstruction,
  deactivateHenjiBaseInstruction,
  HenjiInstructionError,
  type HenjiInstructionErrorCode,
  ManagedHenjiInstructionStore,
  resolveActiveHenjiBaseInstruction,
} from '../instructions/managed_instruction.ts';
import type { HenjiInstructionRevisionRef } from '../definitions/managed_resource_ref.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const encoder = new TextEncoder();
const FULL_REVISION = /^sha256:([0-9a-f]{64})$/u;

const shellWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export type InstructionCliCommand =
  | { readonly kind: 'install'; readonly directoryPath: string }
  | { readonly kind: 'list' }
  | {
    readonly kind: 'inspect';
    readonly resourceId: string;
    readonly digest: string;
  }
  | { readonly kind: 'active' }
  | {
    readonly kind: 'activate';
    readonly resourceId: string;
    readonly digest: string;
  }
  | { readonly kind: 'deactivate' };

export class InstructionCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'InstructionCliInvocationError';
  }
}

const parseSelector = (
  args: readonly string[],
): { readonly resourceId: string; readonly digest: string } => {
  if (args.length !== 4 || args[0] !== '--id' || args[2] !== '--revision') {
    throw new InstructionCliInvocationError();
  }
  const match = FULL_REVISION.exec(args[3]);
  if (args[1].length === 0 || match === null) {
    throw new InstructionCliInvocationError();
  }
  return { resourceId: args[1], digest: match[1] };
};

export const parseInstructionArgs = (
  args: readonly string[],
): InstructionCliCommand => {
  if (args.length === 1 && args[0] === 'list') return { kind: 'list' };
  if (args.length === 1 && args[0] === 'active') return { kind: 'active' };
  if (args.length === 1 && args[0] === 'deactivate') {
    return { kind: 'deactivate' };
  }
  if (args.length === 2 && args[0] === 'install' && args[1].length > 0) {
    return { kind: 'install', directoryPath: args[1] };
  }
  if (args[0] === 'inspect') {
    return { kind: 'inspect', ...parseSelector(args.slice(1)) };
  }
  if (args[0] === 'activate') {
    return { kind: 'activate', ...parseSelector(args.slice(1)) };
  }
  throw new InstructionCliInvocationError();
};

export interface InstructionCliDependencies {
  readonly dataRoot?: string;
  readonly configRoot?: string;
  readonly now?: () => Date;
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
}

const write = async (
  writer: ((text: string) => void | PromiseLike<void>) | undefined,
  stream: typeof Deno.stdout | typeof Deno.stderr,
  value: unknown,
): Promise<void> => {
  const text = `${JSON.stringify(value)}\n`;
  if (writer !== undefined) await writer(text);
  else await stream.write(encoder.encode(text));
};

const writeText = async (
  writer: ((text: string) => void | PromiseLike<void>) | undefined,
  stream: typeof Deno.stdout | typeof Deno.stderr,
  text: string,
): Promise<void> => {
  if (writer !== undefined) await writer(text);
  else await stream.write(encoder.encode(text));
};

const ref = (
  resourceId: string,
  digest: string,
): HenjiInstructionRevisionRef => ({
  schemaVersion: 1,
  resourceKind: 'henji-instruction',
  resourceId,
  revision: { algorithm: 'sha256', digest },
});

const detail = (
  revision: Awaited<ReturnType<ManagedHenjiInstructionStore['inspect']>>,
) => ({
  schemaVersion: 1,
  manifest: revision.manifest,
  originLineage: revision.custody.originLineage,
  localCustody: revision.custody.localCustody,
  physicalStore: { root: revision.physicalRoot, entry: revision.entryPath },
  content: revision.content,
});

const installReceipt = (
  revision: Awaited<ReturnType<ManagedHenjiInstructionStore['install']>>,
): string => {
  const resourceId = revision.manifest.logicalRef.resourceId;
  const exactRevision = `sha256:${revision.manifest.logicalRef.revision.digest}`;
  const selector = `--id ${shellWord(resourceId)} --revision ${shellWord(exactRevision)}`;
  return [
    `Installed: ${JSON.stringify(resourceId)}`,
    `Revision:  ${exactRevision}`,
    '',
    'Inspect:',
    `henji instruction inspect ${selector}`,
    '',
    'Activate:',
    `henji instruction activate ${selector}`,
    '',
  ].join('\n');
};

const selected = (value: ReturnType<typeof builtinHenjiBaseInstruction>) => ({
  schemaVersion: 1,
  slot: value.slot,
  selectionSource: value.selectionSource,
  ref: value.ref,
  contentDigest: value.contentDigest,
});

const errorPayload = (
  code: HenjiInstructionErrorCode | 'invalid_invocation',
  message: string,
  instruction?: HenjiInstructionRevisionRef,
) => ({
  ok: false,
  error: {
    code,
    message,
    ...(instruction === undefined ? {} : { instruction }),
  },
});

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: InstructionCliDependencies = {},
): Promise<number> => {
  let command: InstructionCliCommand;
  try {
    command = parseInstructionArgs(args);
  } catch {
    await write(
      dependencies.writeStderr,
      Deno.stderr,
      errorPayload('invalid_invocation', 'invalid invocation'),
    );
    return 1;
  }
  const paths = dependencies.dataRoot === undefined || dependencies.configRoot === undefined
    ? resolveRuntimePaths()
    : undefined;
  const dataRoot = dependencies.dataRoot ?? paths!.dataRoot;
  const configRoot = dependencies.configRoot ?? paths!.configRoot;
  const store = new ManagedHenjiInstructionStore({
    dataRoot,
    now: dependencies.now,
  });
  try {
    if (command.kind === 'install') {
      const revision = await store.install(command.directoryPath);
      await writeText(
        dependencies.writeStdout,
        Deno.stdout,
        installReceipt(revision),
      );
    } else if (command.kind === 'list') {
      await write(dependencies.writeStdout, Deno.stdout, {
        schemaVersion: 1,
        instructions: await store.list(),
      });
    } else if (command.kind === 'inspect') {
      await write(
        dependencies.writeStdout,
        Deno.stdout,
        detail(await store.inspect(command.resourceId, command.digest)),
      );
    } else if (command.kind === 'active') {
      await write(
        dependencies.writeStdout,
        Deno.stdout,
        selected(await resolveActiveHenjiBaseInstruction(dataRoot, configRoot)),
      );
    } else if (command.kind === 'activate') {
      await write(
        dependencies.writeStdout,
        Deno.stdout,
        {
          ok: true,
          ...selected(
            await activateHenjiBaseInstruction(
              dataRoot,
              configRoot,
              ref(command.resourceId, command.digest),
            ),
          ),
        },
      );
    } else {
      await deactivateHenjiBaseInstruction(configRoot);
      await write(dependencies.writeStdout, Deno.stdout, {
        ok: true,
        ...selected(builtinHenjiBaseInstruction()),
      });
    }
    return 0;
  } catch (error) {
    const failure = error instanceof HenjiInstructionError ? error : new HenjiInstructionError(
      'instruction_io_failure',
      error instanceof Error ? error.message : String(error),
    );
    await write(
      dependencies.writeStderr,
      Deno.stderr,
      errorPayload(failure.code, failure.message, failure.instruction),
    );
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
