import {
  decodeProviderEvidence,
  encodeProviderEvidence,
  type ProviderEvidenceStore,
  type ProviderEvidenceV2,
  validateProviderEvidence,
} from './provider_evidence.ts';
import { workspaceDigest } from '../session/session_store.ts';

export class ProviderEvidenceStoreError extends Error {
  constructor(
    readonly code:
      | 'provider_evidence_not_found'
      | 'provider_evidence_invalid'
      | 'provider_evidence_io_failure',
    message = code,
  ) {
    super(message);
    this.name = 'ProviderEvidenceStoreError';
  }
}

export interface ProviderEvidencePaths {
  readonly root: string;
  readonly evidence: string;
  readonly links: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const providerEvidencePaths = async (
  stateRoot: string,
  workspaceRoot: string,
): Promise<ProviderEvidencePaths> => {
  let digest: string;
  try {
    digest = await workspaceDigest(workspaceRoot);
  } catch {
    throw new ProviderEvidenceStoreError('provider_evidence_invalid');
  }
  const root = `${stateRoot}/${digest}`;
  return {
    root,
    evidence: `${root}/provider-evidence`,
    links: `${root}/provider-evidence-links`,
  };
};

const isNotFound = (error: unknown): boolean => error instanceof Deno.errors.NotFound;
const ensureDirectory = async (path: string): Promise<void> => {
  try {
    await Deno.mkdir(path, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(path);
    if (
      info.isSymlink || !info.isDirectory ||
      info.mode !== null && (info.mode & 0o777) !== 0o700
    ) throw new ProviderEvidenceStoreError('provider_evidence_invalid');
    await Deno.chmod(path, 0o700);
  } catch (error) {
    throw error instanceof ProviderEvidenceStoreError
      ? error
      : new ProviderEvidenceStoreError('provider_evidence_io_failure');
  }
};

const idFromPath = (id: string, suffix: string): string => {
  if (!UUID_V4.test(id)) throw new ProviderEvidenceStoreError('provider_evidence_invalid');
  return `${id}${suffix}`;
};

export class DenoProviderEvidenceStore implements ProviderEvidenceStore {
  readonly pathsPromise: Promise<ProviderEvidencePaths>;

  constructor(readonly stateRoot: string, readonly workspaceRoot: string) {
    this.pathsPromise = providerEvidencePaths(stateRoot, workspaceRoot);
  }

  private async layout(): Promise<ProviderEvidencePaths> {
    const paths = await this.pathsPromise;
    await ensureDirectory(this.stateRoot);
    await ensureDirectory(paths.root);
    await ensureDirectory(paths.evidence);
    await ensureDirectory(paths.links);
    return paths;
  }

  async list(): Promise<readonly ProviderEvidenceV2[]> {
    const paths = await this.pathsPromise;
    const result: ProviderEvidenceV2[] = [];
    try {
      for await (const entry of Deno.readDir(paths.evidence)) {
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        const evidence = decodeProviderEvidence(
          await Deno.readFile(`${paths.evidence}/${entry.name}`),
        );
        if (!validateProviderEvidence(evidence) || evidence.evidenceId !== id) {
          throw new ProviderEvidenceStoreError('provider_evidence_invalid');
        }
        result.push(evidence);
      }
    } catch (error) {
      if (isNotFound(error)) return [];
      if (error instanceof ProviderEvidenceStoreError) throw error;
      throw new ProviderEvidenceStoreError('provider_evidence_io_failure');
    }
    return result.sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.evidenceId.localeCompare(right.evidenceId)
        : left.createdAt.localeCompare(right.createdAt)
    );
  }

  async read(id: string): Promise<ProviderEvidenceV2> {
    const paths = await this.pathsPromise;
    const name = idFromPath(id, '.json');
    try {
      const evidence = decodeProviderEvidence(await Deno.readFile(`${paths.evidence}/${name}`));
      if (evidence.evidenceId !== id) {
        throw new ProviderEvidenceStoreError('provider_evidence_invalid');
      }
      return evidence;
    } catch (error) {
      if (error instanceof ProviderEvidenceStoreError) throw error;
      if (isNotFound(error)) throw new ProviderEvidenceStoreError('provider_evidence_not_found');
      throw new ProviderEvidenceStoreError('provider_evidence_io_failure');
    }
  }

  async write(evidence: ProviderEvidenceV2): Promise<void> {
    if (!validateProviderEvidence(evidence)) {
      throw new ProviderEvidenceStoreError('provider_evidence_invalid');
    }
    const paths = await this.layout();
    const body = `${encodeProviderEvidence(evidence)}\n`;
    try {
      await Deno.writeTextFile(
        `${paths.evidence}/${idFromPath(evidence.evidenceId, '.json')}`,
        body,
      );
    } catch (error) {
      if (error instanceof ProviderEvidenceStoreError) throw error;
      throw new ProviderEvidenceStoreError('provider_evidence_io_failure');
    }
  }

  async linkDiagnostic(diagnosticId: string, evidenceId: string): Promise<void> {
    if (!UUID_V4.test(diagnosticId) || !UUID_V4.test(evidenceId)) {
      throw new ProviderEvidenceStoreError('provider_evidence_invalid');
    }
    const paths = await this.layout();
    try {
      await this.read(evidenceId);
      await Deno.writeTextFile(
        `${paths.links}/${idFromPath(diagnosticId, '.json')}`,
        `${JSON.stringify({ schemaVersion: 1, diagnosticId, evidenceId })}\n`,
      );
    } catch (error) {
      if (error instanceof ProviderEvidenceStoreError) throw error;
      throw new ProviderEvidenceStoreError('provider_evidence_io_failure');
    }
  }

  async readDiagnosticLink(diagnosticId: string): Promise<string> {
    const paths = await this.pathsPromise;
    if (!UUID_V4.test(diagnosticId)) {
      throw new ProviderEvidenceStoreError('provider_evidence_invalid');
    }
    try {
      const parsed: unknown = JSON.parse(
        await Deno.readTextFile(`${paths.links}/${diagnosticId}.json`),
      );
      if (
        typeof parsed !== 'object' || parsed === null ||
        (parsed as Record<string, unknown>).schemaVersion !== 1 ||
        (parsed as Record<string, unknown>).diagnosticId !== diagnosticId ||
        !UUID_V4.test(String((parsed as Record<string, unknown>).evidenceId))
      ) throw new ProviderEvidenceStoreError('provider_evidence_invalid');
      return (parsed as { readonly evidenceId: string }).evidenceId;
    } catch (error) {
      if (error instanceof ProviderEvidenceStoreError) throw error;
      if (isNotFound(error)) throw new ProviderEvidenceStoreError('provider_evidence_not_found');
      throw new ProviderEvidenceStoreError('provider_evidence_io_failure');
    }
  }
}
