import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import type { ModuleReply, ModuleRequest } from './run_typescript_module_protocol.ts';
import { requireStdSpecifier, requireStdUrl } from './run_typescript_std.ts';

interface PackageMetadata {
  readonly latest: string;
  readonly versions: Readonly<Record<string, { readonly yanked?: boolean }>>;
}
interface VersionMetadata {
  readonly exports: Readonly<Record<string, string>>;
}

// All acquisition state belongs to this call's Worker; no persistent cache or provider client.
const fetched = new Map<string, string>();
const metadata = new Map<string, unknown>();

const getJson = async <T>(url: string): Promise<T> => {
  if (!metadata.has(url)) {
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    metadata.set(url, await response.json());
  }
  return metadata.get(url) as T;
};

const resolveJsr = async (specifier: string): Promise<string> => {
  requireStdSpecifier(specifier);
  const match = /^jsr:(@[^/]+\/[^@/]+)(?:@([^/]+))?(\/.*)?$/.exec(specifier);
  if (!match) throw new Error(`Invalid JSR specifier: ${specifier}`);
  const [, name, range, subpath] = match;
  const packageMeta = await getJson<PackageMetadata>(
    `https://jsr.io/${name}/meta.json`,
  );
  const version = !range || range === 'latest' ? packageMeta.latest : semver.maxSatisfying(
    Object.entries(packageMeta.versions).filter(([, info]) => !info.yanked)
      .map(([v]) => v),
    range,
  );
  if (version === null) throw new Error(`No JSR version matches ${specifier}`);
  const versionMeta = await getJson<VersionMetadata>(
    `https://jsr.io/${name}/${version}_meta.json`,
  );
  const exported = versionMeta.exports[subpath ? `.${subpath}` : '.'];
  if (typeof exported !== 'string') {
    throw new Error(`No JSR export for ${specifier}`);
  }
  return new URL(exported, `https://jsr.io/${name}/${version}/`).href;
};

const resolveRequest = async (request: ModuleRequest): Promise<string> => {
  const mirror = pathToFileURL(`${request.cache}/modules/`).href;
  let url: URL;
  if (request.specifier.startsWith('jsr:')) {
    url = new URL(await resolveJsr(request.specifier));
  } else if (request.specifier.startsWith('https:')) {
    url = new URL(request.specifier);
  } else {
    const local = new URL(request.specifier, request.parentURL);
    if (!local.href.startsWith(mirror)) {
      throw new Error(
        `Only Deno std imports are allowed: ${request.specifier}`,
      );
    }
    const relative = local.href.slice(mirror.length);
    const slash = relative.indexOf('/');
    url = new URL(
      `https://${relative.slice(0, slash)}/${relative.slice(slash + 1)}`,
    );
  }
  requireStdUrl(url);
  const previous = fetched.get(url.href);
  if (previous !== undefined) return previous;
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const localUrl = new URL(url.host + url.pathname, mirror);
  const localPath = fileURLToPath(localUrl);
  await Deno.mkdir(dirname(localPath), { recursive: true });
  await Deno.writeTextFile(localPath, await response.text());
  fetched.set(url.href, localUrl.href);
  return localUrl.href;
};

const workerSelf = self as unknown as {
  onmessage: (event: MessageEvent<{ port: MessagePort }>) => void;
};
workerSelf.onmessage = (setup) => {
  const port = setup.data.port;
  port.onmessage = async (event: MessageEvent<ModuleRequest>) => {
    const request = event.data;
    let reply: ModuleReply;
    try {
      reply = { ok: true, url: await resolveRequest(request) };
    } catch (error) {
      reply = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // Write failures propagate to the owning tool's fetcher.onerror instead of stranding a waiter.
    try {
      await Deno.writeTextFile(request.replyPath, JSON.stringify(reply));
    } finally {
      Atomics.store(request.signal, 0, 1);
      Atomics.notify(request.signal, 0);
    }
  };
};
