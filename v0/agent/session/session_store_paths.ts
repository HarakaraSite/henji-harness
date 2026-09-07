import { SessionStoreError } from './session_store_contract.ts';

const encoder = new TextEncoder();

export const canonicalAbsolutePath = (value: string): string | undefined => {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('//')) {
    return undefined;
  }
  if (value === '/') return value;
  const parts: string[] = [];
  for (const part of value.split('/').slice(1)) {
    if (part === '' || part === '.') return undefined;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  const result = `/${parts.join('/')}`;
  return result === value ? result : undefined;
};

export const workspaceDigest = async (
  workspaceRoot: string,
): Promise<string> => {
  if (
    typeof workspaceRoot !== 'string' ||
    canonicalAbsolutePath(workspaceRoot) === undefined ||
    workspaceRoot.trim() !== workspaceRoot
  ) {
    throw new SessionStoreError('session_invalid');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(workspaceRoot),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const selectStateRoot = (
  env: Readonly<Record<string, string | undefined>> = Deno.env.toObject(),
): string => {
  const xdg = env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg.trim() !== '') {
    if (
      !xdg.startsWith('/') || xdg.includes('\0') || xdg.includes('\r') ||
      xdg.includes('\n')
    ) {
      throw new SessionStoreError('session_io_failure');
    }
    return `${xdg}/henji-harness`;
  }
  const home = env.HOME;
  if (home !== undefined && home.trim() !== '') {
    if (
      !home.startsWith('/') || home.includes('\0') || home.includes('\r') ||
      home.includes('\n')
    ) {
      throw new SessionStoreError('session_io_failure');
    }
    return `${home}/.local/state/henji-harness`;
  }
  throw new SessionStoreError('session_io_failure');
};

/** Resolve the launcher-owned root when production startup has already completed preflight. */
export const launcherStateRoot = (): string => {
  let supplied: string | undefined;
  try {
    supplied = Deno.env.get('HENJI_SESSION_STATE_ROOT');
  } catch {
    // Permission-free direct callers use the explicit XDG/HOME seam below.
  }
  if (supplied !== undefined) {
    if (
      supplied.trim() === '' || !supplied.startsWith('/') ||
      supplied.includes('\0') ||
      supplied.includes('\r') || supplied.includes('\n')
    ) throw new SessionStoreError('session_io_failure');
    return supplied;
  }
  return selectStateRoot();
};

export const sessionPaths = async (
  stateRoot: string,
  workspaceRoot: string,
) => {
  if (
    typeof stateRoot !== 'string' || !stateRoot.startsWith('/') ||
    stateRoot.trim() === '' ||
    stateRoot.includes('\0') || stateRoot.includes('\r') ||
    stateRoot.includes('\n')
  ) throw new SessionStoreError('session_io_failure');
  const digest = await workspaceDigest(workspaceRoot);
  const base = `${stateRoot}/${digest}`;
  return {
    root: base,
    sessions: `${base}/sessions`,
    locks: `${base}/locks`,
    contexts: `${base}/contexts`,
    historyExports: `${base}/history-exports`,
  } as const;
};
