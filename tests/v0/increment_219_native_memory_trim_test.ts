import { deepStrictEqual, strictEqual } from 'node:assert';
import {
  NATIVE_MEMORY_TRIM_INTERVAL_MS,
  NATIVE_MEMORY_TRIM_LIBRARY,
  startNativeMemoryTrim,
} from '../../v0/agent/runtime/native_memory_trim.ts';

Deno.test('Increment 219 Core trim runs every five minutes and releases its timer/library on stop', () => {
  if (Deno.build.os !== 'linux' || Deno.build.arch !== 'x86_64') return;
  const original = {
    dlopen: Deno.dlopen,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    unrefTimer: Deno.unrefTimer,
  };
  const calls: unknown[] = [];
  let tick: (() => void) | undefined;
  try {
    Deno.dlopen = ((path, symbols) => {
      strictEqual(path, NATIVE_MEMORY_TRIM_LIBRARY);
      deepStrictEqual(symbols, {
        malloc_trim: { parameters: ['usize'], result: 'i32' },
      });
      return {
        symbols: {
          malloc_trim: (pad: bigint) => {
            calls.push(pad);
            return 1;
          },
        },
        close: () => calls.push('library closed'),
      };
    }) as typeof Deno.dlopen;
    globalThis.setInterval = ((callback: () => void, milliseconds: number) => {
      strictEqual(milliseconds, 300_000);
      tick = callback;
      return 42;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (timer) => {
      strictEqual(timer, 42);
      calls.push('timer cleared');
      tick = undefined;
    };
    Deno.unrefTimer = (timer) => {
      strictEqual(timer, 42);
      calls.push('timer unref');
    };
    strictEqual(NATIVE_MEMORY_TRIM_INTERVAL_MS, 300_000);
    const stop = startNativeMemoryTrim();
    deepStrictEqual(calls, ['timer unref']);
    tick!();
    tick!();
    deepStrictEqual(calls, ['timer unref', 0n, 0n]);
    stop();
    deepStrictEqual(calls, [
      'timer unref',
      0n,
      0n,
      'timer cleared',
      'library closed',
    ]);
    strictEqual(tick, undefined);
  } finally {
    Deno.dlopen = original.dlopen;
    globalThis.setInterval = original.setInterval;
    globalThis.clearInterval = original.clearInterval;
    Deno.unrefTimer = original.unrefTimer;
  }
});
