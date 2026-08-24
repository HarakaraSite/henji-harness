import {
  type Failure,
  failure,
  type InstalledExtension,
  type Manifest,
  parseManifest,
} from './domain.ts';

const encoder = new TextEncoder();

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer as ArrayBuffer),
    ),
  );

const canonicalManifest = (manifest: Manifest): string =>
  JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    version: manifest.version,
    revision: manifest.revision,
    entrypoint: manifest.entrypoint,
  });

export const contentDigest = (manifest: Manifest, source: Uint8Array): Promise<string> =>
  sha256(new Uint8Array([...encoder.encode(canonicalManifest(manifest)), 10, ...source]));

const isWord = (value: string | undefined): boolean =>
  value !== undefined && /[A-Za-z0-9_$]/.test(value);

/** Conservative scanner: it rejects every live import/export/loader token and ambiguous syntax. */
export const scanSelfContained = (source: string): Failure | undefined => {
  if (/^\s*\/\/\/\s*<reference\b/m.test(source)) {
    return failure('source_rejected', 'triple-slash references are not allowed');
  }
  let i = 0;
  let code = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end;
      code += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return failure('source_rejected', 'unterminated comment');
      i = end + 2;
      code += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      if (i > source.length || source[i - 1] !== quote) {
        return failure('source_rejected', 'unterminated string');
      }
      code += ' STR ';
      continue;
    }
    if (ch === '`') {
      i++;
      let interpolation = false;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') interpolation = true;
        if (source[i] === '`') {
          i++;
          break;
        }
        i++;
      }
      if (i > source.length || source[i - 1] !== '`' || interpolation) {
        return failure('source_rejected', 'template interpolation is not allowed');
      }
      code += ' STR ';
      continue;
    }
    code += ch;
    i++;
  }
  const token = /\b(import|export|require|createRequire|Worker)\b/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(code)) !== null) {
    const word = match[1];
    const before = code[match.index - 1];
    const after = code[match.index + word.length];
    if (isWord(before) || isWord(after)) continue;
    if (
      word === 'import' || word === 'export' || word === 'require' || word === 'createRequire' ||
      word === 'Worker'
    ) return failure('source_rejected', `source token ${word} is not allowed`);
  }
  if (/\bimport\s*\./.test(code) || /\bimport\s*\(/.test(code)) {
    return failure('source_rejected', 'dynamic import is not allowed');
  }
  return undefined;
};

const sourcePath = (path: string): string => path.replace(/\\/g, '/');

export interface PreparedExtension {
  readonly manifest: Manifest;
  readonly main: Uint8Array;
  readonly digest: string;
  readonly sourceOrigin: string;
}

export const prepareExtension = async (sourceDir: string): Promise<PreparedExtension | Failure> => {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(sourceDir)];
  } catch {
    return failure('not_found', 'extension source directory is not readable');
  }
  const names = entries.map((entry) => entry.name).sort();
  if (names.join(',') !== 'main.ts,manifest.json') {
    return failure('invalid_manifest', 'source must contain only manifest.json and main.ts');
  }
  for (const entry of entries) {
    if (entry.isSymlink) return failure('source_rejected', 'symlinks are not accepted');
  }
  let manifestValue: unknown;
  let main: Uint8Array;
  try {
    manifestValue = JSON.parse(await Deno.readTextFile(`${sourceDir}/manifest.json`));
    main = await Deno.readFile(`${sourceDir}/main.ts`);
  } catch {
    return failure('invalid_manifest', 'manifest or main.ts cannot be read');
  }
  const manifest = parseManifest(manifestValue);
  if ('code' in manifest) return manifest;
  const rejected = scanSelfContained(new TextDecoder().decode(main));
  if (rejected) return rejected;
  const digest = await contentDigest(manifest, main);
  return { manifest, main, digest, sourceOrigin: sourcePath(sourceDir) };
};

export const installedPath = (stateDir: string, extension: InstalledExtension): string =>
  `${stateDir}/extensions/${extension.id}/${extension.digest}`;

export const manifestBytes = (manifest: Manifest): Uint8Array =>
  encoder.encode(`${canonicalManifest(manifest)}\n`);
