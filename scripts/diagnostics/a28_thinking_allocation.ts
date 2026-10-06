/** Run on the archived source tree; input is a saved SessionSnapshot, never a provider call. */
import { getHeapStatistics } from 'node:v8';
import { thinkingBodyRenderer } from '../../v0/tui/assistant_layout.ts';
import { cellWidth, escapeTerminalText, segmentTerminalText } from '../../v0/tui/terminal_text.ts';

const snapshot = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const width = Number(Deno.args[1] ?? 90);
const encoder = new TextEncoder();
const heap = () =>
  getHeapStatistics() as ReturnType<typeof getHeapStatistics> & { total_allocated_bytes: number };
const gc = () => (globalThis as unknown as { gc: () => void }).gc();
const texts = Object.values(snapshot.conversation.entities)
  .filter((entity: unknown) => (entity as { kind: string }).kind === 'thinking')
  .map((entity: unknown) => (entity as { text: string }).text)
  .filter((text: string) => text.length > 0)
  .sort((left: string, right: string) =>
    encoder.encode(left).length - encoder.encode(right).length
  );
const candidates = [
  ['smallest', texts[0]],
  ['median', texts[Math.floor(texts.length / 2)]],
  [
    'few-kib',
    texts.reduce((nearest, text) =>
      Math.abs(encoder.encode(text).length - 4096) < Math.abs(encoder.encode(nearest).length - 4096)
        ? text
        : nearest
    ),
  ],
  ['largest', texts.at(-1)],
] as const;
gc();
const controlBefore = heap();
const controlAfter = heap();
const measurementOnlyAllocatedBytes = controlAfter.total_allocated_bytes -
  controlBefore.total_allocated_bytes;
const components = [];
if (Deno.args.includes('--components')) {
  for (const [name, text] of candidates) {
    if (text === undefined || (name !== 'few-kib' && name !== 'largest')) continue;
    const asciiText = text.replace(/[^\x20-\x7e\n]/gu, 'x');
    const operations: [string, () => unknown][] = [
      ['segment-source-lines', () => text.split('\n').map(segmentTerminalText)],
      [
        'measure-source-line-widths',
        () => text.split('\n').map((raw) => cellWidth(escapeTerminalText(raw))),
      ],
      ['full-wrap', () => thinkingBodyRenderer.render(text, 'streaming', width)],
      // Changed diagnostic input to isolate the ASCII fast path, not a product fix.
      ['ascii-input-full-wrap', () => thinkingBodyRenderer.render(asciiText, 'streaming', width)],
    ];
    for (const [operation, execute] of operations) {
      for (let index = 0; index < 20; index++) execute();
      gc();
      const before = heap();
      for (let index = 0; index < 200; index++) execute();
      const after = heap();
      components.push({
        name,
        operation,
        amortizedAllocatedBytesPerCall:
          (after.total_allocated_bytes - before.total_allocated_bytes) / 200,
      });
    }
  }
}
const results = [];
for (const [name, text] of candidates) {
  if (text === undefined) continue;
  // Warm this path before collecting coarse batch counters. No per-character instrumentation.
  for (let index = 0; index < 20; index++) thinkingBodyRenderer.render(text, 'streaming', width);
  gc();
  const before = heap();
  let lines = thinkingBodyRenderer.render(text, 'streaming', width);
  const after = heap();
  const lineCount = lines.length;
  gc();
  const retained = heap();
  lines = [];
  gc();
  const released = heap();
  const batchBefore = heap();
  const start = performance.now();
  for (let index = 0; index < 200; index++) {
    thinkingBodyRenderer.render(text, 'streaming', width);
  }
  const elapsedMs = performance.now() - start;
  const batchAfter = heap();
  gc();
  const batchGc = heap();
  results.push({
    name,
    utf8Bytes: encoder.encode(text).length,
    codeUnits: text.length,
    sourceLines: text.split('\n').length,
    largestSourceLineBytes: Math.max(
      ...text.split('\n').map((value) => encoder.encode(value).length),
    ),
    width,
    lineCount,
    oneCallAllocatedBytes: after.total_allocated_bytes - before.total_allocated_bytes,
    oneCallHeapUsedDelta: after.used_heap_size - before.used_heap_size,
    outputRetainedHeapDelta: retained.used_heap_size - before.used_heap_size,
    afterReleaseHeapDelta: released.used_heap_size - before.used_heap_size,
    batchCalls: 200,
    batchAllocatedBytes: batchAfter.total_allocated_bytes - batchBefore.total_allocated_bytes,
    amortizedAllocatedBytesPerCall:
      (batchAfter.total_allocated_bytes - batchBefore.total_allocated_bytes) / 200,
    batchElapsedMs: elapsedMs,
    batchAfterGcUsedHeap: batchGc.used_heap_size,
    batchAfterGcPhysicalHeap: batchGc.total_physical_size,
  });
}
console.log(
  JSON.stringify(
    { thinkingEntities: texts.length, measurementOnlyAllocatedBytes, results, components },
    null,
    2,
  ),
);
