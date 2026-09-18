import {
  deactivateToolBinding,
  readToolBindingRef,
  readToolBindings,
  resolveToolDefinitionRevisionDigest,
  ToolBindingError,
  writeToolBindingRef,
} from '../definitions/tool_binding.ts';
import { ManagedToolDefinitionStore } from '../definitions/managed_tool_definition_store.ts';
import type { ToolDefinitionRevisionRef } from '../definitions/managed_resource_ref.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

const encoder = new TextEncoder();

const shellWord = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

export type ToolCliCommand =
  | {
    readonly kind: 'install';
    readonly resourceId: string;
    readonly toolIdentity: string;
    readonly entryPath: string;
    readonly moduleRoot?: string;
  }
  | { readonly kind: 'list'; readonly json: boolean }
  | { readonly kind: 'inspect'; readonly resourceId: string; readonly revision: string }
  | { readonly kind: 'active'; readonly json: boolean }
  | { readonly kind: 'activate'; readonly resourceId: string; readonly revision: string }
  | {
    readonly kind: 'uninstall';
    readonly resourceId: string;
    readonly revision?: string;
  }
  | { readonly kind: 'deactivate'; readonly toolIdentity: string; readonly json: boolean };

export class ToolCliInvocationError extends Error {
  constructor() {
    super('invalid invocation');
    this.name = 'ToolCliInvocationError';
  }
}

const flagValue = (
  args: readonly string[],
  flag: string,
): string | undefined => {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) return undefined;
  const value = args[index + 1];
  return value.length === 0 ? undefined : value;
};

const parseInstall = (args: readonly string[]): ToolCliCommand => {
  const resourceId = flagValue(args, '--id');
  const toolIdentity = flagValue(args, '--tool');
  const entryPath = flagValue(args, '--entry');
  const moduleRoot = flagValue(args, '--root');
  if (resourceId === undefined || toolIdentity === undefined || entryPath === undefined) {
    throw new ToolCliInvocationError();
  }
  return {
    kind: 'install',
    resourceId,
    toolIdentity,
    entryPath,
    ...(moduleRoot === undefined ? {} : { moduleRoot }),
  };
};

export const parseToolArgs = (args: readonly string[]): ToolCliCommand => {
  if (args.length === 0) throw new ToolCliInvocationError();
  const [command, ...rest] = args;
  if (command === 'install') return parseInstall(rest);
  if (command === 'list') {
    if (rest.length === 0) return { kind: 'list', json: false };
    if (rest.length === 1 && rest[0] === '--json') return { kind: 'list', json: true };
    throw new ToolCliInvocationError();
  }
  if (command === 'active') {
    if (rest.length === 0) return { kind: 'active', json: false };
    if (rest.length === 1 && rest[0] === '--json') return { kind: 'active', json: true };
    throw new ToolCliInvocationError();
  }
  if (command === 'deactivate') {
    const toolIdentity = flagValue(rest, '--tool');
    if (toolIdentity === undefined) throw new ToolCliInvocationError();
    return { kind: 'deactivate', toolIdentity, json: rest.includes('--json') };
  }
  if (command === 'inspect' || command === 'activate') {
    const resourceId = flagValue(rest, '--id');
    const revision = flagValue(rest, '--revision');
    if (resourceId === undefined || revision === undefined) throw new ToolCliInvocationError();
    return { kind: command, resourceId, revision };
  }
  if (command === 'uninstall') {
    const resourceId = flagValue(rest, '--id');
    if (resourceId === undefined) throw new ToolCliInvocationError();
    const revision = flagValue(rest, '--revision');
    return {
      kind: 'uninstall',
      resourceId,
      ...(revision === undefined ? {} : { revision }),
    };
  }
  throw new ToolCliInvocationError();
};

export interface ToolCliDependencies {
  readonly dataRoot?: string;
  readonly configRoot?: string;
  readonly now?: () => Date;
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
}

const writeJson = async (
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

const ref = (resourceId: string, digest: string): ToolDefinitionRevisionRef => ({
  schemaVersion: 1,
  resourceKind: 'tool-definition',
  resourceId,
  revision: { algorithm: 'sha256', digest },
});

const pairs = async (
  store: ManagedToolDefinitionStore,
): Promise<readonly { readonly resourceId: string; readonly digest: string }[]> =>
  (await store.list()).map((summary) => ({
    resourceId: summary.logicalRef.resourceId,
    digest: summary.logicalRef.revision.digest,
  }));

const errorPayload = (code: string, message: string) => ({
  ok: false,
  error: { code, message },
});

const installReceipt = (
  revision: Awaited<ReturnType<ManagedToolDefinitionStore['install']>>,
): string => {
  const resourceId = revision.manifest.logicalRef.resourceId;
  const short = revision.manifest.logicalRef.revision.digest.slice(0, 8);
  const selector = `--id ${shellWord(resourceId)} --revision ${shellWord(short)}`;
  return [
    `Installed: ${JSON.stringify(resourceId)}`,
    `Tool:      ${revision.manifest.toolIdentity}`,
    `Revision:  sha256:${short}`,
    '',
    'Inspect:',
    `henji tool inspect ${selector}`,
    '',
    'Activate:',
    `henji tool activate ${selector}`,
    '',
    'Uninstall:',
    `henji tool uninstall ${selector}`,
    '',
  ].join('\n');
};

export const main = async (
  args: readonly string[] = Deno.args,
  dependencies: ToolCliDependencies = {},
): Promise<number> => {
  let command: ToolCliCommand;
  try {
    command = parseToolArgs(args);
  } catch {
    await writeJson(
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
  const store = new ManagedToolDefinitionStore({ dataRoot, now: dependencies.now });
  try {
    if (command.kind === 'install') {
      const revision = await store.install({
        entryPath: command.entryPath,
        resourceId: command.resourceId,
        toolIdentity: command.toolIdentity,
        ...(command.moduleRoot === undefined ? {} : { moduleRoot: command.moduleRoot }),
      });
      await writeText(dependencies.writeStdout, Deno.stdout, installReceipt(revision));
    } else if (command.kind === 'list') {
      const summaries = await store.list();
      if (command.json) {
        await writeJson(dependencies.writeStdout, Deno.stdout, {
          schemaVersion: 1,
          tools: summaries,
        });
      } else if (summaries.length === 0) {
        await writeText(dependencies.writeStdout, Deno.stdout, 'no tool definitions\n');
      } else {
        const bindings = (await readToolBindings(configRoot)).bindings;
        const lines = [`tool definitions: ${summaries.length}`];
        for (const summary of summaries) {
          const resourceId = summary.logicalRef.resourceId;
          const digest = summary.logicalRef.revision.digest;
          const selector = `${resourceId}@sha256:${digest}`;
          const active = Object.values(bindings).includes(selector);
          lines.push(
            `${summary.toolIdentity} · ${resourceId} · sha256:${digest.slice(0, 8)} · ${
              active ? 'active' : 'inactive'
            }`,
          );
        }
        await writeText(dependencies.writeStdout, Deno.stdout, `${lines.join('\n')}\n`);
      }
    } else if (command.kind === 'inspect') {
      const digest = resolveToolDefinitionRevisionDigest(
        await pairs(store),
        command.resourceId,
        command.revision,
      );
      const revision = await store.inspect(command.resourceId, digest);
      await writeJson(dependencies.writeStdout, Deno.stdout, {
        schemaVersion: 1,
        manifest: revision.manifest,
        originLineage: revision.custody.originLineage,
        localCustody: revision.custody.localCustody,
        physicalStore: { root: revision.physicalRoot, entry: revision.entryPath },
      });
    } else if (command.kind === 'active') {
      const bindings = (await readToolBindings(configRoot)).bindings;
      if (command.json) {
        await writeJson(dependencies.writeStdout, Deno.stdout, {
          schemaVersion: 1,
          bindings,
        });
      } else {
        const entries = Object.entries(bindings);
        const text = entries.length === 0
          ? 'no active tool bindings\n'
          : `${entries.map(([identity, selector]) => `${identity} · ${selector}`).join('\n')}\n`;
        await writeText(dependencies.writeStdout, Deno.stdout, text);
      }
    } else if (command.kind === 'activate') {
      const digest = resolveToolDefinitionRevisionDigest(
        await pairs(store),
        command.resourceId,
        command.revision,
      );
      const revision = await store.inspect(command.resourceId, digest);
      await writeToolBindingRef(
        configRoot,
        revision.manifest.toolIdentity,
        ref(command.resourceId, digest),
      );
      await writeJson(dependencies.writeStdout, Deno.stdout, {
        ok: true,
        toolIdentity: revision.manifest.toolIdentity,
        ref: ref(command.resourceId, digest),
      });
    } else if (command.kind === 'uninstall') {
      const installed = await pairs(store);
      const digests = command.revision === undefined
        ? installed.filter((item) => item.resourceId === command.resourceId).map((item) =>
          item.digest
        )
        : [
          resolveToolDefinitionRevisionDigest(
            installed,
            command.resourceId,
            command.revision,
          ),
        ];
      if (digests.length === 0) {
        throw new ToolBindingError(
          'binding_definition_not_found',
          'no installed tool Definition revision matches the selector',
        );
      }
      for (const digest of digests) {
        const selector = `${command.resourceId}@sha256:${digest}`;
        const bound = Object.values((await readToolBindings(configRoot)).bindings);
        if (bound.includes(selector)) {
          throw new ToolBindingError(
            'binding_invalid',
            'tool Definition revision is active; deactivate it before uninstall',
          );
        }
      }
      for (const digest of digests) await store.remove(command.resourceId, digest);
      await writeText(
        dependencies.writeStdout,
        Deno.stdout,
        `Uninstalled: ${JSON.stringify(command.resourceId)} (${
          digests.map((digest) => `sha256:${digest.slice(0, 8)}`).join(', ')
        })\n`,
      );
    } else {
      const bound = await readToolBindingRef(configRoot, command.toolIdentity);
      await deactivateToolBinding(configRoot, command.toolIdentity);
      if (command.json) {
        await writeJson(dependencies.writeStdout, Deno.stdout, {
          ok: true,
          toolIdentity: command.toolIdentity,
          ...(bound === undefined ? { selectionSource: 'bundled' } : { deactivated: bound }),
        });
      } else {
        await writeText(
          dependencies.writeStdout,
          Deno.stdout,
          `${command.toolIdentity} · ${bound === undefined ? 'bundled' : 'deactivated'}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    const failure = error instanceof ToolBindingError ? error : new ToolBindingError(
      'binding_invalid',
      error instanceof Error ? error.message : String(error),
    );
    await writeJson(
      dependencies.writeStderr,
      Deno.stderr,
      errorPayload(failure.code, failure.message),
    );
    return 1;
  }
};

if (import.meta.main) Deno.exit(await main());
