import { canonicalBytes } from '../../spike0/src/canonical_content.ts';
import { ADMISSION_LIMITS } from './admission_profile.ts';
import type { ArtifactStoreEntryV1, ArtifactStoreIndexV1 } from './artifact_store.ts';
import {
  type AdmissionRecordV1,
  validateAdmissionRecord,
  validateAdmissionRecordIntegrity,
} from './admission_record.ts';
import { exactObject, isPlainObject } from './runtime_schema.ts';

export interface AdmissionRegistryV1 {
  readonly schemaVersion: 'admission-registry/v1';
  readonly entries: Readonly<Record<string, AdmissionRecordV1>>;
}
export type ReservationFailure = 'registry_capacity' | 'artifact_capacity';
export type ReservationResult<T> =
  | { readonly status: 'reserved'; readonly value: T }
  | { readonly status: 'rejected'; readonly code: ReservationFailure };
interface TransactionContextV1 {
  readonly existing: AdmissionRecordV1 | undefined;
  commitArtifact(entry: ArtifactStoreEntryV1): void;
  appendRecord(record: AdmissionRecordV1): Promise<void>;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
};
const cloneFrozen = <T>(value: T): T => deepFreeze(structuredClone(value));

export const validateAdmissionRegistrySnapshot = async (
  input: unknown,
): Promise<AdmissionRegistryV1> => {
  const root = exactObject(input, ['schemaVersion', 'entries'], '$registry');
  if (root.schemaVersion !== 'admission-registry/v1' || !isPlainObject(root.entries)) {
    throw new Error('registry schema');
  }
  const keys = Reflect.ownKeys(root.entries);
  if (keys.some((key) => typeof key !== 'string')) throw new Error('registry symbol key');
  if (keys.length > ADMISSION_LIMITS.registryEntries) throw new Error('registry entry count');
  const admissionIds = new Set<string>();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(root.entries, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('registry data entry');
    const record = validateAdmissionRecord(descriptor.value);
    if (record.admissionKey !== key || admissionIds.has(record.admissionId)) {
      throw new Error('registry identity');
    }
    admissionIds.add(record.admissionId);
  }
  if (canonicalBytes(root).byteLength > ADMISSION_LIMITS.registryCanonicalBytes) {
    throw new Error('registry canonical bytes');
  }
  const snapshot = cloneFrozen(input as AdmissionRegistryV1);
  for (const record of Object.values(snapshot.entries)) {
    await validateAdmissionRecordIntegrity(record);
  }
  return snapshot;
};

export const validateArtifactIndexSnapshot = (input: unknown): ArtifactStoreIndexV1 => {
  const root = exactObject(input, ['schemaVersion', 'entries'], '$artifactIndex');
  if (root.schemaVersion !== 'artifact-store-index/v1' || !isPlainObject(root.entries)) {
    throw new Error('artifact index schema');
  }
  const keys = Reflect.ownKeys(root.entries);
  if (keys.some((key) => typeof key !== 'string')) throw new Error('artifact index symbol key');
  if (keys.length > ADMISSION_LIMITS.artifactIndexEntries) throw new Error('artifact index count');
  let artifactBytes = 0;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(root.entries, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('artifact data entry');
    const entry = exactObject(descriptor.value, ['artifactHash', 'byteCount'], '$artifactEntry');
    if (
      !/^sha256:[0-9a-f]{64}$/.test(String(entry.artifactHash)) || entry.artifactHash !== key ||
      !Number.isSafeInteger(entry.byteCount) || Number(entry.byteCount) < 0 ||
      Number(entry.byteCount) > ADMISSION_LIMITS.emittedArtifactBytes
    ) throw new Error('artifact index entry');
    artifactBytes += Number(entry.byteCount);
  }
  if (
    artifactBytes > ADMISSION_LIMITS.artifactStoreBytes ||
    canonicalBytes(root).byteLength > ADMISSION_LIMITS.artifactIndexCanonicalBytes
  ) throw new Error('artifact index bytes');
  return cloneFrozen(input as ArtifactStoreIndexV1);
};

export class AdmissionStateStore {
  #unvalidatedRegistry: unknown;
  #unvalidatedArtifacts: unknown;
  #registrySchemaVersion: unknown = undefined;
  #artifactSchemaVersion: unknown = undefined;
  #registry: Record<string, AdmissionRecordV1> = {};
  #artifacts: Record<string, ArtifactStoreEntryV1> = {};
  #validated = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(registry: AdmissionRegistryV1, artifacts: ArtifactStoreIndexV1) {
    this.#unvalidatedRegistry = registry;
    this.#unvalidatedArtifacts = artifacts;
  }
  async validateSnapshots(): Promise<void> {
    if (this.#validated) {
      await validateAdmissionRegistrySnapshot(this.registrySnapshot());
      validateArtifactIndexSnapshot(this.artifactSnapshot());
      return;
    }
    const registryValidation = validateAdmissionRegistrySnapshot(this.#unvalidatedRegistry);
    const artifacts = validateArtifactIndexSnapshot(this.#unvalidatedArtifacts);
    const registry = await registryValidation;
    this.#registrySchemaVersion = registry.schemaVersion;
    this.#artifactSchemaVersion = artifacts.schemaVersion;
    this.#registry = cloneFrozen(registry.entries);
    this.#artifacts = cloneFrozen(artifacts.entries);
    this.#unvalidatedRegistry = undefined;
    this.#unvalidatedArtifacts = undefined;
    this.#validated = true;
  }
  registrySnapshot(): AdmissionRegistryV1 {
    if (!this.#validated) throw new Error('state snapshots are not validated');
    return cloneFrozen({
      schemaVersion: this.#registrySchemaVersion,
      entries: this.#registry,
    }) as AdmissionRegistryV1;
  }
  artifactSnapshot(): ArtifactStoreIndexV1 {
    if (!this.#validated) throw new Error('state snapshots are not validated');
    return cloneFrozen({
      schemaVersion: this.#artifactSchemaVersion,
      entries: this.#artifacts,
    }) as ArtifactStoreIndexV1;
  }

  async transact<T>(
    key: string,
    operation: (context: TransactionContextV1) => Promise<T>,
  ): Promise<ReservationResult<T>> {
    if (!this.#validated) throw new Error('state snapshots are not validated');
    let release!: () => void;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => release = resolve);
    await predecessor;
    let artifactCommitted = false;
    let registryCommitted = false;
    try {
      const existing = this.#registry[key];
      if (!existing) {
        const registryEntries = Object.keys(this.#registry).length;
        const registryOverhead = canonicalBytes(key).byteLength + 1 + (registryEntries > 0 ? 1 : 0);
        if (
          registryEntries + 1 > ADMISSION_LIMITS.registryEntries ||
          canonicalBytes(this.registrySnapshot()).byteLength + registryOverhead +
                ADMISSION_LIMITS.admissionRecordCanonicalBytes >
            ADMISSION_LIMITS.registryCanonicalBytes
        ) return { status: 'rejected', code: 'registry_capacity' };
        const artifactEntries = Object.keys(this.#artifacts).length;
        const artifactBytes = Object.values(this.#artifacts).reduce(
          (sum, entry) => sum + entry.byteCount,
          0,
        );
        const maximumHash = `sha256:${'f'.repeat(64)}`;
        const maximumEntry = {
          artifactHash: maximumHash,
          byteCount: ADMISSION_LIMITS.emittedArtifactBytes,
        };
        const artifactOverhead = canonicalBytes(maximumHash).byteLength + 1 +
          canonicalBytes(maximumEntry).byteLength + (artifactEntries > 0 ? 1 : 0);
        if (
          artifactEntries + 1 > ADMISSION_LIMITS.artifactStoreEntries ||
          artifactBytes + ADMISSION_LIMITS.emittedArtifactBytes >
            ADMISSION_LIMITS.artifactStoreBytes ||
          canonicalBytes(this.artifactSnapshot()).byteLength + artifactOverhead >
            ADMISSION_LIMITS.artifactIndexCanonicalBytes
        ) return { status: 'rejected', code: 'artifact_capacity' };
      }
      const context: TransactionContextV1 = {
        existing,
        commitArtifact: (entry) => {
          if (artifactCommitted) throw new Error('artifact limb already committed');
          if (!/^sha256:[0-9a-f]{64}$/.test(entry.artifactHash)) throw new Error('artifact hash');
          if (
            !Number.isSafeInteger(entry.byteCount) || entry.byteCount < 0 ||
            entry.byteCount > ADMISSION_LIMITS.emittedArtifactBytes
          ) throw new Error('artifact bytes');
          const prior = this.#artifacts[entry.artifactHash];
          if (prior && prior.byteCount !== entry.byteCount) {
            throw new Error('artifact index conflict');
          }
          this.#artifacts = { ...this.#artifacts, [entry.artifactHash]: cloneFrozen(entry) };
          validateArtifactIndexSnapshot(this.artifactSnapshot());
          artifactCommitted = true;
        },
        appendRecord: async (record) => {
          if (registryCommitted) throw new Error('registry limb already committed');
          validateAdmissionRecord(record);
          if (record.admissionKey !== key || this.#registry[key]) {
            throw new Error('registry append conflict');
          }
          const next = { ...this.#registry, [key]: cloneFrozen(record) };
          await validateAdmissionRegistrySnapshot({
            schemaVersion: 'admission-registry/v1',
            entries: next,
          });
          this.#registry = cloneFrozen(next);
          registryCommitted = true;
        },
      };
      return { status: 'reserved', value: await operation(context) };
    } finally {
      release();
    }
  }
}

export const EMPTY_ADMISSION_REGISTRY: AdmissionRegistryV1 = Object.freeze({
  schemaVersion: 'admission-registry/v1',
  entries: Object.freeze({}),
});
export const EMPTY_ARTIFACT_INDEX: ArtifactStoreIndexV1 = Object.freeze({
  schemaVersion: 'artifact-store-index/v1',
  entries: Object.freeze({}),
});
