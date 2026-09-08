import { throwIfCancelled } from '../core/cancellation.ts';
import { ToolInputError } from './tools.ts';
import type { Workspace } from './work_tool_contract.ts';
import { MAX_PATH_BYTES, validTextArgument } from './work_tool_value.ts';

export const resolveWorkspace = async (
  root = Deno.cwd(),
): Promise<Workspace> => {
  const canonical = await Deno.realPath(root);
  const info = await Deno.lstat(canonical);
  if (!info.isDirectory) throw new Error('workspace root is not a directory');
  return { root: canonical };
};

const invalidPath = (): ToolInputError => new ToolInputError('path must stay within workspace');
const invalidSymlink = (): ToolInputError => new ToolInputError('path must not contain a symlink');

const splitAbsolute = (path: string): string[] => path.split('/').filter((part) => part.length > 0);

const normalizeAbsolute = (path: string): string => {
  const parts: string[] = [];
  for (const part of splitAbsolute(path)) {
    if (part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
};

const isWithin = (root: string, target: string): boolean => {
  if (target === root) return true;
  return target.startsWith(`${root}/`);
};

const relativePath = (root: string, target: string): string => {
  const result = target.slice(root.length).replace(/^\/+/, '');
  return result;
};

export interface CheckedPath {
  readonly absolute: string;
  readonly relative: string;
  readonly parent: string;
  readonly targetInfo?: Deno.FileInfo;
}

export const checkedPath = async (
  workspace: Workspace,
  input: unknown,
  allowMissingTarget: boolean,
  signal?: AbortSignal,
): Promise<CheckedPath> => {
  throwIfCancelled(signal);
  if (!validTextArgument(input, MAX_PATH_BYTES) || input.trim().length === 0) {
    throw invalidPath();
  }
  const path = input;
  const absolute = normalizeAbsolute(
    path.startsWith('/') ? path : `${workspace.root}/${path}`,
  );
  if (!isWithin(workspace.root, absolute)) throw invalidPath();
  const components = splitAbsolute(absolute).slice(
    splitAbsolute(workspace.root).length,
  );
  let current = workspace.root;
  for (const component of components) {
    current = current === '/' ? `/${component}` : `${current}/${component}`;
    try {
      const info = await Deno.lstat(current);
      throwIfCancelled(signal);
      if (info.isSymlink) throw invalidSymlink();
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      break;
    }
  }

  const parent = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
  let targetInfo: Deno.FileInfo | undefined;
  try {
    targetInfo = await Deno.lstat(absolute);
    throwIfCancelled(signal);
    if (targetInfo.isSymlink) throw invalidSymlink();
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    if (!(error instanceof Deno.errors.NotFound) || !allowMissingTarget) {
      throw error;
    }
  }
  return {
    absolute,
    relative: relativePath(workspace.root, absolute),
    parent,
    targetInfo,
  };
};

export const ensureParent = async (
  workspace: Workspace,
  path: string,
  create: boolean,
  signal?: AbortSignal,
): Promise<void> => {
  throwIfCancelled(signal);
  if (!isWithin(workspace.root, path)) throw invalidPath();
  const rootParts = splitAbsolute(workspace.root);
  const parts = splitAbsolute(path);
  if (parts.length < rootParts.length) throw invalidPath();
  let current = workspace.root;
  for (const part of parts.slice(rootParts.length)) {
    current = `${current}/${part}`;
    try {
      const info = await Deno.lstat(current);
      throwIfCancelled(signal);
      if (info.isSymlink) throw invalidSymlink();
      if (!info.isDirectory) throw new Error('parent is not a directory');
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      if (!create) throw error;
      await Deno.mkdir(current, { mode: 0o755 });
      throwIfCancelled(signal);
    }
  }
  // Re-check after mkdir so an ordinary race cannot turn the sibling into a link.
  let verify = workspace.root;
  for (const part of parts.slice(rootParts.length)) {
    verify = `${verify}/${part}`;
    const info = await Deno.lstat(verify);
    throwIfCancelled(signal);
    if (info.isSymlink) throw invalidSymlink();
    if (!info.isDirectory) throw new Error('parent is not a directory');
  }
};
