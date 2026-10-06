import { type BodyCursor, BodyDocument } from './body_document.ts';
import { projectConversationEntry } from './conversation_renderer.ts';
import { startupHeaderLines } from './startup_render.ts';
import {
  uiConversationCount,
  uiConversationEntryAt,
  type UiLogEntry,
  type UiState,
} from './state.ts';
import type { LayoutRow } from './layout.ts';

export interface ConversationCursor {
  readonly entryId: string;
  readonly part: 'separator' | 'label' | 'body';
  readonly body?: BodyCursor;
  readonly sourceUtf16Offset: number;
}

export interface ConversationView {
  readonly rows: readonly LayoutRow[];
  readonly cursors: readonly ConversationCursor[];
  readonly atStart: boolean;
  readonly atEnd: boolean;
}

interface RecordLayout {
  readonly entry: UiLogEntry;
  readonly renderedRows: Map<string, LayoutRow>;
  readonly body: BodyDocument;
  readonly label: BodyDocument;
  readonly separateLabel: boolean;
  readonly projectedPrefix: number;
  readonly projectedText: string;
  readonly projectedTone?: ReturnType<typeof projectConversationEntry>['labelTone'];
  readonly rowTone?: ReturnType<typeof projectConversationEntry>['rowTone'];
}

/** Selects source ranges before rendering them. No global display-row array or height is built. */
export class ConversationViewport {
  private state!: UiState;
  private ids: readonly string[] = [];
  private readonly index = new Map<string, number>();
  private readonly separators = new Set<string>();
  private readonly bodies = new Map<string, RecordLayout>();
  private localEntries: readonly UiLogEntry[] | undefined;
  private keyedSource: UiState['keyedConversation'];
  private structureDirty = true;
  private dirty = true;
  private cached: ConversationView | undefined;
  private cachedWidth = 0;
  private cachedHeight = 0;
  private cachedScroll: UiState['scroll'] | undefined;
  private headerText = '';
  private header: UiLogEntry | undefined;
  private startup: UiState['startup'];
  private headerStartup: UiState['startup'];
  private width = 0;
  private headerWidth = 0;
  private headerRows = 0;
  private terminalRows = 0;
  private painted = new Map<Map<string, LayoutRow>, Set<string>>();
  private readonly localById = new Map<string, UiLogEntry>();

  changed(ids: ReadonlySet<string>, structureChanged: boolean): void {
    if (structureChanged) this.structureDirty = true;
    if (
      structureChanged || this.cached === undefined ||
      this.cached.cursors.some((cursor) => ids.has(cursor.entryId))
    ) this.dirty = true;
  }

  reset(): void {
    this.ids = [];
    this.index.clear();
    this.bodies.clear();
    this.painted.clear();
    this.localEntries = undefined;
    this.keyedSource = undefined;
    this.localById.clear();
    this.startup = undefined;
    this.headerStartup = undefined;
    this.cached = undefined;
    this.structureDirty = true;
    this.dirty = true;
  }

  private prepare(state: UiState, width: number, terminalRows = state.terminalSize.rows): void {
    if (
      this.terminalRows !== terminalRows &&
      this.cached?.cursors.some((c) => c.entryId === '@startup')
    ) this.dirty = true;
    this.terminalRows = terminalRows;
    this.state = state;
    this.width = width;
    if (this.keyedSource !== state.keyedConversation) {
      this.keyedSource = state.keyedConversation;
      this.structureDirty = true;
      this.dirty = true;
    }
    if (state.keyedConversation === undefined && this.localEntries !== state.log.entries) {
      this.localEntries = state.log.entries;
      this.localById.clear();
      for (const entry of state.log.entries) this.localById.set(entry.id, entry);
      this.structureDirty = true;
      this.dirty = true;
    }
    if ((this.startup === undefined) !== (state.startup === undefined)) {
      this.structureDirty = true;
      this.dirty = true;
    }
    if (
      this.startup !== state.startup &&
      this.cached?.cursors.some((cursor) => cursor.entryId === '@startup')
    ) this.dirty = true;
    this.startup = state.startup;
    if (!this.structureDirty) return;
    const ids: string[] = state.startup === undefined ? [] : ['@startup'];
    this.separators.clear();
    let seenUser = false;
    const awaiting = new Set<number>();
    let previous: UiLogEntry | undefined;
    for (let i = 0; i < uiConversationCount(state); i++) {
      const entry = uiConversationEntryAt(state, i)!;
      const user = entry.kind === 'user' && entry.label === 'user>';
      const output = entry.turn !== undefined && awaiting.has(entry.turn) &&
        ['tool', 'assistant', 'thinking'].includes(entry.kind);
      if (
        (user && seenUser) || output ||
        (previous !== undefined && (entry.kind === 'thinking' || previous.kind === 'thinking'))
      ) {
        this.separators.add(entry.id);
      }
      if (user) {
        seenUser = true;
        if (entry.turn !== undefined) awaiting.add(entry.turn);
      }
      if (output) awaiting.delete(entry.turn!);
      ids.push(entry.id);
      previous = entry;
    }
    this.ids = ids;
    this.index.clear();
    ids.forEach((id, i) => this.index.set(id, i));
    for (const id of this.bodies.keys()) if (!this.index.has(id)) this.bodies.delete(id);
    this.structureDirty = false;
  }

  private entry(id: string): UiLogEntry {
    if (id === '@startup') {
      if (
        this.headerStartup !== this.state.startup || this.headerWidth !== this.width ||
        this.headerRows !== this.terminalRows
      ) {
        const text = startupHeaderLines(
          this.state.startup!.state,
          this.state.startup!.position,
          this.width,
          this.terminalRows,
        ).join('\n');
        if (this.header === undefined || text !== this.headerText) {
          this.headerText = text;
          this.header = { id, kind: 'system', label: '', text, revision: 0, live: false };
        }
        this.headerStartup = this.state.startup;
        this.headerWidth = this.width;
        this.headerRows = this.terminalRows;
      }
      return this.header!;
    }
    return this.state.keyedConversation?.get(id) ?? this.localById.get(id)!;
  }

  private record(id: string): RecordLayout {
    const entry = this.entry(id);
    const previous = this.bodies.get(id);
    if (previous !== undefined && previous.entry === entry) return previous;
    const separateLabel = entry.kind === 'assistant' || entry.kind === 'thinking';
    const mode = entry.kind === 'assistant' && entry.label !== 'assistant note>'
      ? 'markdown'
      : 'plain';
    const projection = separateLabel || id === '@startup' ? undefined : projectConversationEntry(
      entry,
      { recallAvailable: this.state.startup?.state.sessionMode.kind !== 'none' },
    );
    const text = projection?.text ?? entry.text;
    const priorMode = previous?.entry.kind === 'assistant' &&
        previous.entry.label !== 'assistant note>'
      ? 'markdown'
      : 'plain';
    const body = previous !== undefined && priorMode === mode
      ? previous.body
      : new BodyDocument(text, mode);
    if (previous !== undefined && body === previous.body && previous.projectedText !== text) {
      body.update(text);
    }
    const record: RecordLayout = {
      entry,
      renderedRows: previous !== undefined && previous.body === body
        ? previous.renderedRows
        : new Map(),
      body,
      separateLabel,
      label: previous?.label ?? new BodyDocument(entry.label, 'plain'),
      projectedPrefix: projection?.styledPrefixScalarLength ?? projection?.labelScalarLength ?? 0,
      projectedText: text,
      projectedTone: projection?.labelTone,
      rowTone: projection?.rowTone,
    };
    if (previous !== undefined && previous.entry.label !== entry.label) {
      record.label.update(entry.label);
    }
    this.bodies.set(id, record);
    return record;
  }

  private first(id: string, width: number): ConversationCursor {
    if (this.separators.has(id)) return { entryId: id, part: 'separator', sourceUtf16Offset: 0 };
    const record = this.record(id);
    if (record.separateLabel) return this.labelCursor(id, record.label.first(width), width);
    return this.bodyCursor(id, record.body.first(width), width);
  }

  private bodyCursor(id: string, body: BodyCursor, width: number): ConversationCursor {
    // Position lookup is separate from creating the final styled terminal row.
    const sourceUtf16Offset = this.record(id).body.sourceOffset(body, width);
    return { entryId: id, part: 'body', body, sourceUtf16Offset };
  }

  private labelCursor(id: string, body: BodyCursor, width: number): ConversationCursor {
    return {
      entryId: id,
      part: 'label',
      body,
      sourceUtf16Offset: this.record(id).label.sourceOffset(body, width),
    };
  }

  next(cursor: ConversationCursor, width: number): ConversationCursor | undefined {
    const record = this.record(cursor.entryId);
    if (cursor.part === 'separator' && record.separateLabel) {
      return this.labelCursor(cursor.entryId, record.label.first(width), width);
    }
    if (cursor.part === 'label') {
      const next = record.label.next(cursor.body!, width);
      if (next !== undefined) return this.labelCursor(cursor.entryId, next, width);
    }
    if (cursor.part !== 'body') {
      return this.bodyCursor(cursor.entryId, record.body.first(width), width);
    }
    const body = record.body.next(cursor.body!, width);
    if (body !== undefined) return this.bodyCursor(cursor.entryId, body, width);
    const id = this.ids[(this.index.get(cursor.entryId) ?? -1) + 1];
    return id === undefined ? undefined : this.first(id, width);
  }

  previous(cursor: ConversationCursor, width: number): ConversationCursor | undefined {
    const record = this.record(cursor.entryId);
    if (cursor.part === 'body') {
      const body = record.body.previous(cursor.body!, width);
      if (body !== undefined) return this.bodyCursor(cursor.entryId, body, width);
      if (record.separateLabel) {
        return this.labelCursor(cursor.entryId, record.label.last(width), width);
      }
    }
    if (cursor.part === 'label') {
      const previous = record.label.previous(cursor.body!, width);
      if (previous !== undefined) return this.labelCursor(cursor.entryId, previous, width);
    }
    if (cursor.part !== 'separator' && this.separators.has(cursor.entryId)) {
      return { entryId: cursor.entryId, part: 'separator', sourceUtf16Offset: 0 };
    }
    const id = this.ids[(this.index.get(cursor.entryId) ?? 0) - 1];
    return id === undefined
      ? undefined
      : this.bodyCursor(id, this.record(id).body.last(width), width);
  }

  private atStart(cursor: ConversationCursor): boolean {
    if (this.index.get(cursor.entryId) !== 0) return false;
    if (cursor.part === 'separator') return true;
    if (this.separators.has(cursor.entryId)) return false;
    const record = this.record(cursor.entryId);
    if (cursor.part === 'label') return record.label.isFirst(cursor.body!);
    return !record.separateLabel && record.body.isFirst(cursor.body!);
  }

  private atEnd(cursor: ConversationCursor, width: number): boolean {
    if (this.index.get(cursor.entryId) !== this.ids.length - 1 || cursor.part !== 'body') {
      return false;
    }
    return this.record(cursor.entryId).body.isLast(cursor.body!, width);
  }

  private resolve(scroll: UiState['scroll'], width: number): ConversationCursor | undefined {
    if (this.ids.length === 0) return undefined;
    if (scroll.kind === 'oldest') return this.first(this.ids[0], width);
    if (scroll.kind === 'followLatest') {
      const id = this.ids.at(-1)!;
      return this.bodyCursor(id, this.record(id).body.last(width), width);
    }
    if (!this.index.has(scroll.entryId)) return this.first(this.ids[0], width);
    if (scroll.part === 'label' && this.record(scroll.entryId).separateLabel) {
      return this.labelCursor(
        scroll.entryId,
        this.record(scroll.entryId).label.seek(scroll.sourceUtf16Offset, width),
        width,
      );
    }
    if (scroll.part === 'separator' && this.separators.has(scroll.entryId)) {
      return { entryId: scroll.entryId, part: 'separator', sourceUtf16Offset: 0 };
    }
    return this.bodyCursor(
      scroll.entryId,
      this.record(scroll.entryId).body.seek(scroll.sourceUtf16Offset, width),
      width,
    );
  }

  private position(
    state: UiState,
    width: number,
    height: number,
    terminalRows = state.terminalSize.rows,
  ) {
    this.prepare(state, width, terminalRows);
    const cursors: ConversationCursor[] = [];
    let cursor = height <= 0 ? undefined : this.resolve(state.scroll, width);
    while (cursor !== undefined && cursors.length < height) {
      cursors.push(cursor);
      if (cursors.length === height) break;
      cursor = state.scroll.kind === 'followLatest'
        ? this.previous(cursor, width)
        : this.next(cursor, width);
    }
    if (state.scroll.kind === 'followLatest') cursors.reverse();
    return {
      cursors,
      atStart: cursors.length === 0 || this.atStart(cursors[0]),
      atEnd: cursors.length === 0 || this.atEnd(cursors.at(-1)!, width),
    };
  }

  view(
    state: UiState,
    width: number,
    height: number,
    terminalRows = state.terminalSize.rows,
  ): ConversationView {
    this.prepare(state, width, terminalRows);
    if (
      !this.dirty && this.cached !== undefined && this.cachedWidth === width &&
      this.cachedHeight === height && this.cachedScroll === state.scroll
    ) return this.cached;
    const position = this.position(state, width, height, terminalRows);
    const cursors = position.cursors;
    const painted = new Map<Map<string, LayoutRow>, Set<string>>();
    const rows = cursors.map((cursor): LayoutRow => {
      if (cursor.part === 'separator') return { text: '', kind: 'separator' };
      const record = this.record(cursor.entryId);
      if (cursor.part === 'label') {
        const text = record.label.render(cursor.body!, width).text;
        return {
          text,
          kind: 'log',
          entryId: cursor.entryId,
          sourceUtf16Offset: cursor.sourceUtf16Offset,
          labelTone: record.entry.kind === 'thinking' ? 'thinking' : 'assistant',
          labelScalarLength: [...text].length,
        };
      }
      const rowKey = `${width}/${
        record.body.rowKey(cursor.body!, width)
      }/${record.separateLabel}/${record.projectedPrefix}/${record.projectedTone}/${record.rowTone}`;
      let keys = painted.get(record.renderedRows);
      if (keys === undefined) painted.set(record.renderedRows, keys = new Set());
      keys.add(rowKey);
      const cachedRow = record.renderedRows.get(rowKey);
      if (cachedRow !== undefined) return cachedRow;
      const row = record.body.render(cursor.body!, width);
      // Only inspect the short prefix while it overlaps the visible row.
      let prefixText = '';
      let prefixCount = 0;
      for (const character of record.projectedText) {
        if (prefixCount++ >= record.projectedPrefix) break;
        prefixText += character;
      }
      const projected = record.separateLabel || cursor.entryId === '@startup' ||
          row.sourceUtf16Offset >= prefixText.length
        ? 0
        : record.projectedPrefix - [...prefixText.slice(0, row.sourceUtf16Offset)].length;
      const result: LayoutRow = {
        text: row.text,
        kind: 'log',
        entryId: cursor.entryId,
        sourceUtf16Offset: row.sourceUtf16Offset,
        spans: row.spans,
        ...(projected === 0 ? {} : {
          labelScalarLength: Math.min(projected, [...row.text].length),
          labelTone: record.projectedTone,
        }),
        ...(record.rowTone === undefined ? {} : { rowTone: record.rowTone }),
      };
      record.renderedRows.set(rowKey, result);
      return result;
    });
    // Keep final rows for the current viewport; geometry checkpoints remain on documents.
    // Paging away does not retain every previously painted string at every width.
    for (const map of this.painted.keys()) if (!painted.has(map)) map.clear();
    for (const [map, keys] of painted) {
      for (const key of map.keys()) if (!keys.has(key)) map.delete(key);
    }
    this.painted = painted;
    const result: ConversationView = {
      rows,
      cursors,
      atStart: position.atStart,
      atEnd: position.atEnd,
    };
    this.cached = result;
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedScroll = state.scroll;
    this.dirty = false;
    return result;
  }

  page(
    state: UiState,
    width: number,
    height: number,
    direction: 'up' | 'down',
    displayed?: ConversationView,
  ): UiState['scroll'] {
    this.prepare(state, width);
    const current = displayed ?? this.position(state, width, height);
    let cursor = current.cursors[0];
    if (cursor === undefined) return state.scroll;
    if (direction === 'up' && current.atStart) {
      return state.scroll.kind === 'followLatest' ? state.scroll : { kind: 'oldest' };
    }
    if (direction === 'down' && current.atEnd) return { kind: 'followLatest' };
    // Resolve the displayed source point against current text before applying the operation.
    cursor = this.resolve({
      kind: 'anchored',
      entryId: cursor.entryId,
      sourceUtf16Offset: cursor.sourceUtf16Offset,
      part: cursor.part,
    }, width)!;
    for (let i = 0; i < Math.max(1, height); i++) {
      const next = direction === 'up' ? this.previous(cursor, width) : this.next(cursor, width);
      if (next === undefined) return { kind: direction === 'up' ? 'oldest' : 'followLatest' };
      cursor = next;
    }
    if (direction === 'down') {
      let end = cursor;
      for (let i = 1; i < Math.max(1, height); i++) {
        const next = this.next(end, width);
        if (next === undefined) return { kind: 'followLatest' };
        end = next;
      }
      if (this.next(end, width) === undefined) return { kind: 'followLatest' };
    }
    return {
      kind: 'anchored',
      entryId: cursor.entryId,
      sourceUtf16Offset: cursor.sourceUtf16Offset,
      part: cursor.part,
    };
  }
}
