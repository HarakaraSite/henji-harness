import { ToolInputError, type Workspace } from '@henji/tool';

interface WebDownloadTarget {
  readonly path: string;
  readonly parent: string;
}

const splitAbsolute = (path: string): string[] => path.split('/').filter((part) => part.length > 0);

const normalizeAbsolute = (path: string): string => {
  const parts: string[] = [];
  for (const part of splitAbsolute(path)) {
    if (part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
};

const joinAbsolute = (parent: string, child: string): string =>
  parent === '/' ? `/${child}` : `${parent}/${child}`;

const isWithin = (root: string, path: string): boolean =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

const isAllowed = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => isWithin(root, path));

/** Resolve existing symlink components and retain the unresolved suffix lexically. */
const realPathWithMissingSuffix = async (path: string): Promise<string> => {
  const components = splitAbsolute(path);
  let current = '/';
  for (let index = 0; index < components.length; index += 1) {
    const candidate = joinAbsolute(current, components[index]!);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(candidate);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return normalizeAbsolute(
        [current, ...components.slice(index)].filter((part) => part.length > 0)
          .join('/'),
      );
    }
    current = info.isSymlink ? await Deno.realPath(candidate) : candidate;
  }
  return current;
};

export const resolveWebDownloadTarget = async (
  saveTo: string,
  workspace?: Workspace,
): Promise<WebDownloadTarget> => {
  const workspaceRoot = workspace === undefined ? undefined : await Deno.realPath(workspace.root);
  const temporaryRoot = await Deno.realPath('/tmp');
  const allowedRoots = [
    temporaryRoot,
    ...(workspaceRoot === undefined ? [] : [workspaceRoot]),
  ];
  if (!saveTo.trim()) {
    throw new ToolInputError('save_to must be a non-empty path');
  }
  if (!saveTo.startsWith('/') && workspaceRoot === undefined) {
    throw new ToolInputError('relative save_to requires a Session workspace');
  }

  const path = normalizeAbsolute(
    saveTo.startsWith('/') ? saveTo : joinAbsolute(workspaceRoot!, saveTo),
  );
  if (!isAllowed(path, allowedRoots)) {
    throw new ToolInputError(
      'save_to must stay within the Session workspace or /tmp',
    );
  }

  const separator = path.lastIndexOf('/');
  const name = path.slice(separator + 1);
  const parent = path.slice(0, separator) || '/';
  if (!name) throw new ToolInputError('save_to must name a file');

  const realParent = await realPathWithMissingSuffix(parent);
  const resolvedPath = joinAbsolute(realParent, name);
  if (
    !isAllowed(realParent, allowedRoots) ||
    !isAllowed(resolvedPath, allowedRoots)
  ) {
    throw new ToolInputError(
      'save_to must stay within the Session workspace or /tmp',
    );
  }

  let targetInfo: Deno.FileInfo | undefined;
  try {
    targetInfo = await Deno.lstat(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (targetInfo !== undefined) {
    const realTarget = await Deno.realPath(path);
    if (!isAllowed(realTarget, allowedRoots)) {
      throw new ToolInputError(
        'save_to must stay within the Session workspace or /tmp',
      );
    }
    throw new ToolInputError(
      'save_to target already exists; choose another path',
    );
  }

  return { path: resolvedPath, parent: realParent };
};
