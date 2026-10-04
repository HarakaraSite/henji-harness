import {
  cliErrorMessage,
  cliErrorText,
  CliInvocationError,
  commandError,
  parseCliOptions,
} from './cli_error.ts';
import {
  bundledAgentConfiguration,
  configurationString,
  isConfigurationObject,
  parseAgentConfiguration,
} from '../configuration/agent_configuration.ts';
import {
  configurationFileUrl,
  resolveToolSelection,
  resolveWorkerConfiguration,
} from '../configuration/configuration_resolver.ts';
import { resolveRuntimePaths } from '../runtime/runtime_paths.ts';

interface ConfigurationCliDependencies {
  readonly configRoot?: string;
  readonly writeStdout?: (text: string) => void | PromiseLike<void>;
  readonly writeStderr?: (text: string) => void | PromiseLike<void>;
}

const readCatalog = async (
  file: string,
  kind: 'agents' | 'tools',
): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(file));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { schemaVersion: 1, [kind]: {} };
    throw error;
  }
  if (
    !isConfigurationObject(value) || value.schemaVersion !== 1 ||
    !isConfigurationObject(value[kind])
  ) throw new Error(`Invalid ${kind}.json`);
  return value;
};

/** Catalog edits select current external files; they never archive or execute source. */
export const configurationMain = async (
  kind: 'agent' | 'tool',
  args: readonly string[],
  dependencies: ConfigurationCliDependencies = {},
): Promise<number> => {
  const encoder = new TextEncoder();
  const emit = async (value: unknown): Promise<void> => {
    const text = JSON.stringify(value) + '\n';
    if (dependencies.writeStdout === undefined) await Deno.stdout.write(encoder.encode(text));
    else await dependencies.writeStdout(text);
  };
  const fail = async (message: string): Promise<void> => {
    const text = cliErrorText(kind, message, true);
    if (dependencies.writeStderr === undefined) await Deno.stderr.write(encoder.encode(text));
    else await dependencies.writeStderr(text);
  };
  try {
    const command = args[0];
    if (!['list', 'inspect', 'activate', 'deactivate'].includes(command)) {
      throw commandError(command, 'list, inspect, activate or deactivate');
    }
    const allowed = command === 'list'
      ? []
      : kind === 'agent'
      ? command === 'deactivate' ? ['--name'] : ['--name', '--file']
      : command === 'activate'
      ? ['--name', '--folder']
      : ['--name'];
    const flags = parseCliOptions(args.slice(1), allowed);
    for (const [flag, value] of flags) configurationString(value, flag);
    const configRoot = dependencies.configRoot ?? resolveRuntimePaths().configRoot;
    const name = flags.get('--name');
    const file = flags.get('--file');
    const folder = flags.get('--folder');
    const catalogKind = kind === 'agent' ? 'agents' : 'tools';
    const catalogFile = `${configRoot}/${catalogKind}.json`;
    const catalog = await readCatalog(catalogFile, catalogKind);
    const entries = catalog[catalogKind] as Record<string, unknown>;
    if (kind === 'agent') {
      if (name !== undefined && file !== undefined && command === 'inspect') {
        throw new CliInvocationError('--name and --file are mutually exclusive for agent inspect');
      }
      if (command === 'list') {
        const selected = await resolveWorkerConfiguration(configRoot);
        await emit({
          default: selected.agent ?? null,
          agents: selected.agents,
          rejections: selected.rejections,
        });
        return 0;
      }
      if (command === 'inspect') {
        const selected = await resolveWorkerConfiguration(
          configRoot,
          file === undefined ? name === undefined ? {} : { name } : { file },
        );
        if (selected.agent === undefined) {
          await fail(
            selected.rejections.map((entry) => entry.reason).join('; ') ||
              'Agent configuration is unavailable',
          );
          return 1;
        }
        await emit(selected);
        return 0;
      }
      if (command === 'activate' && file !== undefined) {
        const absoluteFile = decodeURIComponent(configurationFileUrl(file).pathname);
        const configuration = parseAgentConfiguration(
          JSON.parse(await Deno.readTextFile(absoluteFile)),
          Object.keys(entries),
        );
        if (name === 'generic') throw new Error('generic uses the bundled configuration');
        if (name !== undefined && configuration.name !== name) {
          throw new Error(`Agent JSON name must be ${name}`);
        }
        if (name === undefined) catalog.default = absoluteFile;
        else entries[name] = absoluteFile;
      } else if (command === 'deactivate') {
        if (name === undefined) delete catalog.default;
        else delete entries[name];
      } else throw new CliInvocationError('Missing required --file for agent activate');
    } else {
      if (command === 'list') {
        const names = [
          ...new Set([...bundledAgentConfiguration().configuration.tools, ...Object.keys(entries)]),
        ];
        const tools = await Promise.all(
          names.map((name) =>
            Object.hasOwn(entries, name)
              ? resolveToolSelection(name, entries[name], configRoot, catalogFile)
              : Promise.resolve({ name, source: 'bundled', revision: '1' })
          ),
        );
        await emit({ tools });
        return 0;
      }
      if (name === undefined) throw new CliInvocationError('Missing required --name');
      if (command === 'inspect') {
        if (
          !Object.hasOwn(entries, name) &&
          !bundledAgentConfiguration().configuration.tools.includes(name)
        ) {
          throw new Error(`Tool ${name} is unavailable`);
        }
        const tool = Object.hasOwn(entries, name)
          ? await resolveToolSelection(name, entries[name], configRoot, catalogFile)
          : { name, source: 'bundled', revision: '1' };
        if ('rejection' in tool && tool.rejection !== undefined) {
          await fail(tool.rejection.reason);
          return 1;
        }
        await emit(tool);
        return 0;
      }
      if (command === 'activate' && folder !== undefined) {
        const absoluteFolder = decodeURIComponent(configurationFileUrl(folder).pathname);
        const selection = await resolveToolSelection(name, absoluteFolder, configRoot, catalogFile);
        if (selection.rejection !== undefined) throw new Error(selection.rejection.reason);
        entries[name] = absoluteFolder;
      } else if (command === 'deactivate') delete entries[name];
      else throw new CliInvocationError('Missing required --folder for tool activate');
    }
    await Deno.mkdir(configRoot, { recursive: true });
    await Deno.writeTextFile(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
    await emit({ ok: true, file: catalogFile });
    return 0;
  } catch (error) {
    await fail(cliErrorMessage(error));
    return 1;
  }
};
