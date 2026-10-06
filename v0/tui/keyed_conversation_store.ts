import type { ConversationEntity } from '../conversation/model.ts';
import {
  pendingToolActivityText,
  settledToolActivityText,
  toolActivityPreview,
} from '../agent/tools/tool_activity.ts';
import { freezeUiLogEntry, type UiLogEntry } from './state.ts';

const displayId = (id: string): string => `conversation:${id}`;

const sameDisplayedEntry = (left: UiLogEntry, right: UiLogEntry): boolean =>
  left.kind === right.kind && left.label === right.label &&
  left.text === right.text && left.live === right.live &&
  left.turn === right.turn && left.callId === right.callId &&
  left.executionId === right.executionId && left.toolName === right.toolName;

const toolArgumentsPreview = (name: string, args: unknown): string =>
  toolActivityPreview(name, args);

/** Map one current-value Data entity to its single display row. */
export const mapConversationEntity = (
  entity: ConversationEntity,
  previous?: UiLogEntry,
): UiLogEntry | undefined => {
  let kind: UiLogEntry['kind'];
  let label: string;
  let text: string;
  let live = false;
  let callId: string | undefined;
  switch (entity.kind) {
    case 'message':
      if (entity.role === 'user') {
        kind = 'user';
        label = entity.position.requestOrder < 0 ? 'user>' : 'steer>';
        text = entity.text;
      } else if (entity.role === 'assistant') {
        if (entity.text.length === 0 && (entity.toolIds?.length ?? 0) > 0) {
          return undefined;
        }
        kind = 'assistant';
        label = (entity.toolIds?.length ?? 0) > 0 ? 'assistant note>' : 'assistant>';
        text = entity.text;
        live = !entity.complete;
      } else return undefined;
      break;
    case 'thinking':
      kind = 'thinking';
      label = entity.thinkingKind === 'summary'
        ? entity.complete ? 'thinking summary>' : 'thinking summary~'
        : entity.complete
        ? 'thinking>'
        : 'thinking~';
      text = entity.text;
      live = !entity.complete;
      break;
    case 'tool': {
      kind = 'tool';
      label = 'tool>';
      const preview = toolArgumentsPreview(entity.name, entity.arguments);
      text = entity.result === undefined
        ? pendingToolActivityText(entity.name, preview)
        : settledToolActivityText(entity.name, entity.result.outcome, preview);
      live = entity.result === undefined;
      callId = entity.callId;
      break;
    }
    case 'execution':
    case 'request':
    case 'steering':
      return undefined;
  }
  const id = displayId(entity.id);
  const candidate: UiLogEntry = {
    id,
    kind,
    label,
    text,
    revision: previous?.revision ?? entity.version,
    live,
    turn: 'turn' in entity ? entity.turn : undefined,
    ...(callId === undefined ? {} : { callId }),
    ...(entity.kind === 'tool' ? { toolName: entity.name } : {}),
    executionId: entity.executionId,
  };
  if (previous !== undefined && sameDisplayedEntry(previous, candidate)) return previous;
  if (previous !== undefined) {
    return freezeUiLogEntry({ ...candidate, revision: previous.revision + 1 }, previous);
  }
  return freezeUiLogEntry(candidate);
};

export interface KeyedNoticePlacement {
  readonly entry: UiLogEntry;
  readonly afterExecutionId?: string;
  readonly anchor?: string;
}

export interface KeyedNoticeUpdate {
  readonly changed: boolean;
  readonly structureChanged: boolean;
  readonly previousIds?: readonly string[];
}

/**
 * UI-owned row identity and order. Body updates replace only one Map value; order work happens
 * only for structural changes or local notice changes.
 */
export class KeyedConversationStore {
  private readonly rows = new Map<string, UiLogEntry>();
  private semanticOrder: string[] = [];
  private displayOrder: string[] = [];
  private readonly notices = new Map<string, KeyedNoticePlacement>();
  private readonly indexById = new Map<string, number>();
  private readonly semanticIndexById = new Map<string, number>();
  private readonly lastByExecution = new Map<string, string>();
  private readonly noticeOrdinalById = new Map<string, number>();
  private nextNoticeOrdinal = 0;
  private omittedCount = 0;

  get size(): number {
    return this.displayOrder.length;
  }

  get omitted(): number {
    return this.omittedCount;
  }

  setOmittedCount(count: number): void {
    this.omittedCount = count;
  }

  get(id: string): UiLogEntry | undefined {
    return this.rows.get(id);
  }

  set(id: string, entry: UiLogEntry): void {
    this.rows.set(id, entry);
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  ids(): readonly string[] {
    return this.displayOrder;
  }

  semanticIds(): readonly string[] {
    return this.semanticOrder;
  }

  entryAt(index: number): UiLogEntry | undefined {
    const id = this.displayOrder[index];
    return id === undefined ? undefined : this.rows.get(id);
  }

  indexOf(id: string): number {
    return this.indexById.get(id) ?? -1;
  }

  window(start: number, end: number): readonly UiLogEntry[] {
    const entries: UiLogEntry[] = [];
    const from = Math.max(0, start);
    const to = Math.min(this.displayOrder.length, Math.max(from, end));
    for (let index = from; index < to; index += 1) {
      const id = this.displayOrder[index];
      const entry = id === undefined ? undefined : this.rows.get(id);
      if (entry !== undefined) entries.push(entry);
    }
    return entries;
  }

  lastForExecution(executionId: string): string | undefined {
    return this.lastByExecution.get(executionId);
  }

  replaceSemanticOrder(order: readonly string[]): void {
    const previous = this.semanticOrder;
    const next = [...order].filter((id) => this.rows.has(id));
    const nextIds = new Set(next);
    for (const id of previous) if (!nextIds.has(id)) this.rows.delete(id);
    this.semanticOrder = next;
    this.rebuildSemanticIndexes();
    for (const [id, notice] of this.notices) {
      if (notice.afterExecutionId !== undefined) continue;
      if (notice.anchor === undefined || nextIds.has(notice.anchor)) continue;
      const boundary = previous.indexOf(notice.anchor);
      let anchor: string | undefined;
      for (let index = Math.min(boundary - 1, previous.length - 1); index >= 0; index -= 1) {
        const candidate = previous[index];
        if (candidate !== undefined && nextIds.has(candidate)) {
          anchor = candidate;
          break;
        }
      }
      this.notices.set(id, { ...notice, ...(anchor === undefined ? {} : { anchor }) });
    }
    this.rebuildDisplayOrder();
  }

  setNotice(placement: KeyedNoticePlacement): KeyedNoticeUpdate {
    return this.upsertNotice(placement);
  }

  /** Update one notice row in place; only placement changes splice the order index. */
  upsertNotice(
    placement: KeyedNoticePlacement,
    capturePreviousIds = true,
  ): KeyedNoticeUpdate {
    const { id } = placement.entry;
    const previous = this.notices.get(id);
    const samePlacement = previous !== undefined &&
      previous.anchor === placement.anchor &&
      previous.afterExecutionId === placement.afterExecutionId;
    if (samePlacement) {
      if (previous.entry === placement.entry) {
        return { changed: false, structureChanged: false };
      }
      this.notices.set(id, placement);
      this.rows.set(id, placement.entry);
      return { changed: true, structureChanged: false };
    }

    const previousIds = capturePreviousIds ? [...this.displayOrder] : undefined;
    if (previous !== undefined) {
      const existingIndex = this.indexById.get(id);
      if (existingIndex !== undefined) {
        this.displayOrder.splice(existingIndex, 1);
        this.indexById.delete(id);
        this.reindexFrom(existingIndex);
      }
    } else {
      this.noticeOrdinalById.set(id, this.nextNoticeOrdinal++);
    }
    this.notices.set(id, placement);
    this.rows.set(id, placement.entry);
    const insertionIndex = this.noticeInsertionIndex(id);
    this.displayOrder.splice(insertionIndex, 0, id);
    this.reindexFrom(insertionIndex);
    return {
      changed: true,
      structureChanged: true,
      ...(previousIds === undefined ? {} : { previousIds }),
    };
  }

  /** Full notice replacement is reserved for a newly reset session projection. */
  replaceNotices(placements: readonly KeyedNoticePlacement[]): void {
    const next = new Map(placements.map((placement) => [placement.entry.id, placement] as const));
    for (const id of this.notices.keys()) if (!next.has(id)) this.rows.delete(id);
    this.notices.clear();
    this.noticeOrdinalById.clear();
    this.nextNoticeOrdinal = 0;
    for (const [id, placement] of next) {
      this.notices.set(id, placement);
      this.rows.set(id, placement.entry);
      this.noticeOrdinalById.set(id, this.nextNoticeOrdinal++);
    }
    this.rebuildDisplayOrder();
  }

  removeNotice(id: string, capturePreviousIds = true): KeyedNoticeUpdate {
    if (!this.notices.has(id)) return { changed: false, structureChanged: false };
    const previousIds = capturePreviousIds ? [...this.displayOrder] : undefined;
    this.notices.delete(id);
    this.noticeOrdinalById.delete(id);
    this.rows.delete(id);
    const index = this.indexById.get(id);
    if (index !== undefined) {
      this.displayOrder.splice(index, 1);
      this.indexById.delete(id);
      this.reindexFrom(index);
    }
    return {
      changed: true,
      structureChanged: true,
      ...(previousIds === undefined ? {} : { previousIds }),
    };
  }

  clear(): void {
    this.rows.clear();
    this.semanticOrder = [];
    this.displayOrder = [];
    this.notices.clear();
    this.indexById.clear();
    this.semanticIndexById.clear();
    this.lastByExecution.clear();
    this.noticeOrdinalById.clear();
    this.nextNoticeOrdinal = 0;
    this.omittedCount = 0;
  }

  private rebuildSemanticIndexes(): void {
    this.semanticIndexById.clear();
    this.lastByExecution.clear();
    for (let index = 0; index < this.semanticOrder.length; index += 1) {
      const id = this.semanticOrder[index];
      if (id !== undefined) this.semanticIndexById.set(id, index);
      const entry = this.rows.get(id);
      if (entry?.executionId !== undefined) this.lastByExecution.set(entry.executionId, id);
    }
  }

  private resolvedAnchor(placement: KeyedNoticePlacement): string | undefined {
    const anchor = placement.afterExecutionId === undefined
      ? placement.anchor
      : this.lastByExecution.get(placement.afterExecutionId) ?? placement.anchor;
    return anchor !== undefined && this.semanticIndexById.has(anchor) ? anchor : undefined;
  }

  private noticeInsertionIndex(id: string): number {
    const placement = this.notices.get(id);
    if (placement === undefined) return this.displayOrder.length;
    const anchor = this.resolvedAnchor(placement);
    const ordinal = this.noticeOrdinalById.get(id) ?? Number.MAX_SAFE_INTEGER;
    let index: number;
    let end: number;
    if (anchor === undefined) {
      const firstSemantic = this.semanticOrder[0];
      index = firstSemantic === undefined
        ? this.displayOrder.length
        : this.indexById.get(firstSemantic) ?? this.displayOrder.length;
      end = index;
      index = 0;
    } else {
      const anchorIndex = this.indexById.get(anchor);
      if (anchorIndex === undefined) return this.displayOrder.length;
      index = anchorIndex + 1;
      end = this.displayOrder.length;
    }
    while (index < end) {
      const currentId = this.displayOrder[index];
      if (currentId === undefined) break;
      const currentPlacement = this.notices.get(currentId);
      if (currentPlacement === undefined || this.resolvedAnchor(currentPlacement) !== anchor) break;
      const currentOrdinal = this.noticeOrdinalById.get(currentId) ?? Number.MAX_SAFE_INTEGER;
      if (currentOrdinal > ordinal) break;
      index += 1;
    }
    return index;
  }

  private reindexFrom(start: number): void {
    for (let index = Math.max(0, start); index < this.displayOrder.length; index += 1) {
      const id = this.displayOrder[index];
      if (id !== undefined) this.indexById.set(id, index);
    }
  }

  private rebuildDisplayOrder(): void {
    const after = new Map<string, string[]>();
    const before: string[] = [];
    const semantic = new Set(this.semanticOrder);
    for (const [id, notice] of this.notices) {
      const anchor = notice.afterExecutionId === undefined
        ? notice.anchor
        : this.lastByExecution.get(notice.afterExecutionId) ?? notice.anchor;
      if (anchor === undefined || !semantic.has(anchor)) before.push(id);
      else {
        const list = after.get(anchor) ?? [];
        list.push(id);
        after.set(anchor, list);
      }
    }
    const result = [...before];
    for (const id of this.semanticOrder) {
      result.push(id, ...(after.get(id) ?? []));
    }
    this.displayOrder = result;
    this.indexById.clear();
    result.forEach((id, index) => this.indexById.set(id, index));
  }
}
