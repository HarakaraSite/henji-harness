export interface IntakeLimitProfileV1 {
  readonly schemaVersion: 'intake-limits/v1';
  readonly maxRawBytes: number;
  readonly maxDepth: number;
  readonly maxObjectProperties: number;
  readonly maxArrayItems: number;
  readonly maxDecodedStringBytesEach: number;
  readonly maxDecodedStringBytesTotal: number;
  readonly maxTicketCanonicalBytes: number;
  readonly maxTicketEvidenceScopeEntries: number;
  readonly maxTicketEvidenceScopeBytesTotal: number;
  readonly maxBaseCanonicalBytes: number;
  readonly maxBaseDepth: number;
  readonly maxBaseEntries: number;
  readonly maxLedgerEntries: number;
  readonly maxOutcomeCanonicalBytes: number;
  readonly maxLedgerOutcomeBytes: number;
  readonly maxLedgerCanonicalBytes: number;
  readonly maxTrustedIdBytesEach: number;
  readonly maxTrustedMetadataBytesEach: number;
  readonly maxOriginEvidenceCanonicalBytes: number;
}

export interface RevisionBudgetV1 {
  readonly schemaVersion: 'revision-budget/v1';
  readonly maxReplacementCanonicalBytes: number;
  readonly maxResolvedCanonicalBytes: number;
  readonly maxEvidenceRefs: number;
  readonly maxEvidenceRefBytesEach: number;
  readonly maxEvidenceRefBytesTotal: number;
  readonly maxReasonBytes: number;
  readonly maxExpectedEffectBytes: number;
  readonly maxKnownRisks: number;
  readonly maxKnownRiskBytesEach: number;
  readonly maxKnownRiskBytesTotal: number;
  readonly maxPluginOwnedTests: number;
  readonly maxConfigDepth: number;
  readonly maxConfigEntries: number;
}

export const INTAKE_LIMITS: IntakeLimitProfileV1 = Object.freeze({
  schemaVersion: 'intake-limits/v1',
  maxRawBytes: 65_536,
  maxDepth: 16,
  maxObjectProperties: 256,
  maxArrayItems: 128,
  maxDecodedStringBytesEach: 32_768,
  maxDecodedStringBytesTotal: 65_536,
  maxTicketCanonicalBytes: 16_384,
  maxTicketEvidenceScopeEntries: 32,
  maxTicketEvidenceScopeBytesTotal: 4_096,
  maxBaseCanonicalBytes: 131_072,
  maxBaseDepth: 16,
  maxBaseEntries: 512,
  maxLedgerEntries: 16,
  maxOutcomeCanonicalBytes: 196_608,
  maxLedgerOutcomeBytes: 3_145_728,
  maxLedgerCanonicalBytes: 3_145_802,
  maxTrustedIdBytesEach: 256,
  maxTrustedMetadataBytesEach: 1_024,
  maxOriginEvidenceCanonicalBytes: 4_096,
});

export const MAX_REVISION_BUDGET: RevisionBudgetV1 = Object.freeze({
  schemaVersion: 'revision-budget/v1',
  maxReplacementCanonicalBytes: 32_768,
  maxResolvedCanonicalBytes: 131_072,
  maxEvidenceRefs: 16,
  maxEvidenceRefBytesEach: 256,
  maxEvidenceRefBytesTotal: 2_048,
  maxReasonBytes: 2_048,
  maxExpectedEffectBytes: 2_048,
  maxKnownRisks: 16,
  maxKnownRiskBytesEach: 512,
  maxKnownRiskBytesTotal: 4_096,
  maxPluginOwnedTests: 64,
  maxConfigDepth: 8,
  maxConfigEntries: 128,
});

export const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

export const measureStructure = (value: unknown): { depth: number; entries: number } => {
  const visit = (item: unknown, depth: number): { depth: number; entries: number } => {
    if (typeof item !== 'object' || item === null) return { depth: 0, entries: 0 };
    const values = Array.isArray(item) ? item : Object.values(item);
    let maximum = depth;
    let entries = values.length;
    for (const child of values) {
      const measured = visit(child, depth + 1);
      maximum = Math.max(maximum, measured.depth);
      entries += measured.entries;
    }
    return { depth: maximum, entries };
  };
  return visit(value, 1);
};

export const measureStructureBounded = (
  value: unknown,
  maxDepth: number,
  maxEntries: number,
): { depth: number; entries: number } => {
  let entries = 0;
  let maximum = 0;
  const visit = (item: unknown, depth: number): void => {
    if (typeof item !== 'object' || item === null) return;
    if (depth > maxDepth) throw new Error('structure depth exceeds limit');
    maximum = Math.max(maximum, depth);
    let keys: PropertyKey[];
    if (Array.isArray(item)) {
      if (!Number.isSafeInteger(item.length) || item.length > maxEntries - entries) {
        throw new Error('structure entries exceed limit');
      }
      const own = Reflect.ownKeys(item);
      const allowed = new Set<PropertyKey>(['length']);
      for (let index = 0; index < item.length; index++) allowed.add(String(index));
      if (own.some((key) => !allowed.has(key))) throw new Error('non-JSON array property');
      keys = Array.from({ length: item.length }, (_, index) => String(index));
    } else keys = Reflect.ownKeys(item);
    entries += keys.length;
    if (entries > maxEntries) throw new Error('structure entries exceed limit');
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('non-data structure');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('non-data structure');
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 1);
  return { depth: maximum, entries };
};
