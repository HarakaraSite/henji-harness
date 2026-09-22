export interface RuntimePaths {
  readonly executable: string;
  readonly workspace: string;
  readonly configRoot: string;
  readonly dataRoot: string;
  readonly stateRoot: string;
}

export interface RuntimePathOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
  readonly workspace?: string;
}

export const readRuntimeEnvironment = (): Readonly<Record<string, string | undefined>> => ({
  HOME: Deno.env.get('HOME'),
  XDG_CONFIG_HOME: Deno.env.get('XDG_CONFIG_HOME'),
  XDG_DATA_HOME: Deno.env.get('XDG_DATA_HOME'),
  XDG_STATE_HOME: Deno.env.get('XDG_STATE_HOME'),
  ZOT_HOME: Deno.env.get('ZOT_HOME'),
});

const absoluteRoot = (value: string | undefined, label: string): string => {
  if (
    value === undefined || value.trim() === '' || !value.startsWith('/') ||
    value.includes('\0') || value.includes('\r') || value.includes('\n')
  ) throw new Error(`invalid ${label}`);
  return value.endsWith('/') && value !== '/' ? value.slice(0, -1) : value;
};

const child = (root: string, suffix: string): string =>
  root === '/' ? `/${suffix}` : `${root}/${suffix}`;

export const resolveRuntimePaths = (options: RuntimePathOptions = {}): RuntimePaths => {
  const env = options.env ?? readRuntimeEnvironment();
  let home: string | undefined;
  const fallbackHome = (): string => home ??= absoluteRoot(env.HOME, 'HOME');
  const configBase = env.XDG_CONFIG_HOME?.trim()
    ? absoluteRoot(env.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME')
    : child(fallbackHome(), '.config');
  const dataBase = env.XDG_DATA_HOME?.trim()
    ? absoluteRoot(env.XDG_DATA_HOME, 'XDG_DATA_HOME')
    : child(fallbackHome(), '.local/share');
  const stateBase = env.XDG_STATE_HOME?.trim()
    ? absoluteRoot(env.XDG_STATE_HOME, 'XDG_STATE_HOME')
    : child(fallbackHome(), '.local/state');
  return Object.freeze({
    executable: absoluteRoot(options.executable ?? Deno.execPath(), 'executable path'),
    workspace: absoluteRoot(options.workspace ?? Deno.cwd(), 'workspace path'),
    configRoot: child(configBase, 'henji-harness'),
    dataRoot: child(dataBase, 'henji-harness'),
    stateRoot: child(stateBase, 'henji-harness/v1'),
  });
};

export const credentialPath = (
  profile: string,
  options: RuntimePathOptions = {},
): string => `${resolveRuntimePaths(options).configRoot}/${profile}`;
