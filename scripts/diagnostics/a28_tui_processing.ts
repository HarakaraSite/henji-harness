/** Saved semantic replay only: no Core/TUI process, terminal writes, or provider calls.
 * deno run --config deno.v0.json --cached-only --allow-read=INPUT_DIR \
 *   scripts/diagnostics/a28_tui_processing.ts INPUT_DIR
 */
import { initialSessionClientState, reduceSessionStreamFrame } from '../../v0/api/reducer.ts';
import type { SessionSnapshot, SessionStreamFrame } from '../../v0/api/contract.ts';
import { SnapshotConversationProjector } from '../../v0/tui/snapshot_presentation.ts';
import { BodyDocument } from '../../v0/tui/body_document.ts';
import { TuiRenderer } from '../../v0/tui/tui_renderer.ts';
import type { TerminalPort } from '../../v0/tui/terminal.ts';
const input = Deno.args[0];
if (input === undefined) throw new Error('usage: a28_tui_processing.ts INPUT_DIR');
const saved: SessionSnapshot = JSON.parse(
  await Deno.readTextFile(`${input}/session-snapshot.json`),
);
const frames: SessionStreamFrame[] = (await Deno.readTextFile(`${input}/frames.jsonl`)).trim()
  .split('\n').map((line) => JSON.parse(line));
const first = frames[0];
const firstCursor = first.kind === 'session.snapshot' ? first.snapshot.cursor : first.cursor;
const initial: SessionSnapshot = {
  ...saved,
  cursor: { ...saved.cursor, coreEpoch: firstCursor.coreEpoch, revision: 0 },
  conversation: { ...saved.conversation, cut: 0, storeRevision: 0, entities: {}, order: [] },
};
let state = initialSessionClientState(initial);
const projector = new SnapshotConversationProjector();
let generatedRows = 0, generatedUtf16 = 0, draws = 0, unchangedViews = 0;
const original = BodyDocument.prototype.render;
BodyDocument.prototype.render = function (...args) {
  const result = original.apply(this, args);
  generatedRows++;
  generatedUtf16 += result.text.length;
  return result;
};
const terminal: TerminalPort = {
  stdinIsTerminal: () => true,
  stdoutIsTerminal: () => true,
  consoleSize: () => ({ columns: 90, rows: 30 }),
  setRaw: () => {},
  read: () => Promise.resolve(null),
  drainAndCloseInput: () => Promise.resolve(),
  write: () => {
    draws++;
  },
  addSignal: () => {},
  removeSignal: () => {},
};
const renderer = new TuiRenderer(terminal, { setTimeout: () => 0, clearTimeout: () => {} });
let previousView: unknown;
const apply = () => {
  const projected = projector.project(state, 'saved-replay');
  renderer.setKeyedConversationStore(projected.store);
  renderer.flushRender();
  const view = renderer.layoutSnapshot().log.map((row) => row.text).join('\n');
  if (view === previousView) unchangedViews++;
  previousView = view;
};
apply();
const start = performance.now();
for (const frame of frames) {
  state = reduceSessionStreamFrame(state, frame);
  apply();
}
const replayMs = performance.now() - start;
const before = { generatedRows, generatedUtf16 };
for (let i = 0; i < 100; i++) {
  renderer.setEditor('draft ' + i);
  renderer.setStatus('status ' + i);
  renderer.flushRender();
}
const editorFooterGeneratedRows = generatedRows - before.generatedRows;
const actual = state.snapshot.conversation;
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable) : v !== null && typeof v === 'object'
    ? Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]),
    )
    : v;
const sourceView = (c: typeof actual) =>
  c.order.map((id) => c.entities[id]).filter((e) =>
    ['message', 'thinking', 'tool'].includes(e.kind)
  ).map((e) => {
    const rest = { ...e } as Record<string, unknown>;
    delete rest.version;
    delete rest.semanticOccurrenceId;
    if (rest.kind === 'message') return { ...rest, toolIds: rest.toolIds ?? [] };
    return rest;
  });
const displaySourceEqual = JSON.stringify(stable(sourceView(actual))) ===
  JSON.stringify(stable(sourceView(saved.conversation)));
const semanticEqual =
  JSON.stringify(stable(actual.order)) === JSON.stringify(stable(saved.conversation.order)) &&
  JSON.stringify(stable(actual.entities)) === JSON.stringify(stable(saved.conversation.entities));
renderer.close();
BodyDocument.prototype.render = original;
console.log(JSON.stringify(
  {
    updates: frames.length,
    draws,
    generatedRows: before.generatedRows,
    generatedUtf16: before.generatedUtf16,
    unchangedViews,
    editorFooterGeneratedRows,
    replayMs,
    semanticEqual,
    displaySourceEqual,
    orderEqual: JSON.stringify(actual.order) === JSON.stringify(saved.conversation.order),
    savedEntityCount: Object.keys(saved.conversation.entities).length,
    differingEntities: Object.keys(actual.entities).filter((id) =>
      JSON.stringify(stable(actual.entities[id])) !==
        JSON.stringify(stable(saved.conversation.entities[id]))
    ).map((id) => ({
      id,
      fields: [
        ...new Set([
          ...Object.keys(actual.entities[id]),
          ...Object.keys(saved.conversation.entities[id] ?? {}),
        ]),
      ].filter((k) =>
        JSON.stringify(stable((actual.entities[id] as unknown as Record<string, unknown>)[k])) !==
          JSON.stringify(
            stable((saved.conversation.entities[id] as unknown as Record<string, unknown>)?.[k]),
          )
      ),
    })),
    entityCount: Object.keys(actual.entities).length,
  },
  null,
  2,
));
