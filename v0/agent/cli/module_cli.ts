import {
  ManagedDefinitionError,
  type ManagedDefinitionErrorCode,
} from '../definitions/managed_definition_importer.ts';
import {
  type ManagedDefinitionRevision,
  ManagedDefinitionStore,
} from '../definitions/managed_definition_store.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const encoder = new TextEncoder();
const FULL_REVISION = /^sha256:([0-9a-f]{64})$/u;

const ERROR_MESSAGES: Readonly<Record<ManagedDefinitionErrorCode | 'invalid_invocation', string>> =
  {
    invalid_invocation: 'invalid invocation',
    module_not_found: 'managed Definition revision not found',
    module_invalid: 'managed Definition revision invalid',
    module_api_unsupported: 'managed Definition API contract is unsupported',
    module_io_failure: 'managed Definition I/O failure',
    module_import_unsupported: 'Definition import is not supported',
  };

export type ModuleCliCommand =
  | {
    readonly kind: 'install';
    readonly entryPath: string;
    readonly resourceId: string;
    readonly declaredRole: 'parent' | 'planner';
    readonly moduleRoot?: string;
  }
  | { readonly kind: 'list' }
  | { readonly kind: 'inspect'; readonly resourceId: string; readonly digest: string };

export class ModuleCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'ModuleCliInvocationError';
  }
}

const parsePairs = (
  args: readonly string[],
  allowed: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  if (args.length % 2 !== 0) throw new ModuleCliInvocationError();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || values.has(flag) || value.length === 0) {
      throw new ModuleCliInvocationError();
    }
    values.set(flag, value);
  }
  return values;
};

export const parseModuleArgs = (args: readonly string[]): ModuleCliCommand => {
  if (args.length === 1 && args[0] === 'list') return { kind: 'list' };
  if (args[0] === 'install' && args.length >= 4) {
    const entryPath = args[1];
    if (entryPath.length === 0) throw new ModuleCliInvocationError();
    const values = parsePairs(args.slice(2), new Set(['--id', '--role', '--root']));
    const resourceId = values.get('--id');
    const rawRole = values.get('--role') ?? 'parent';
    if (resourceId === undefined || (rawRole !== 'parent' && rawRole !== 'planner')) {
      throw new ModuleCliInvocationError();
    }
    return {
      kind: 'install',
      entryPath,
      resourceId,
      declaredRole: rawRole,
      ...(values.get('--root') === undefined ? {} : { moduleRoot: values.get('--root') }),
    };
  }
  if (args[0] === 'inspect' && args.length === 5) {
    const values = parsePairs(args.slice(1), new Set(['--id', '--revision']));
    const resourceId = values.get('--id');
    const revision = values.get('--revision');
    const matched = revision === undefined ? undefined : FULL_REVISION.exec(revision);
    if (resourceId === undefined || matched === undefined || matched === null) {
      throw new ModuleCliInvocationError();
    }
    return { kind: 'inspect', resourceId, digest: matched[1] };
  }
  throw new ModuleCliInvocationError();
};

export interface ModuleCliDependencies {
  readonly dataRoot?: string;
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

const detail = (revision: ManagedDefinitionRevision) => ({
  schemaVersion: 1,
  manifest: revision.manifest,
  originLineage: revision.custody.originLineage,
  localCustody: revision.custody.localCustody,
  physicalStore: {
    root: revision.physicalRoot,
    entry: revision.entryPath,
  },
});

const errorPayload = (
  code: ManagedDefinitionErrorCode | 'invalid_invocation',
  message?: string,
) => ({
  ok: false,
  error: { code, message: message ?? ERROR_MESSAGES[code] },
});

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: ModuleCliDependencies = {},
): Promise<number> => {
  let command: ModuleCliCommand;
  try {
    command = parseModuleArgs(args);
  } catch {
    await write(
      dependencies.writeStderr,
      Deno.stderr,
      errorPayload('invalid_invocation'),
    );
    return 1;
  }
  try {
    const store = new ManagedDefinitionStore({
      dataRoot: dependencies.dataRoot ?? resolveRuntimePaths().dataRoot,
      now: dependencies.now,
    });
    if (command.kind === 'install') {
      const revision = await store.install({
        entryPath: command.entryPath,
        resourceId: command.resourceId,
        declaredRole: command.declaredRole,
        ...(command.moduleRoot === undefined ? {} : { moduleRoot: command.moduleRoot }),
      });
      await write(dependencies.writeStdout, Deno.stdout, { ok: true, ...detail(revision) });
    } else if (command.kind === 'list') {
      await write(dependencies.writeStdout, Deno.stdout, {
        schemaVersion: 1,
        modules: await store.list(),
      });
    } else {
      const revision = await store.inspect(command.resourceId, command.digest);
      await write(dependencies.writeStdout, Deno.stdout, detail(revision));
    }
    return 0;
  } catch (error) {
    const code = error instanceof ManagedDefinitionError ? error.code : 'module_io_failure';
    const message = error instanceof ManagedDefinitionError ? error.message : ERROR_MESSAGES[code];
    await write(dependencies.writeStderr, Deno.stderr, errorPayload(code, message));
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
