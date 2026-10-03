const directoryPath = new URL(import.meta.url).searchParams.get('root');
if (directoryPath === null) throw new Error('schema lock directory is required');

const originalOpen = Deno.open.bind(Deno);
Object.defineProperty(Deno, 'open', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: async (path: string | URL, options?: Deno.OpenOptions): Promise<Deno.FsFile> => {
    const file = await originalOpen(path, options);
    if (path !== directoryPath) return file;
    return new Proxy(file, {
      get(target, property) {
        if (property === 'lock') {
          return async (exclusive?: boolean): Promise<void> => {
            Deno.stdout.writeSync(new TextEncoder().encode('schema-lock-attempt\n'));
            await target.lock(exclusive);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Deno.FsFile;
  },
});

await import('../../../v0/agent/data/data_bootstrap.ts');
