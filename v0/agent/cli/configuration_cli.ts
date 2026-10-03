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

const options = (args: readonly string[]): Map<string, string> => {
  if (args.length % 2 !== 0) throw new Error('Options need a value');
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--name', '--file', '--folder'].includes(args[i]) || result.has(args[i])) {
      throw new Error(`Invalid option ${args[i]}`);
    }
    result.set(args[i], configurationString(args[i + 1], args[i]));
  }
  return result;
};

/** Catalog edits select current external files; they never archive or execute source. */
export const configurationMain = async (
  kind: 'agent' | 'tool',
  args: readonly string[],
  dependencies: ConfigurationCliDependencies = {},
): Promise<number> => {
  const encoder = new TextEncoder();
  const emit = async (value: unknown, error = false): Promise<void> => {
    const text = JSON.stringify(value) + '\n';
    const writer = error ? dependencies.writeStderr : dependencies.writeStdout;
    if (writer === undefined) await (error ? Deno.stderr : Deno.stdout).write(encoder.encode(text));
    else await writer(text);
  };
  try {
    const configRoot = dependencies.configRoot ?? resolveRuntimePaths().configRoot;
    const command = args[0];
    const flags = options(args.slice(1));
    const name = flags.get('--name');
    const file = flags.get('--file');
    const folder = flags.get('--folder');
    const catalogKind = kind === 'agent' ? 'agents' : 'tools';
    const catalogFile = `${configRoot}/${catalogKind}.json`;
    const catalog = await readCatalog(catalogFile, catalogKind);
    const entries = catalog[catalogKind] as Record<string, unknown>;
    if (kind === 'agent') {
      if (
        folder !== undefined || name !== undefined && file !== undefined && command !== 'activate'
      ) {
        throw new Error('Choose an Agent name or JSON file');
      }
      if (command === 'list' && flags.size === 0) {
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
        await emit(selected);
        return selected.agent === undefined ? 1 : 0;
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
      } else if (command === 'deactivate' && file === undefined) {
        if (name === undefined) delete catalog.default;
        else delete entries[name];
      } else throw new Error('Invalid Agent configuration command');
    } else {
      if (file !== undefined) throw new Error('Tools use --folder');
      if (command === 'list' && flags.size === 0) {
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
      if (name === undefined) throw new Error('Tool name is required');
      if (command === 'inspect' && folder === undefined) {
        if (
          !Object.hasOwn(entries, name) &&
          !bundledAgentConfiguration().configuration.tools.includes(name)
        ) {
          throw new Error(`Tool ${name} is unavailable`);
        }
        const tool = Object.hasOwn(entries, name)
          ? await resolveToolSelection(name, entries[name], configRoot, catalogFile)
          : { name, source: 'bundled', revision: '1' };
        await emit(tool);
        return 'rejection' in tool ? 1 : 0;
      }
      if (command === 'activate' && folder !== undefined) {
        const absoluteFolder = decodeURIComponent(configurationFileUrl(folder).pathname);
        const selection = await resolveToolSelection(name, absoluteFolder, configRoot, catalogFile);
        if (selection.rejection !== undefined) throw new Error(selection.rejection.reason);
        entries[name] = absoluteFolder;
      } else if (command === 'deactivate' && folder === undefined) delete entries[name];
      else throw new Error('Invalid tool configuration command');
    }
    await Deno.mkdir(configRoot, { recursive: true });
    await Deno.writeTextFile(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
    await emit({ ok: true, file: catalogFile });
    return 0;
  } catch (error) {
    await emit({
      ok: false,
      error: {
        code: 'configuration_command_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }, true);
    return 1;
  }
};
