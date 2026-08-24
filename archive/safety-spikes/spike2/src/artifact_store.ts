import { canonicalBytes, sha256 } from '../../spike0/src/canonical_content.ts';
import { ADMISSION_LIMITS } from './admission_profile.ts';

export interface ArtifactMetadataV1 {
  readonly schemaVersion: 'artifact-preimage/v1';
  readonly emittedMediaType: 'application/javascript+module';
  readonly compilerOptionsDigest: string;
  readonly builderDependencyDigest: string;
}

export interface ArtifactStoreEntryV1 {
  readonly artifactHash: string;
  readonly byteCount: number;
}

export interface ArtifactStoreIndexV1 {
  readonly schemaVersion: 'artifact-store-index/v1';
  readonly entries: Record<string, ArtifactStoreEntryV1>;
}

const u64be = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('u64 input');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
};

export const artifactHash = async (
  metadata: ArtifactMetadataV1,
  javascriptBytes: Uint8Array,
): Promise<string> => {
  const domain = new TextEncoder().encode('henji/spike2/artifact/v1\0');
  const metadataBytes = canonicalBytes(metadata);
  const pieces = [
    domain,
    u64be(metadataBytes.byteLength),
    metadataBytes,
    u64be(javascriptBytes.byteLength),
    javascriptBytes,
  ];
  const length = pieces.reduce((total, piece) => total + piece.byteLength, 0);
  const preimage = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    preimage.set(piece, offset);
    offset += piece.byteLength;
  }
  return await sha256(preimage);
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const validateStoreDirectory = async (directory: string): Promise<void> => {
  const info = await Deno.lstat(directory);
  if (!info.isDirectory || info.isSymlink) throw new Error('artifact store directory');
};

export interface ArtifactPublishResultV1 {
  readonly status: 'published' | 'existing';
  readonly artifactHash: string;
  readonly byteCount: number;
  readonly path: string;
}

const publishAt = async (
  directory: string,
  javascriptBytes: Uint8Array,
  metadata: ArtifactMetadataV1,
  addressOverride?: string,
  commit?: (entry: ArtifactStoreEntryV1) => void,
): Promise<ArtifactPublishResultV1> => {
  if (javascriptBytes.byteLength > ADMISSION_LIMITS.emittedArtifactBytes) {
    throw new Error('artifact_oversize');
  }
  await validateStoreDirectory(directory);
  const measuredHash = await artifactHash(metadata, javascriptBytes);
  const address = addressOverride ?? measuredHash;
  if (!/^sha256:[0-9a-f]{64}$/.test(address)) throw new Error('artifact address');
  const destination = `${directory}/${address.replace(':', '-')}`;
  const staging = `${directory}/.staging-${crypto.randomUUID()}`;
  let stagingExists = false;
  try {
    const file = await Deno.open(staging, {
      createNew: true,
      write: true,
      read: true,
      mode: 0o600,
    });
    stagingExists = true;
    try {
      let offset = 0;
      while (offset < javascriptBytes.byteLength) {
        offset += await file.write(javascriptBytes.subarray(offset));
      }
      await file.sync();
    } finally {
      file.close();
    }
    const staged = await Deno.readFile(staging);
    if (!equalBytes(staged, javascriptBytes)) throw new Error('artifact staging read-back');
    let status: 'published' | 'existing' = 'published';
    try {
      await Deno.link(staging, destination);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      status = 'existing';
      const info = await Deno.lstat(destination);
      if (!info.isFile || info.isSymlink) throw new Error('artifact existing type');
      const existing = await Deno.readFile(destination);
      if (!equalBytes(existing, javascriptBytes)) throw new Error('artifact_collision');
    }
    const published = await Deno.readFile(destination);
    if (!equalBytes(published, javascriptBytes)) throw new Error('artifact publish read-back');
    commit?.({ artifactHash: measuredHash, byteCount: javascriptBytes.byteLength });
    await Deno.remove(staging);
    stagingExists = false;
    return {
      status,
      artifactHash: measuredHash,
      byteCount: javascriptBytes.byteLength,
      path: destination,
    };
  } finally {
    if (stagingExists) await Deno.remove(staging);
  }
};

export const publishArtifact = async (
  directory: string,
  javascriptBytes: Uint8Array,
  metadata: ArtifactMetadataV1,
  commit?: (entry: ArtifactStoreEntryV1) => void,
): Promise<ArtifactPublishResultV1> =>
  await publishAt(directory, javascriptBytes, metadata, undefined, commit);

export const publishArtifactAtAddressForTest = async (
  directory: string,
  javascriptBytes: Uint8Array,
  metadata: ArtifactMetadataV1,
  address: string,
): Promise<ArtifactPublishResultV1> =>
  await publishAt(directory, javascriptBytes, metadata, address);
