export const TYPESCRIPT_ENV_NAMES = Object.freeze(
  [
    'TSC_WATCHFILE',
    'TSC_NONPOLLING_WATCHER',
    'TSC_WATCHDIRECTORY',
    'NODE_INSPECTOR_IPC',
    'VSCODE_INSPECTOR_OPTIONS',
    'NODE_ENV',
    'TSC_WATCH_POLLINGINTERVAL_LOW',
    'TSC_WATCH_POLLINGINTERVAL_MEDIUM',
    'TSC_WATCH_POLLINGINTERVAL_HIGH',
    'TSC_WATCH_POLLINGCHUNKSIZE_LOW',
    'TSC_WATCH_POLLINGCHUNKSIZE_MEDIUM',
    'TSC_WATCH_POLLINGCHUNKSIZE_HIGH',
    'TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_LOW',
    'TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_MEDIUM',
    'TSC_WATCH_UNCHANGEDPOLLTHRESHOLDS_HIGH',
  ] as const,
);

export const validateBuilderEnvironment = (): void => {
  for (const name of TYPESCRIPT_ENV_NAMES) {
    if (Deno.env.get(name) !== undefined) throw new Error('Builder environment was not cleared');
  }
  try {
    Deno.env.toObject();
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) return;
    throw error;
  }
  throw new Error('Builder can enumerate Supervisor environment');
};
