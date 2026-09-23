import type { JsonValue } from '../core/contracts.ts';

export const HUMAN_HISTORY_DOCUMENT_SCHEMA_VERSION = 1 as const;

export interface HumanHistoryExportRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: string;
  readonly identity: string;
  readonly value: JsonValue;
}
