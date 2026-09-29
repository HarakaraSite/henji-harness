import type { AssistantContentRenderer } from './conversation_renderer.ts';
import type { UiLogEntry } from './state.ts';
import type { LayoutRow } from './layout.ts';

export interface EntryLayout {
  readonly rows: readonly LayoutRow[];
  readonly sourceBytes: number;
}

interface CachedEntry {
  readonly entry: UiLogEntry;
  readonly columns: number;
  readonly renderer: AssistantContentRenderer;
  readonly recallAvailable: boolean;
  readonly layout: EntryLayout;
}

/** Renderer-local cache, retaining wrap results only for entries in the current history window. */
export class EntryLayoutCache {
  private readonly entries = new Map<string, CachedEntry>();

  retain(entries: readonly UiLogEntry[]): void {
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  get(
    entry: UiLogEntry,
    columns: number,
    renderer: AssistantContentRenderer,
    recallAvailable: boolean,
    build: () => EntryLayout,
  ): EntryLayout {
    const cached = this.entries.get(entry.id);
    if (
      cached !== undefined && cached.columns === columns && cached.renderer === renderer &&
      cached.recallAvailable === recallAvailable && cached.entry.revision === entry.revision &&
      cached.entry.text === entry.text && cached.entry.kind === entry.kind &&
      cached.entry.label === entry.label && cached.entry.live === entry.live &&
      cached.entry.executionId === entry.executionId
    ) return cached.layout;
    const layout = build();
    this.entries.set(entry.id, { entry, columns, renderer, recallAvailable, layout });
    return layout;
  }
}
