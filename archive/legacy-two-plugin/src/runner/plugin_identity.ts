export const pluginIdentity = async (
  id: string,
  version: string,
  sources: Readonly<Record<string, string>>,
): Promise<{ id: string; version: string; sourceHash: string }> => {
  const source = Object.entries(sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, contents]) => `${path}\u0000${contents}`)
    .join('\u0000');
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    id,
    version,
    sourceHash: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0'))
      .join(''),
  };
};

export const pluginSourcePaths = (
  id: 'task-planner' | 'model-adapter',
  checkoutRoot = new URL('../../', import.meta.url).pathname,
): Readonly<Record<string, string>> => {
  const root = checkoutRoot.replace(/\/$/, '');
  if (id === 'task-planner') {
    return {
      'main.ts': `${root}/plugins/task-planner/main.ts`,
      'prompt.ts': `${root}/plugins/task-planner/prompt.ts`,
      'plan_parser.ts': `${root}/plugins/task-planner/plan_parser.ts`,
    };
  }
  return {
    'main.ts': `${root}/plugins/model-adapter/main.ts`,
    'provider_codec.ts': `${root}/plugins/model-adapter/provider_codec.ts`,
    '../../src/domain/model.ts': `${root}/src/domain/model.ts`,
    '../../src/domain/errors.ts': `${root}/src/domain/errors.ts`,
  };
};

export const pluginIdentityFromFiles = async (
  id: string,
  version: string,
  sourcePaths: Readonly<Record<string, string>>,
  readSource: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<{ id: string; version: string; sourceHash: string }> => {
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(sourcePaths).map(async ([logicalPath, absolutePath]) => [
        logicalPath,
        await readSource(absolutePath),
      ]),
    ),
  );
  return await pluginIdentity(id, version, sources);
};
