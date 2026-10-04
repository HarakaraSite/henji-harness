import {
  type AgentConfiguration,
  bundledAgentConfiguration,
  ConfigurationFieldError,
  type ConfigurationRejection,
  configurationRejection,
  configurationString,
  isConfigurationObject,
  parseAgentConfiguration,
  type SelectedAgentConfiguration,
} from './agent_configuration.ts';
import { TOOL_API_CONTRACT } from '../tool_api.ts';
import { HOOK_API_CONTRACT } from '../hook_api.ts';

export interface AgentConfigurationChoice {
  readonly name?: string;
  readonly file?: string;
}

export interface AgentConfigurationCatalogEntry {
  readonly name: string;
  readonly file: string;
  readonly rejection?: ConfigurationRejection;
}

export interface ToolSelection {
  readonly name: string;
  readonly source: 'bundled' | 'external';
  readonly revision: string;
  readonly folder?: string;
  readonly entry?: string;
  readonly rejection?: ConfigurationRejection;
}

export interface HookSelection {
  readonly name: string;
  readonly path?: string;
  readonly contract: typeof HOOK_API_CONTRACT;
  readonly rejection?: ConfigurationRejection;
}

/** Tool names with implementations embedded in the Worker executable. */
export const BUNDLED_TOOL_NAMES: readonly string[] = Object.freeze([
  'read',
  'write',
  'edit',
  'bash',
  'bash_output',
  'skill',
  'submit_json_result',
]);

/** Resolve an unbound name without guessing an external folder path. */
export const defaultToolSelection = (
  name: string,
  bindingsFile: string,
): ToolSelection =>
  BUNDLED_TOOL_NAMES.includes(name)
    ? Object.freeze({ name, source: 'bundled' as const, revision: '1' })
    : Object.freeze({
      name,
      source: 'external' as const,
      revision: 'unavailable',
      rejection: configurationRejection(
        'tool',
        name,
        new Error(`Tool ${name} is not configured in tools.json`),
        bindingsFile,
      ),
    });

/** Serializable Host result; external executable values are created only inside a Worker. */
export interface WorkerConfigurationSelection {
  readonly agent?: SelectedAgentConfiguration;
  readonly agents: readonly AgentConfigurationCatalogEntry[];
  readonly tools: readonly ToolSelection[];
  readonly hooks: readonly HookSelection[];
  readonly rejections: readonly ConfigurationRejection[];
}

export const configurationFileUrl = (path: string, relativeTo = Deno.cwd()): URL => {
  const base = new URL('file:///');
  base.pathname = `${relativeTo.replace(/\/$/u, '')}/`;
  // Assigning pathname preserves literal # and ? in paths.
  if (path.startsWith('/')) {
    const absolute = new URL('file:///');
    absolute.pathname = path;
    return absolute;
  }
  return new URL(path.split('/').map(encodeURIComponent).join('/'), base);
};

const absolutePath = (path: string, relativeTo: string): string =>
  decodeURIComponent(configurationFileUrl(path, relativeTo).pathname);

const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await Deno.readTextFile(file));

const readOptionalJson = async (file: string): Promise<unknown | undefined> => {
  try {
    return await readJson(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
};

const catalogEntries = (
  value: unknown,
  field: 'agents' | 'tools',
): Record<string, unknown> => {
  if (
    !isConfigurationObject(value) || value.schemaVersion !== 1 ||
    !isConfigurationObject(value[field])
  ) {
    throw new ConfigurationFieldError(
      field,
      `${field}.json must contain schemaVersion 1 and ${field}`,
    );
  }
  return value[field];
};

const configuredNames = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new ConfigurationFieldError(field, `${field} must be an array of names`);
  }
  return Object.freeze([...new Set(value.map((name) => configurationString(name, field)))]);
};

const resolveHookSelections = async (
  configuration: AgentConfiguration,
  configRoot: string,
  rejections: ConfigurationRejection[],
): Promise<readonly HookSelection[]> => {
  if (configuration.hooks?.length === 0) return Object.freeze([]);

  const hooksFile = `${configRoot}/hooks.json`;
  let catalog: Record<string, unknown>;
  let defaultNames: readonly string[] = Object.freeze([]);
  try {
    const value = await readOptionalJson(hooksFile);
    if (value === undefined) {
      if (configuration.hooks === undefined) return Object.freeze([]);
      catalog = {};
    } else {
      if (
        !isConfigurationObject(value) || value.schemaVersion !== 1 ||
        !isConfigurationObject(value.hooks)
      ) {
        throw new ConfigurationFieldError(
          'hooks',
          'hooks.json must contain schemaVersion 1 and hooks',
        );
      }
      catalog = value.hooks;
      defaultNames = configuredNames(value.default, 'default');
    }
  } catch (error) {
    rejections.push(configurationRejection('catalog', 'hooks', error, hooksFile));
    return Object.freeze([]);
  }

  const selectedNames = configuration.hooks ?? defaultNames;
  const selections: HookSelection[] = [];
  for (const name of selectedNames) {
    let path: string | undefined;
    try {
      if (!Object.hasOwn(catalog, name)) {
        throw new Error(`Hook ${name} is not configured in hooks.json`);
      }
      path = absolutePath(configurationString(catalog[name], `hooks.${name}`), configRoot);
      selections.push(Object.freeze({ name, path, contract: HOOK_API_CONTRACT }));
    } catch (error) {
      const rejection = configurationRejection('hook', name, error, hooksFile);
      rejections.push(rejection);
      selections.push(Object.freeze({
        name,
        ...(path === undefined ? {} : { path }),
        contract: HOOK_API_CONTRACT,
        rejection,
      }));
    }
  }
  return Object.freeze(selections);
};

export const resolveToolSelection = async (
  name: string,
  folderValue: unknown,
  configRoot: string,
  bindingsFile: string,
): Promise<ToolSelection> => {
  let folder: string | undefined;
  let metadataFile = bindingsFile;
  try {
    folder = absolutePath(configurationString(folderValue, `tools.${name}`), configRoot);
    metadataFile = `${folder}/tool.json`;
    const value = await readJson(metadataFile);
    if (!isConfigurationObject(value)) {
      throw new ConfigurationFieldError('tool', 'tool.json must be an object');
    }
    if (configurationString(value.name, 'name') !== name) {
      throw new ConfigurationFieldError('name', `tool.json name must be ${name}`);
    }
    if (value.apiContract !== TOOL_API_CONTRACT) {
      throw new ConfigurationFieldError('apiContract', `apiContract must be ${TOOL_API_CONTRACT}`);
    }
    return Object.freeze({
      name,
      source: 'external' as const,
      folder,
      revision: configurationString(value.revision, 'revision'),
      entry: absolutePath(configurationString(value.entry, 'entry'), folder),
    });
  } catch (error) {
    return Object.freeze({
      name,
      source: 'external' as const,
      revision: 'unavailable',
      ...(folder === undefined ? {} : { folder }),
      rejection: configurationRejection('tool', name, error, metadataFile),
    });
  }
};

/** Resolve current files anew for every Worker startup, without an immutable source store. */
export const resolveWorkerConfiguration = async (
  configRoot: string,
  choice: AgentConfigurationChoice = {},
): Promise<WorkerConfigurationSelection> => {
  const rejections: ConfigurationRejection[] = [];
  const agents: AgentConfigurationCatalogEntry[] = [];
  const agentsFile = `${configRoot}/agents.json`;
  let rootFile: unknown;
  let catalogRejection: ConfigurationRejection | undefined;
  try {
    const value = await readOptionalJson(agentsFile);
    if (value !== undefined) {
      const entries = catalogEntries(value, 'agents');
      rootFile = (value as Record<string, unknown>).default;
      for (const [name, fileValue] of Object.entries(entries)) {
        let file = agentsFile;
        try {
          if (name === 'generic') {
            throw new ConfigurationFieldError(
              'agents.generic',
              'generic uses the bundled configuration',
            );
          }
          file = absolutePath(configurationString(fileValue, `agents.${name}`), configRoot);
          const configuration = parseAgentConfiguration(await readJson(file), Object.keys(entries));
          if (configuration.name !== name) {
            throw new ConfigurationFieldError('name', `Agent JSON name must be ${name}`);
          }
          agents.push(Object.freeze({ name, file }));
        } catch (error) {
          const rejection = configurationRejection('agent', name, error, file);
          rejections.push(rejection);
          agents.push(Object.freeze({ name, file, rejection }));
        }
      }
    }
  } catch (error) {
    catalogRejection = configurationRejection('catalog', 'agents', error, agentsFile);
    rejections.push(catalogRejection);
  }
  let agent: SelectedAgentConfiguration | undefined;
  const selectedName = choice.name ?? 'default';
  let selectedFile = agentsFile;
  try {
    if (choice.file !== undefined && choice.name !== undefined) {
      throw new ConfigurationFieldError('choice', 'choose an Agent name or JSON file');
    }
    if (choice.file !== undefined) {
      selectedFile = absolutePath(choice.file, Deno.cwd());
    } else if (selectedName === 'generic') {
      agent = bundledAgentConfiguration(agents.map((entry) => entry.name), true);
    } else {
      if (catalogRejection !== undefined) throw new Error(catalogRejection.reason);
      const named = agents.find((entry) => entry.name === selectedName);
      const fileValue = choice.name === undefined ? rootFile : named?.file;
      if (fileValue === undefined) {
        if (choice.name !== undefined) throw new Error(`Agent ${selectedName} is not configured`);
        agent = bundledAgentConfiguration(agents.map((entry) => entry.name));
      } else {
        selectedFile = absolutePath(configurationString(fileValue, 'default'), configRoot);
      }
    }
    if (agent === undefined) {
      const configuration = parseAgentConfiguration(
        await readJson(selectedFile),
        agents.map((entry) => entry.name),
      );
      if (
        choice.file === undefined && choice.name !== undefined &&
        configuration.name !== selectedName
      ) {
        throw new ConfigurationFieldError('name', `Agent JSON name must be ${selectedName}`);
      }
      agent = Object.freeze({
        configuration,
        source: { kind: 'external' as const, file: selectedFile },
      });
    }
  } catch (error) {
    rejections.push(configurationRejection('agent', selectedName, error, selectedFile));
  }

  const tools: ToolSelection[] = [];
  let hooks: readonly HookSelection[] = Object.freeze([]);
  if (agent !== undefined) {
    const bindingsFile = `${configRoot}/tools.json`;
    try {
      const value = await readOptionalJson(bindingsFile);
      const entries = value === undefined ? {} : catalogEntries(value, 'tools');
      for (const name of agent.configuration.tools) {
        const selected: ToolSelection = Object.hasOwn(entries, name)
          ? await resolveToolSelection(name, entries[name], configRoot, bindingsFile)
          : defaultToolSelection(name, bindingsFile);
        tools.push(selected);
        if (selected.rejection !== undefined) rejections.push(selected.rejection);
      }
    } catch (error) {
      // A malformed catalog cannot identify which replacements were explicitly chosen.
      // Reject this Agent's unresolved tool configuration instead of silently using bundled tools.
      rejections.push(configurationRejection('catalog', 'tools', error, bindingsFile));
      agent = undefined;
    }
    if (agent !== undefined) {
      hooks = await resolveHookSelections(agent.configuration, configRoot, rejections);
    }
  }
  return Object.freeze({
    ...(agent === undefined ? {} : { agent }),
    agents: Object.freeze(agents),
    tools: Object.freeze(tools),
    hooks,
    rejections: Object.freeze(rejections),
  });
};
