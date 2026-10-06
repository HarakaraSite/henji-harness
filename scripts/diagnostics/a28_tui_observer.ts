/** Probe-only module copied into an archived source tree by a28_tui_memory.py. */
import { getHeapStatistics } from 'node:v8';

const evidence = Deno.env.get('HENJI_TUI_MEMORY_PROBE')!;
const heap = () =>
  getHeapStatistics() as ReturnType<typeof getHeapStatistics> & { total_allocated_bytes: number };
let inspect: (() => unknown) | undefined;
let seen = '';
let started = 0;
let layoutCalls = 0;
let thinkingCalls = 0;
let thinkingCodeUnits = 0;

export const registerTuiProbeState = (read: () => unknown): void => {
  inspect = read;
};
export const countEntryLayout = (kind: string, codeUnits: number): void => {
  layoutCalls++;
  if (kind === 'thinking') {
    thinkingCalls++;
    thinkingCodeUnits += codeUnits;
  }
};
const timer = setInterval(async () => {
  let command: { id: string; action: string };
  try {
    command = JSON.parse(Deno.readTextFileSync(`${evidence}/command.json`));
  } catch {
    return;
  }
  if (command.id === seen) return;
  seen = command.id;
  if (command.action === 'reset') {
    layoutCalls = thinkingCalls = thinkingCodeUnits = 0;
    started = heap().total_allocated_bytes;
  }
  if (command.action === 'gc') (globalThis as unknown as { gc: () => void }).gc();
  const memory = Deno.memoryUsage();
  const statistics = heap();
  const result: Record<string, unknown> = {
    command,
    memory,
    heap: statistics,
    allocatedSinceReset: statistics.total_allocated_bytes - started,
    layoutCalls,
    thinkingCalls,
    thinkingCodeUnits,
  };
  // Serialize/hash state only AFTER natural and GC measurements, not during the replay.
  if (command.action === 'describe') {
    const state = inspect!();
    const text = JSON.stringify(state);
    result.stateSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    const current = state as {
      cursor: { revision: number };
      conversation: { entities: Record<string, unknown> };
    };
    result.cursorRevision = current.cursor.revision;
    result.entities = Object.keys(current.conversation.entities).length;
  }
  Deno.writeTextFileSync(`${evidence}/sample-${command.id}.json`, JSON.stringify(result));
  Deno.writeTextFileSync(`${evidence}/ack`, command.id);
}, 250);
(timer as unknown as { unref?: () => void }).unref?.();
