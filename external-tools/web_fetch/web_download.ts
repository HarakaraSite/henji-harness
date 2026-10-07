import { ToolInputError, type ToolPathPolicy } from '@henji/tool';

interface WebDownloadTarget {
  readonly path: string;
  readonly parent: string;
}

export const resolveWebDownloadTarget = async (
  saveTo: string,
  pathPolicy: ToolPathPolicy,
  hasWorkspace: boolean,
): Promise<WebDownloadTarget> => {
  if (!saveTo.trim()) {
    throw new ToolInputError('save_to must be a non-empty path');
  }
  if (!saveTo.startsWith('/') && !hasWorkspace) {
    throw new ToolInputError('relative save_to requires a Session workspace');
  }

  const path = await pathPolicy.resolve(saveTo);
  const separator = path.lastIndexOf('/');
  const name = path.slice(separator + 1);
  const parent = path.slice(0, separator) || '/';
  if (!name) throw new ToolInputError('save_to must name a file');

  try {
    await Deno.lstat(path);
    throw new ToolInputError('save_to target already exists; choose another path');
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  return { path, parent };
};
