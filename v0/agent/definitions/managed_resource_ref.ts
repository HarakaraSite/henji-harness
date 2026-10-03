interface ManagedResourceRefV1 {
  readonly schemaVersion: 1;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly revision: {
    readonly algorithm: 'sha256';
    readonly digest: string;
  };
}

export type HenjiInstructionRevisionRef = ManagedResourceRefV1 & {
  readonly resourceKind: 'henji-instruction';
  readonly resourceId: string;
};

const SHA256 = /^[0-9a-f]{64}$/u;

const isWellFormedResourceId = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

export const isHenjiInstructionRevisionRef = (
  value: unknown,
): value is HenjiInstructionRevisionRef => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const revision = ref.revision;
  return ref.schemaVersion === 1 && ref.resourceKind === 'henji-instruction' &&
    isWellFormedResourceId(ref.resourceId) &&
    typeof revision === 'object' && revision !== null && !Array.isArray(revision) &&
    (revision as Record<string, unknown>).algorithm === 'sha256' &&
    typeof (revision as Record<string, unknown>).digest === 'string' &&
    SHA256.test((revision as Record<string, string>).digest);
};
