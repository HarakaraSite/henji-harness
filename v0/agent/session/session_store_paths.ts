import { SessionStoreError } from './session_store_contract.ts';
import { readRuntimeEnvironment, resolveRuntimePaths } from '../runtime/runtime_paths.ts';

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
  env: Readonly<Record<string, string | undefined>> = readRuntimeEnvironment(),
): string => {
  try {
    return resolveRuntimePaths({ env }).stateRoot;
  } catch {
    throw new SessionStoreError('session_io_failure');
  }
};

/** Resolve the launcher-owned root when production startup has already completed preflight. */
export const launcherStateRoot = (): string => {
  try {
    return resolveRuntimePaths().stateRoot;
  } catch {
    throw new SessionStoreError('session_io_failure');
  }
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
