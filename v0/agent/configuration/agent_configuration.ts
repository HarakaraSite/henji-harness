import defaultAgent from './default-agent.json' with { type: 'json' };

/** Data loaded for one Worker startup. Revision is an arbitrary label. */
export interface AgentConfiguration {
  readonly name: string;
  readonly revision: string;
  readonly instruction: string;
  readonly tools: readonly string[];
  readonly agents: readonly string[];
  /** Omitted selects hooks.json defaults; an explicit empty list disables external hooks. */
  readonly hooks?: readonly string[];
}

export interface ConfigurationRejection {
  readonly target: 'agent' | 'tool' | 'hook' | 'catalog';
  readonly name: string;
  readonly file?: string;
  readonly field?: string;
  readonly reason: string;
}

export interface ConfigurationSource {
  readonly kind: 'bundled' | 'external';
  readonly file?: string;
}

export interface SelectedAgentConfiguration {
  readonly configuration: AgentConfiguration;
  readonly source: ConfigurationSource;
}

export const isConfigurationObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export class ConfigurationFieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ConfigurationFieldError';
  }
}

export const configurationString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigurationFieldError(field, `${field} must be a nonempty string`);
  }
  return value;
};

const names = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value)) {
    throw new ConfigurationFieldError(field, `${field} must be an array of names`);
  }
  return Object.freeze([...new Set(value.map((name) => configurationString(name, field)))]);
};

export const parseAgentConfiguration = (
  value: unknown,
  availableAgentNames: readonly string[] = [],
): AgentConfiguration => {
  if (!isConfigurationObject(value)) {
    throw new ConfigurationFieldError('configuration', 'Agent JSON must be an object');
  }
  if (value.instruction !== undefined && typeof value.instruction !== 'string') {
    throw new ConfigurationFieldError('instruction', 'instruction must be a string');
  }
  return Object.freeze({
    name: configurationString(value.name, 'name'),
    revision: value.revision === undefined
      ? 'unversioned'
      : configurationString(value.revision, 'revision'),
    instruction: value.instruction === undefined ? defaultAgent.instruction : value.instruction,
    tools: names(value.tools === undefined ? defaultAgent.tools : value.tools, 'tools'),
    agents: names(
      value.agents === undefined ? ['generic', ...availableAgentNames] : value.agents,
      'agents',
    ),
    ...(value.hooks === undefined ? {} : { hooks: names(value.hooks, 'hooks') }),
  });
};

/** Generic has no dedicated Definition and does not inherit an external parent's role text. */
export const bundledAgentConfiguration = (
  availableAgentNames: readonly string[] = [],
  generic = false,
): SelectedAgentConfiguration =>
  Object.freeze({
    source: Object.freeze({ kind: 'bundled' as const }),
    configuration: parseAgentConfiguration(
      generic ? { ...defaultAgent, name: 'generic' } : defaultAgent,
      availableAgentNames,
    ),
  });

export const configurationRejection = (
  target: ConfigurationRejection['target'],
  name: string,
  error: unknown,
  file?: string,
): ConfigurationRejection =>
  Object.freeze({
    target,
    name,
    ...(file === undefined ? {} : { file }),
    ...(error instanceof ConfigurationFieldError ? { field: error.field } : {}),
    reason: error instanceof Error ? error.message : String(error),
  });
