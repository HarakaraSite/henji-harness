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

interface PrintedEntry {
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
        ...(projection?.rowTone === undefined ? {} : { rowTone: projection.rowTone }),
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
  private headerKey: string | undefined;
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
    this.headerKey = undefined;
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
    const committed: LayoutRow[] = [];
    if (state.startup !== undefined) {
      const startup = state.startup.state;
      const position = state.startup.position;
      const key = JSON.stringify([
        startup.productVersion,
        startup.coreEpoch,
        startup.sessionMode.kind,
        startup.workspace,
        startup.agentId,
        startup.startupEvaluation,
        startup.instructions,
        startup.skills,
        startup.trust.hardSandbox,
        startup.baseInstruction,
        position.sessionId,
        position.createdAt,
        position.title,
      ]);
      if (key !== this.headerKey) {
        committed.push(
          ...startupHeaderLines(
            state.startup.state,
            state.startup.position,
            width,
            state.terminalSize.rows,
          )
            .map((text): LayoutRow => ({ text, kind: 'log' })),
        );
        this.headerKey = key;
      }
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
      // Settled records do not need another projection on editor/footer redraws.
      if (
        receipt?.complete && receipt.text === entry.text &&
        receipt.label === entry.label
      ) {
        continue;
      }
      const labelChanged = receipt !== undefined &&
        receipt.label !== entry.label;
      if (
        receipt !== undefined &&
        !entry.text.startsWith(receipt.text.slice(0, receipt.offset))
      ) {
        receipt = undefined;
      }
      if (receipt?.complete && receipt.text !== entry.text) {
        if (
          (entry.kind === 'assistant' || entry.kind === 'thinking') &&
          entry.text.startsWith(receipt.text)
        ) {
          // Later output may already follow this body. Append only its new source text.
          receipt.base = receipt.text.length;
          receipt.offset = receipt.base;
          receipt.labelPrinted = false;
          receipt.cursor = undefined;
          receipt.complete = false;
        } else receipt = undefined;
      }
      receipt ??= {
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
        const cursor = receipt.width === width && !labelChanged
          ? receipt.cursor
          : rendered.body.seek(receipt.offset - receipt.base, width);
        start = cursor === undefined
          ? rendered.rows.length
          : rendered.rows.findIndex((row) =>
            row.cursor?.block === cursor.block && row.cursor.row === cursor.row
          );
        if (start < 0) start = rendered.rows.length;
      }
      let pendingRows = receipt.complete && receipt.text === entry.text
        ? []
        : rendered.rows.slice(start);
      if (labelChanged && receipt.labelPrinted) {
        pendingRows = [
          ...rendered.rows.filter((row) => row.cursor === undefined),
          ...pendingRows,
        ];
      }
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
      // Earlier output must precede later entries. Tool activity is appended at each change,
      // so a result never rewrites its start after that start entered terminal history.
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
