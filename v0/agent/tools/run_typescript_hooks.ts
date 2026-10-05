import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModuleReply, ModuleRequest } from './run_typescript_module_protocol.ts';
import { requireStdSpecifier, requireStdUrl } from './run_typescript_std.ts';

/** Resolve remote imports on the code thread while another Worker performs asynchronous IO. */
export const installModuleHooks = (
  cache: string,
  fetcher: MessagePort,
): () => void => {
  const mirror = pathToFileURL(`${cache}/modules/`).href;
  const readTextFile = Deno.readTextFileSync.bind(Deno);
  let requestId = 0;
  const hooks = registerHooks({
    resolve(specifier, context) {
      const relativeMirrorImport = context.parentURL?.startsWith(mirror) &&
        (!/^[a-zA-Z][a-zA-Z+.-]*:/u.test(specifier) ||
          specifier.startsWith(mirror));
      if (specifier.startsWith('jsr:')) requireStdSpecifier(specifier);
      else if (specifier.startsWith('https:')) {
        requireStdUrl(new URL(specifier));
      } else if (!relativeMirrorImport) {
        throw new Error(`Only Deno std imports are allowed: ${specifier}`);
      }
      const signal = new Int32Array(new SharedArrayBuffer(4));
      const replyPath = `${cache}/reply-${++requestId}.json`;
      const request: ModuleRequest = {
        specifier,
        parentURL: context.parentURL,
        cache,
        replyPath,
        signal,
      };
      fetcher.postMessage(request);
      Atomics.wait(signal, 0, 0);
      const reply: ModuleReply = JSON.parse(readTextFile(replyPath));
      if (!reply.ok) throw new Error(reply.error);
      if (!reply.url.startsWith(mirror)) {
        throw new Error(`Only Deno std imports are allowed: ${reply.url}`);
      }
      return { url: reply.url, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(mirror)) {
        throw new Error(`Only Deno std imports are allowed: ${url}`);
      }
      if (!/\.(?:[mc]?ts|[mc]?js)$/u.test(url)) {
        return nextLoad(url, context);
      }
      const source = readTextFile(fileURLToPath(url));
      // Source Deno otherwise graphs static dependencies before our resolver can acquire them.
      // Use its built-in TS transform and let the runtime resolve each dependency through hooks.
      return {
        source: /\.[mc]?ts$/u.test(url)
          ? stripTypeScriptTypes(source, { mode: 'transform' })
          : source,
        format: 'module',
        shortCircuit: true,
      };
    },
  });
  return () => {
    hooks.deregister();
    fetcher.close();
  };
};
