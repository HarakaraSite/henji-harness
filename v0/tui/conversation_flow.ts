import { type BodyCursor, BodyDocument } from './body_document.ts';
import { projectConversationEntry } from './conversation_renderer.ts';
import type { LayoutRow } from './layout.ts';
import { startupHeaderLines } from './startup_render.ts';
import {
  uiConversationCount,
  uiConversationEntryAt,
  type UiLogEntry,
  type UiState,
} from './state.ts';

const comparePosition = (
  left: NonNullable<UiLogEntry['position']>,
  right: NonNullable<UiLogEntry['position']>,
): number => {
  for (
    const key of [
      'executionOrder',
      'requestOrder',
      'phase',
      'eventOrdinal',
      'itemOrdinal',
    ] as const
  ) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
};

interface PrintedEntry {
  position?: UiLogEntry['position'];
  text: string;
  label: string;
  offset: number;
  base: number;
  cursor?: BodyCursor;
  width: number;
  labelPrinted: boolean;
  complete: boolean;
}

const entryRows = (
  entry: UiLogEntry,
  state: UiState,
  width: number,
  separated = false,
) => {
  const separate = entry.kind === 'assistant' || entry.kind === 'thinking';
  const projection = separate ? undefined : projectConversationEntry(entry, {
    recallAvailable: state.startup?.state.sessionMode.kind !== 'none',
  });
  const text = projection?.text ?? entry.text;
  const body = new BodyDocument(
    text,
    entry.kind === 'assistant' && entry.label !== 'assistant note>' ? 'markdown' : 'plain',
  );
  const rows: { row: LayoutRow; cursor?: BodyCursor }[] = separated
    ? [{ row: { text: '', kind: 'separator' } }]
    : [];
  if (separate) {
    const label = new BodyDocument(entry.label, 'plain');
    for (
      let cursor: BodyCursor | undefined = label.first(width);
      cursor;
      cursor = label.next(cursor, width)
    ) {
      const value = label.render(cursor, width);
      rows.push({
        row: {
          text: value.text,
          kind: 'log',
          entryId: entry.id,
          labelScalarLength: [...value.text].length,
          labelTone: entry.kind === 'thinking' ? 'thinking' : 'assistant',
          ...(entry.kind === 'thinking' ? { rowTone: 'thinking' as const } : {}),
        },
      });
    }
  }
  const prefix = [...text].slice(
    0,
    projection?.styledPrefixScalarLength ?? projection?.labelScalarLength ?? 0,
  ).join('');
  for (
    let cursor: BodyCursor | undefined = body.first(width);
    cursor;
    cursor = body.next(cursor, width)
  ) {
    const value = body.render(cursor, width);
    const remaining = Math.max(
      0,
      [...prefix.slice(value.sourceUtf16Offset)].length,
    );
    rows.push({
      cursor,
      row: {
        text: value.text,
        kind: 'log',
        entryId: entry.id,
        sourceUtf16Offset: value.sourceUtf16Offset,
        spans: value.spans,
        ...(remaining === 0 ? {} : {
          labelScalarLength: Math.min(remaining, [...value.text].length),
          labelTone: projection?.labelTone,
        }),
        ...(entry.kind === 'thinking'
          ? { rowTone: 'thinking' as const }
          : projection?.rowTone === undefined
          ? {}
          : { rowTone: projection.rowTone }),
      },
    });
  }
  return { rows, text, body };
};

export const conversationRows = (
  state: UiState,
  width: number,
): LayoutRow[] => {
  const rows: LayoutRow[] = state.startup === undefined ? [] : startupHeaderLines(
    state.startup.state,
    state.startup.position,
    width,
    state.terminalSize.rows,
  ).map((text) => ({ text, kind: 'log' }));
  let seenUser = false;
  let previous: UiLogEntry | undefined;
  const awaiting = new Set<number>();
  for (let i = 0; i < uiConversationCount(state); i++) {
    const entry = uiConversationEntryAt(state, i)!;
    const user = entry.kind === 'user' && entry.label === 'user>';
    const output = entry.turn !== undefined && awaiting.has(entry.turn) &&
      ['tool', 'assistant', 'thinking'].includes(entry.kind);
    if (
      (user && seenUser) || output ||
      (previous !== undefined &&
        (entry.kind === 'thinking' || previous.kind === 'thinking'))
    ) {
      rows.push({ text: '', kind: 'separator' });
    }
    if (user) {
      seenUser = true;
      if (entry.turn !== undefined) awaiting.add(entry.turn);
    }
    if (output) awaiting.delete(entry.turn!);
    rows.push(...entryRows(entry, state, width).rows.map(({ row }) => row));
    previous = entry;
  }
  return rows;
};

/** Terminal output receipts belong to a display scope, never to the saved conversation. */
export class ConversationFlow {
  private printed = new Map<string, PrintedEntry>();
  private headerPrinted = false;
  private frontier: UiLogEntry['position'];
  private liveEntry: UiLogEntry | undefined;
  private readonly rendered = new Map<
    string,
    {
      entry: UiLogEntry;
      width: number;
      base: number;
      value: ReturnType<typeof entryRows>;
    }
  >();

  reset(): void {
    this.printed.clear();
    this.frontier = undefined;
    this.headerPrinted = false;
    this.rendered.clear();
    this.liveEntry = undefined;
  }

  /** A terminal resize can move the displayed tail into history without another write. */
  sealVisibleTail(): void {
    const entry = this.liveEntry;
    if (entry === undefined) return;
    const receipt = this.printed.get(entry.id)!;
    receipt.complete = true;
    receipt.offset = entry.text.length;
    receipt.cursor = undefined;
    receipt.labelPrinted = true;
    this.rendered.delete(entry.id);
    this.liveEntry = undefined;
  }

  preview(
    state: UiState,
    width: number,
    capacity: number,
  ): readonly LayoutRow[] {
    return capacity === 0 ? [] : conversationRows(state, width).slice(-capacity);
  }

  drain(
    state: UiState,
    width: number,
    capacity: number,
  ): { committed: LayoutRow[]; live: LayoutRow[] } {
    const present = new Set<string>();
    for (let i = 0; i < uiConversationCount(state); i++) {
      present.add(uiConversationEntryAt(state, i)!.id);
    }
    for (const [id, receipt] of this.printed) {
      if (present.has(id) || id === this.liveEntry?.id) continue;
      if (
        receipt.position !== undefined &&
        (this.frontier === undefined ||
          comparePosition(receipt.position, this.frontier) > 0)
      ) {
        this.frontier = receipt.position;
      }
      this.printed.delete(id);
      this.rendered.delete(id);
    }
    const committed: LayoutRow[] = [];
    // The header records the opening state. Metadata updates stay in the Session;
    // opening it in a new display scope prints its latest state once.
    if (state.startup !== undefined && !this.headerPrinted) {
      committed.push(
        ...startupHeaderLines(
          state.startup.state,
          state.startup.position,
          width,
          state.terminalSize.rows,
        )
          .map((text): LayoutRow => ({ text, kind: 'log' })),
      );
      this.headerPrinted = true;
    }
    const pending: {
      entry: UiLogEntry;
      rows: ReturnType<typeof entryRows>;
      receipt: PrintedEntry;
    }[] = [];
    const running = state.footer === undefined
      ? state.lifecycle === 'busy' || state.lifecycle === 'cancelling'
      : state.footer.activity === 'working' ||
        state.footer.activity === 'cancelling';
    let seenUser = false;
    let previous: UiLogEntry | undefined;
    const awaiting = new Set<number>();
    for (let i = 0; i < uiConversationCount(state); i++) {
      const entry = uiConversationEntryAt(state, i)!;
      const user = entry.kind === 'user' && entry.label === 'user>';
      const output = entry.turn !== undefined && awaiting.has(entry.turn) &&
        ['tool', 'assistant', 'thinking'].includes(entry.kind);
      const separated = (user && seenUser) || output ||
        (previous !== undefined &&
          (entry.kind === 'thinking' || previous.kind === 'thinking'));
      if (user) {
        seenUser = true;
        if (entry.turn !== undefined) awaiting.add(entry.turn);
      }
      if (output) awaiting.delete(entry.turn!);
      previous = entry;
      let receipt = this.printed.get(entry.id);
      if (
        receipt === undefined && entry.position !== undefined &&
        this.frontier !== undefined &&
        comparePosition(entry.position, this.frontier) <= 0
      ) continue;
      // Keep the first visible tool state. Reopening the Session prints its saved result.
      if (entry.kind === 'tool' && receipt !== undefined) continue;
      const body = entry.kind === 'assistant' || entry.kind === 'thinking';
      // Settled records do not need another projection on editor/footer redraws.
      if (
        receipt?.complete && receipt.text === entry.text &&
        (body || receipt.label === entry.label)
      ) {
        continue;
      }
      const labelChanged = receipt !== undefined &&
        receipt.label !== entry.label;
      if (receipt?.complete && receipt.text !== entry.text) {
        if (body) {
          // Later output may already follow this body. Append only its new source text.
          receipt.base = receipt.text.length;
          receipt.offset = receipt.base;
          receipt.cursor = undefined;
          receipt.complete = false;
        } else receipt = undefined;
      }
      receipt ??= {
        position: entry.position,
        text: entry.text,
        label: entry.label,
        offset: 0,
        base: 0,
        width,
        labelPrinted: false,
        complete: false,
      };
      let cached = this.rendered.get(entry.id);
      if (
        cached?.entry !== entry || cached.width !== width ||
        cached.base !== receipt.base
      ) {
        cached = {
          entry,
          width,
          base: receipt.base,
          value: entryRows(
            receipt.base === 0 ? entry : { ...entry, text: entry.text.slice(receipt.base) },
            state,
            width,
            separated,
          ),
        };
        this.rendered.set(entry.id, cached);
      }
      const rendered = cached.value;
      let start = 0;
      if (receipt.labelPrinted) {
        const cursor = receipt.width === width && !labelChanged &&
            receipt.cursor !== undefined
          ? receipt.cursor
          : rendered.body.seek(receipt.offset - receipt.base, width);
        start = cursor === undefined
          ? rendered.rows.length
          : rendered.rows.findIndex((row) =>
            row.cursor?.block === cursor.block && row.cursor.row === cursor.row
          );
        if (start < 0) start = rendered.rows.length;
      }
      const pendingRows = receipt.complete && receipt.text === entry.text
        ? []
        : rendered.rows.slice(start);
      receipt.label = entry.label;
      receipt.text = entry.text;
      receipt.width = width;
      this.printed.set(entry.id, receipt);
      pending.push({
        entry,
        rows: { ...rendered, rows: pendingRows },
        receipt,
      });
    }
    let live: LayoutRow[] = [];
    this.liveEntry = undefined;
    for (let index = 0; index < pending.length; index++) {
      const { entry, rows, receipt } = pending[index];
      // Earlier output must precede later entries. The first tool state is committed once.
      const mutable = running && entry.live &&
        (entry.kind === 'assistant' || entry.kind === 'thinking') &&
        index === pending.length - 1;
      let count = mutable ? Math.max(0, rows.rows.length - capacity) : rows.rows.length;
      // A Markdown block can reflow internally as it grows (notably table columns).
      // Seal whole blocks instead of retaining a cursor inside an already printed block.
      const block = count > 0 ? rows.rows[count - 1].cursor?.block : undefined;
      if (mutable && block !== undefined) {
        while (
          count < rows.rows.length && rows.rows[count].cursor?.block === block
        ) count++;
      }
      committed.push(...rows.rows.slice(0, count).map(({ row }) => row));
      const remaining = rows.rows.slice(count);
      if (count > 0) {
        receipt.labelPrinted = true;
        receipt.cursor = remaining.find((row) => row.cursor !== undefined)
          ?.cursor;
        receipt.offset = remaining.find((row) =>
            row.cursor !== undefined
          )?.row.sourceUtf16Offset === undefined
          ? entry.text.length
          : receipt.base +
            remaining.find((row) => row.cursor !== undefined)!.row
              .sourceUtf16Offset!;
      }
      receipt.complete = !mutable || remaining.length === 0;
      if (receipt.complete) this.rendered.delete(entry.id);
      live = remaining.map(({ row }) => row);
      if (live.length > 0) this.liveEntry = entry;
    }
    return { committed, live };
  }
}
