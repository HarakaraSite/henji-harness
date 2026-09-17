import {
  activateHenjiBaseInstruction,
  builtinHenjiBaseInstruction,
  deactivateHenjiBaseInstruction,
  HenjiInstructionError,
  type HenjiInstructionErrorCode,
  ManagedHenjiInstructionStore,
  readHenjiBaseInstructionBindingRef,
  resolveActiveHenjiBaseInstruction,
  resolveInstructionRevisionDigest,
} from '../instructions/managed_instruction.ts';
import type { HenjiInstructionRevisionRef } from '../definitions/managed_resource_ref.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const encoder = new TextEncoder();
const REVISION_VALUE = /^(?:sha256:)?([0-9a-f]{1,64})$/u;

const shellWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export type InstructionCliCommand =
  | { readonly kind: 'install'; readonly directoryPath: string }
  | { readonly kind: 'list'; readonly json: boolean }
  | {
    readonly kind: 'inspect';
    readonly resourceId: string;
    readonly revision: string;
  }
  | { readonly kind: 'active'; readonly json: boolean }
  | {
    readonly kind: 'activate';
    readonly resourceId: string;
    readonly revision: string;
  }
  | {
    readonly kind: 'uninstall';
    readonly resourceId: string;
    readonly revision?: string;
  }
  | { readonly kind: 'deactivate'; readonly json: boolean };

export class InstructionCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'InstructionCliInvocationError';
  }
}

const parseRevisionPrefix = (value: string): string => {
  const match = REVISION_VALUE.exec(value);
  if (match === null) throw new InstructionCliInvocationError();
  return match[1];
};

const parseSelector = (
  args: readonly string[],
): { readonly resourceId: string; readonly revision: string } => {
  if (args.length !== 4 || args[0] !== '--id' || args[2] !== '--revision') {
    throw new InstructionCliInvocationError();
  }
  if (args[1].length === 0) throw new InstructionCliInvocationError();
  return { resourceId: args[1], revision: parseRevisionPrefix(args[3]) };
};

const parseUninstallSelector = (
  args: readonly string[],
): { readonly resourceId: string; readonly revision?: string } => {
  if (args.length === 2 && args[0] === '--id' && args[1].length > 0) {
    return { resourceId: args[1] };
  }
  return parseSelector(args);
};

export const parseInstructionArgs = (
  args: readonly string[],
): InstructionCliCommand => {
  if (args.length === 1 && args[0] === 'list') {
    return { kind: 'list', json: false };
  }
  if (args.length === 2 && args[0] === 'list' && args[1] === '--json') {
    return { kind: 'list', json: true };
  }
  if (args.length === 1 && args[0] === 'active') {
    return { kind: 'active', json: false };
  }
  if (args.length === 2 && args[0] === 'active' && args[1] === '--json') {
    return { kind: 'active', json: true };
  }
  if (args.length === 1 && args[0] === 'deactivate') {
    return { kind: 'deactivate', json: false };
  }
  if (args.length === 2 && args[0] === 'deactivate' && args[1] === '--json') {
    return { kind: 'deactivate', json: true };
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
  if (args[0] === 'uninstall') {
    return { kind: 'uninstall', ...parseUninstallSelector(args.slice(1)) };
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
  const digest = revision.manifest.logicalRef.revision.digest;
  const short = digest.slice(0, 8);
  const selector = `--id ${shellWord(resourceId)} --revision ${shellWord(short)}`;
  return [
    `Installed: ${JSON.stringify(resourceId)}`,
    `Revision:  sha256:${short}`,
    '',
    'Inspect:',
    `henji instruction inspect ${selector}`,
    '',
    'Activate:',
    `henji instruction activate ${selector}`,
    '',
    'Uninstall:',
    `henji instruction uninstall ${selector}`,
    '',
  ].join('\n');
};

const uninstallReceipt = (
  manifest: Awaited<ReturnType<ManagedHenjiInstructionStore['remove']>>,
): string => {
  const resourceId = manifest.logicalRef.resourceId;
  const short = manifest.logicalRef.revision.digest.slice(0, 8);
  return [
    `Uninstalled: ${JSON.stringify(resourceId)}`,
    `Revision:    sha256:${short}`,
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

const displayText = (value: string, fallback: string): string => {
  let cleaned = '';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    cleaned += code < 0x20 || code === 0x7f ? ' ' : character;
  }
  cleaned = cleaned.trim();
  return cleaned.length === 0 ? fallback : [...cleaned].slice(0, 120).join('');
};

const installedPairs = async (
  store: ManagedHenjiInstructionStore,
): Promise<readonly { readonly resourceId: string; readonly digest: string }[]> =>
  (await store.list()).map((manifest) => ({
    resourceId: manifest.logicalRef.resourceId,
    digest: manifest.logicalRef.revision.digest,
  }));

const listHumanText = async (
  store: ManagedHenjiInstructionStore,
  configRoot: string,
): Promise<string> => {
  const manifests = await store.list();
  if (manifests.length === 0) return 'no instructions\n';
  const binding = await readHenjiBaseInstructionBindingRef(configRoot);
  const lines = [`instructions: ${manifests.length}`];
  for (const manifest of manifests) {
    const logicalRef = manifest.logicalRef;
    const active = binding !== undefined &&
      binding.resourceId === logicalRef.resourceId &&
      binding.revision.digest === logicalRef.revision.digest;
    lines.push(
      `${displayText(logicalRef.resourceId, 'instruction')} · sha256:${
        logicalRef.revision.digest.slice(0, 8)
      } · ${active ? 'active' : 'inactive'} · ${displayText(manifest.metadata.title, 'untitled')}`,
    );
  }
  return `${lines.join('\n')}\n`;
};

const activeHumanText = async (
  dataRoot: string,
  configRoot: string,
): Promise<string> => {
  const value = await resolveActiveHenjiBaseInstruction(dataRoot, configRoot);
  return `${value.ref.resourceId} · ${value.selectionSource} · sha256:${
    value.ref.revision.digest.slice(0, 8)
  }\n`;
};

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
      if (command.json) {
        await write(dependencies.writeStdout, Deno.stdout, {
          schemaVersion: 1,
          instructions: await store.list(),
        });
      } else {
        await writeText(
          dependencies.writeStdout,
          Deno.stdout,
          await listHumanText(store, configRoot),
        );
      }
    } else if (command.kind === 'inspect') {
      const digest = resolveInstructionRevisionDigest(
        await installedPairs(store),
        command.resourceId,
        command.revision,
      );
      await write(
        dependencies.writeStdout,
        Deno.stdout,
        detail(await store.inspect(command.resourceId, digest)),
      );
    } else if (command.kind === 'active') {
      if (command.json) {
        await write(
          dependencies.writeStdout,
          Deno.stdout,
          selected(await resolveActiveHenjiBaseInstruction(dataRoot, configRoot)),
        );
      } else {
        await writeText(
          dependencies.writeStdout,
          Deno.stdout,
          await activeHumanText(dataRoot, configRoot),
        );
      }
    } else if (command.kind === 'activate') {
      const digest = resolveInstructionRevisionDigest(
        await installedPairs(store),
        command.resourceId,
        command.revision,
      );
      await write(
        dependencies.writeStdout,
        Deno.stdout,
        {
          ok: true,
          ...selected(
            await activateHenjiBaseInstruction(
              dataRoot,
              configRoot,
              ref(command.resourceId, digest),
            ),
          ),
        },
      );
    } else if (command.kind === 'uninstall') {
      const digest = resolveInstructionRevisionDigest(
        await installedPairs(store),
        command.resourceId,
        command.revision,
      );
      const target = ref(command.resourceId, digest);
      const active = await readHenjiBaseInstructionBindingRef(configRoot);
      if (
        active !== undefined && active.resourceId === target.resourceId &&
        active.revision.digest === target.revision.digest
      ) {
        throw new HenjiInstructionError(
          'instruction_active',
          'Henji Instruction revision is active; deactivate it before uninstall',
          target,
        );
      }
      const removed = await store.remove(command.resourceId, digest);
      await writeText(
        dependencies.writeStdout,
        Deno.stdout,
        uninstallReceipt(removed),
      );
    } else {
      await deactivateHenjiBaseInstruction(configRoot);
      const builtin = builtinHenjiBaseInstruction();
      if (command.json) {
        await write(dependencies.writeStdout, Deno.stdout, {
          ok: true,
          ...selected(builtin),
        });
      } else {
        await writeText(
          dependencies.writeStdout,
          Deno.stdout,
          `deactivated · ${builtin.ref.resourceId} · ${builtin.selectionSource} · sha256:${
            builtin.ref.revision.digest.slice(0, 8)
          }\n`,
        );
      }
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
