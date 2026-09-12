import { createGraph } from '@deno/graph';
import { parse } from 'es-module-lexer';
import {
  createManagedDefinitionManifest,
  type DefinitionLocalDependencyV1,
  type DefinitionRevisionContent,
  type ManagedDefinitionCustodyV1,
  type ManagedDefinitionManifestV1,
} from './managed_definition_manifest.ts';
import {
  type DefinitionRevisionRef,
  isExternalDefinitionResourceId,
} from './managed_resource_ref.ts';
import { AGENT_DEFINITION_API_CONTRACT } from '../runtime/build_manifest.ts';

export type ManagedDefinitionErrorCode =
  | 'module_not_found'
  | 'module_invalid'
  | 'module_api_unsupported'
  | 'module_io_failure'
  | 'module_import_unsupported'
  | 'module_artifact_not_found'
  | 'module_artifact_exists'
  | 'module_artifact_io_failure';

export class ManagedDefinitionError extends Error {
  constructor(
    readonly code: ManagedDefinitionErrorCode,
    message: string,
    readonly definition?: DefinitionRevisionRef,
  ) {
    super(message);
    this.name = 'ManagedDefinitionError';
  }
}

export interface ManagedDefinitionImportOptions {
  readonly entryPath: string;
  readonly resourceId: string;
  readonly declaredRole: 'parent' | 'planner';
  readonly moduleRoot?: string;
  readonly now?: () => Date;
}

export interface ImportedManagedDefinition {
  readonly manifest: ManagedDefinitionManifestV1;
  readonly custody: ManagedDefinitionCustodyV1;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const fileUrl = (path: string): URL => {
  const url = new URL('file:///');
  url.pathname = path;
  return url;
};

const directoryUrl = (path: string): URL => {
  const url = fileUrl(path.endsWith('/') ? path : `${path}/`);
  return url;
};

const absolutePath = (url: URL): string => decodeURIComponent(url.pathname);

const inside = (root: string, path: string): boolean =>
  path === root || (root === '/' ? path.startsWith('/') : path.startsWith(`${root}/`));

const relativePath = (rootUrl: URL, moduleUrl: URL): string => {
  if (!moduleUrl.href.startsWith(rootUrl.href)) {
    throw new ManagedDefinitionError(
      'module_import_unsupported',
      `Definition dependency is outside module root: ${moduleUrl.href}`,
    );
  }
  const value = decodeURIComponent(moduleUrl.href.slice(rootUrl.href.length));
  if (
    value.length === 0 || value.startsWith('/') ||
    value.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    !value.endsWith('.ts')
  ) {
    throw new ManagedDefinitionError(
      'module_import_unsupported',
      `Definition dependency is not a canonical .ts path: ${moduleUrl.href}`,
    );
  }
  return value;
};

export const analyzeDefinitionSourceDependencies = (
  source: string,
  moduleUrl: URL,
  rootUrl: URL,
  apiContract: string,
): readonly DefinitionLocalDependencyV1[] => {
  let imports: ReturnType<typeof parse>[0];
  try {
    [imports] = parse(source, moduleUrl.href);
  } catch (error) {
    throw new ManagedDefinitionError(
      'module_invalid',
      `Definition module syntax could not be analyzed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const dependencies: DefinitionLocalDependencyV1[] = [];
  for (const item of imports) {
    if (item.type === 'import-meta') continue;
    if (item.type === 'dynamic') {
      throw new ManagedDefinitionError(
        'module_import_unsupported',
        `Dynamic import is not supported in Definition modules: ${moduleUrl.href}`,
      );
    }
    const specifier = item.specifier;
    if (specifier === null) {
      throw new ManagedDefinitionError(
        'module_invalid',
        `Definition import specifier could not be read: ${moduleUrl.href}`,
      );
    }
    if (specifier === '@henji/agent') {
      dependencies.push({
        specifier,
        target: { kind: 'embedded-api', contract: apiContract },
        typeOnly: item.typeOnly,
      });
      continue;
    }
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw new ManagedDefinitionError(
        'module_import_unsupported',
        `Definition import is not relative or @henji/agent: ${specifier}`,
      );
    }
    const target = new URL(specifier, moduleUrl);
    dependencies.push({
      specifier,
      target: { kind: 'local', path: relativePath(rootUrl, target) },
      typeOnly: item.typeOnly,
    });
  }
  return Object.freeze(dependencies);
};

const ioMessage = (label: string, error: unknown): ManagedDefinitionError =>
  error instanceof Deno.errors.NotFound
    ? new ManagedDefinitionError('module_not_found', `${label} not found`)
    : new ManagedDefinitionError(
      'module_io_failure',
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );

const realDirectory = async (path: string, label: string): Promise<string> => {
  let canonical: string;
  try {
    canonical = await Deno.realPath(path);
    const info = await Deno.lstat(canonical);
    if (!info.isDirectory) {
      throw new ManagedDefinitionError('module_invalid', `${label} is not a directory`);
    }
  } catch (error) {
    if (error instanceof ManagedDefinitionError) throw error;
    throw ioMessage(label, error);
  }
  return canonical;
};

const realFile = async (path: string, label: string): Promise<string> => {
  let canonical: string;
  try {
    canonical = await Deno.realPath(path);
    const info = await Deno.lstat(canonical);
    if (!info.isFile) {
      throw new ManagedDefinitionError('module_invalid', `${label} is not a file`);
    }
  } catch (error) {
    if (error instanceof ManagedDefinitionError) throw error;
    throw ioMessage(label, error);
  }
  return canonical;
};

export const importManagedDefinition = async (
  options: ManagedDefinitionImportOptions,
): Promise<ImportedManagedDefinition> => {
  if (!isExternalDefinitionResourceId(options.resourceId)) {
    throw new ManagedDefinitionError('module_invalid', 'Definition module ID is invalid');
  }
  const entryPath = await realFile(options.entryPath, 'Definition entry');
  if (!entryPath.endsWith('.ts')) {
    throw new ManagedDefinitionError('module_import_unsupported', 'Definition entry must be .ts');
  }
  const defaultRoot = entryPath.slice(0, entryPath.lastIndexOf('/')) || '/';
  const moduleRoot = await realDirectory(
    options.moduleRoot ?? defaultRoot,
    'Definition module root',
  );
  if (!inside(moduleRoot, entryPath)) {
    throw new ManagedDefinitionError(
      'module_import_unsupported',
      'Definition entry is outside module root',
    );
  }
  const rootUrl = directoryUrl(moduleRoot);
  const entryUrl = fileUrl(entryPath);
  const entry = relativePath(rootUrl, entryUrl);
  const loaded = new Map<string, {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly dependencies: readonly DefinitionLocalDependencyV1[];
  }>();
  let loaderError: ManagedDefinitionError | undefined;
  let graph;
  try {
    graph = await createGraph(entryUrl.href, {
      kind: 'all',
      resolve: (specifier, referrer) => {
        if (specifier === '@henji/agent') return 'henji:agent';
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          throw new ManagedDefinitionError(
            'module_import_unsupported',
            `Definition import is not relative or @henji/agent: ${specifier}`,
          );
        }
        return new URL(specifier, referrer).href;
      },
      load: async (specifier, isDynamic) => {
        try {
          if (isDynamic) {
            throw new ManagedDefinitionError(
              'module_import_unsupported',
              `Dynamic import is not supported in Definition modules: ${specifier}`,
            );
          }
          if (specifier === 'henji:agent') return { kind: 'external', specifier };
          const url = new URL(specifier);
          if (url.protocol !== 'file:') {
            throw new ManagedDefinitionError(
              'module_import_unsupported',
              `Definition import protocol is not supported: ${url.protocol}`,
            );
          }
          const path = absolutePath(url);
          const canonical = await realFile(path, 'Definition dependency');
          if (!inside(moduleRoot, canonical)) {
            throw new ManagedDefinitionError(
              'module_import_unsupported',
              `Definition dependency is outside module root: ${specifier}`,
            );
          }
          const relative = relativePath(rootUrl, url);
          const bytes = await Deno.readFile(url).catch((error) => {
            throw ioMessage('Definition dependency', error);
          });
          let source: string;
          try {
            source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            throw new ManagedDefinitionError(
              'module_invalid',
              `Definition module is not UTF-8: ${relative}`,
            );
          }
          loaded.set(specifier, {
            path: relative,
            bytes,
            dependencies: analyzeDefinitionSourceDependencies(
              source,
              url,
              rootUrl,
              AGENT_DEFINITION_API_CONTRACT,
            ),
          });
          return { kind: 'module', specifier, content: bytes };
        } catch (error) {
          if (error instanceof ManagedDefinitionError) loaderError ??= error;
          throw error;
        }
      },
    });
  } catch (error) {
    if (error instanceof ManagedDefinitionError) throw error;
    throw new ManagedDefinitionError(
      'module_invalid',
      `Definition module graph is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (loaderError !== undefined) throw loaderError;
  for (const module of graph.modules) {
    if (module.error !== undefined) {
      throw new ManagedDefinitionError('module_invalid', module.error);
    }
    if (module.kind !== 'esm' && module.kind !== 'external') {
      throw new ManagedDefinitionError(
        'module_import_unsupported',
        `Definition module kind is not supported: ${module.kind ?? 'unknown'}`,
      );
    }
  }
  const files = [...loaded.values()];
  if (!files.some((file) => file.path === entry)) {
    throw new ManagedDefinitionError('module_invalid', 'Definition entry was not loaded');
  }
  const content: DefinitionRevisionContent = {
    resourceId: options.resourceId,
    declaredRole: options.declaredRole,
    apiContract: AGENT_DEFINITION_API_CONTRACT,
    entry,
    files,
  };
  const manifest = await createManagedDefinitionManifest(content);
  const custody: ManagedDefinitionCustodyV1 = Object.freeze({
    schemaVersion: 1,
    originLineage: Object.freeze({
      kind: 'source',
      entryPath,
      moduleRoot,
    }),
    localCustody: Object.freeze({
      kind: 'installed',
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
    }),
  });
  return {
    manifest,
    custody,
    files: new Map(files.map((file) => [file.path, file.bytes] as const)),
  };
};
