# External runtime hooks

Hook source is loaded by each new Agent Worker from the config-root catalog. The standalone
executable includes the `@henji/hooks` API, so a hook does not need a separate Deno installation or
repository checkout at runtime.

The package ships `runtime-start-time` under `hooks/runtime-start-time/`. After installation it is
available at `hooks/runtime-start-time/index.ts` relative to the Henji config root. The hook adds
the Worker's start time, local timezone name, and UTC offset to shared context. That value describes
the start of that Worker and stays the same for its later turns.

Custom hook modules can import the public contract:

```ts
import type { HookHandlers } from '@henji/hooks';

const handlers: HookHandlers = {
  runtime_start: () => ({ context: ['Shared context for this Worker'] }),
};

export default (): HookHandlers => handlers;
```

Add the module path to `hooks.json` and select its name in the common `default` list or in an
Agent's `hooks` array. Agent arrays replace the common defaults in their listed order; an empty
array disables external hooks for that Agent. New Workers read the edited source. A Worker that has
already started keeps the handlers it loaded.

Reinstalling retains hook source and catalog edits. Use `install.sh --replace-hooks` to copy the
packaged hook source over the installed source; this leaves `hooks.json` unchanged.
