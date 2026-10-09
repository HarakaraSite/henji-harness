/** Provisional cadence for returning unused allocator pages during long executions. */
export const NATIVE_MEMORY_TRIM_INTERVAL_MS = 5 * 60 * 1000;
export const NATIVE_MEMORY_TRIM_LIBRARY = '/lib/x86_64-linux-gnu/libc.so.6';

/** One allocator maintenance timer owned by the Linux/glibc Core process. */
export const startNativeMemoryTrim = (): () => void => {
  if (Deno.build.os !== 'linux' || Deno.build.arch !== 'x86_64') {
    return () => {};
  }

  const library = Deno.dlopen(NATIVE_MEMORY_TRIM_LIBRARY, {
    malloc_trim: { parameters: ['usize'], result: 'i32' },
  });
  const timer = setInterval(() => {
    library.symbols.malloc_trim(0n);
  }, NATIVE_MEMORY_TRIM_INTERVAL_MS);
  Deno.unrefTimer(timer);

  return () => {
    clearInterval(timer);
    library.close();
  };
};
