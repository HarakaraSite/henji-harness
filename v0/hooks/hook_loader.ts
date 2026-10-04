import {
  type ConfigurationRejection,
  configurationRejection,
} from '../agent/configuration/agent_configuration.ts';
import {
  configurationFileUrl,
  type HookSelection,
} from '../agent/configuration/configuration_resolver.ts';
import {
  HOOK_PHASES,
  type HookFactoryInput,
  type HookHandlers,
  type HookPhase,
} from '../agent/hook_api.ts';

export interface LoadedWorkerHook {
  readonly selection: HookSelection;
  readonly handlers: HookHandlers;
}

const validateHandlers = (value: unknown): HookHandlers => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hook factory must return a HookHandlers object');
  }
  const source = value as Record<string, unknown>;
  const handlers: Partial<Record<HookPhase, (...args: never[]) => unknown>> = {};
  for (const phase of HOOK_PHASES) {
    const handler = source[phase];
    if (handler === undefined) continue;
    if (typeof handler !== 'function') {
      throw new Error(`HookHandlers.${phase} must be a function`);
    }
    handlers[phase] = handler as (...args: never[]) => unknown;
  }
  return Object.freeze(handlers) as HookHandlers;
};

/** External hook modules and closures are created inside the Worker. */
export const loadWorkerHooks = async (
  selections: readonly HookSelection[],
  input: HookFactoryInput,
): Promise<{
  readonly accepted: readonly LoadedWorkerHook[];
  readonly rejections: readonly ConfigurationRejection[];
}> => {
  const accepted: LoadedWorkerHook[] = [];
  const rejections: ConfigurationRejection[] = [];
  for (const selection of selections) {
    if (selection.rejection !== undefined) continue;
    try {
      if (selection.path === undefined) throw new Error('hook module path is unavailable');
      const module = await import(configurationFileUrl(selection.path).href);
      if (typeof module.default !== 'function') {
        throw new Error('module default export must be a hook factory');
      }
      const handlers = validateHandlers(await module.default(input));
      accepted.push(Object.freeze({ selection, handlers }));
    } catch (error) {
      rejections.push(configurationRejection('hook', selection.name, error, selection.path));
    }
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejections: Object.freeze(rejections),
  });
};
