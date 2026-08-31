import { assert, assertEquals } from './test_helpers.ts';
import {
  buildWorkspacePathIndex,
  escapeFileReference,
  FILE_REFERENCE_MAX_VISITED,
  type FileReferenceEntry,
  type FileReferenceFs,
  type FileReferenceStat,
  WorkspacePathIndex,
} from '../../v0/tui/file_reference.ts';

Deno.test('workspace path completion is deterministic and bounded', () => {
  const index = WorkspacePathIndex.fromCandidates(['src/main.ts', 'README.md', 'src/test.ts']);
  assertEquals(index.completePath('README'), {
    kind: 'inserted',
    text: '"./README.md"',
    replacement: '"./README.md"',
  });
  assertEquals(index.completePath('src/'), { kind: 'ambiguous', count: 2 });
  assertEquals(index.completePath('../'), { kind: 'none' });
  assertEquals(index.completePath('/tmp'), { kind: 'none' });
  assertEquals(index.completePath('none'), { kind: 'none' });
});

Deno.test('path escaping neutralizes controls and bidi without revealing raw controls', () => {
  const escaped = escapeFileReference('a"b\\c\n\u202e');
  assertEquals(escaped, 'a\\"b\\\\c\\u{000A}\\u{202E}');
  assert(!escaped.includes('\n'));
  const incomplete = WorkspacePathIndex.incomplete('/workspace');
  assertEquals(incomplete.completePath('src'), { kind: 'incomplete' });
});

Deno.test('workspace traversal excludes root private trees and never follows symlinks', async () => {
  const listings = new Map<string, FileReferenceEntry[]>([
    ['/workspace', [
      { name: '.git', isDirectory: true },
      { name: '_refs', isDirectory: true },
      { name: 'README.md', isFile: true },
      { name: 'link', isSymlink: true },
      { name: 'src', isDirectory: true },
    ]],
    ['/workspace/src', [{ name: 'main.ts', isFile: true }]],
  ]);
  const stats = new Map<string, FileReferenceStat>([
    ['/workspace', { isDirectory: true, isSymlink: false, dev: 1, ino: 1 }],
    ['/workspace/README.md', { isFile: true, isSymlink: false }],
    ['/workspace/link', { isDirectory: true, isSymlink: true }],
    ['/workspace/src', { isDirectory: true, isSymlink: false }],
    ['/workspace/src/main.ts', { isFile: true, isSymlink: false }],
  ]);
  const lstatPaths: string[] = [];
  const readDirPaths: string[] = [];
  const filesystem: FileReferenceFs = {
    realPath: (path) => path,
    readDir: (path) => {
      readDirPaths.push(path);
      return listings.get(path) ?? [];
    },
    lstat: (path) => {
      lstatPaths.push(path);
      const result = stats.get(path);
      if (result === undefined) throw new Error('missing fixture stat');
      return result;
    },
  };
  const index = await buildWorkspacePathIndex('/workspace', filesystem);
  assert(index.complete);
  assertEquals(index.candidates.map((candidate) => candidate.path), ['README.md', 'src/main.ts']);
  assert(!lstatPaths.some((path) => path.includes('/.git') || path.includes('/_refs')));
  assert(!readDirPaths.some((path) => path.includes('/.git') || path.includes('/_refs')));
  assert(lstatPaths.includes('/workspace/link'));
});

Deno.test('workspace root identity changes discard the whole index', async () => {
  let calls = 0;
  const filesystem: FileReferenceFs = {
    realPath: () => calls++ === 0 ? '/workspace' : '/replaced',
    readDir: () => [{ name: 'main.ts', isFile: true }],
    lstat: () => ({ isDirectory: true, isSymlink: false, dev: 1, ino: 1 }),
  };
  const index = await buildWorkspacePathIndex('/workspace', filesystem);
  assertEquals(index.complete, false);
  assertEquals(index.candidates, []);
});

Deno.test('workspace traversal stops a much larger iterator at the remaining visited bound', async () => {
  let yielded = 0;
  const rootStat: FileReferenceStat = { isDirectory: true, isSymlink: false, dev: 7, ino: 9 };
  const filesystem: FileReferenceFs = {
    realPath: (path) => path,
    readDir: (path) => {
      if (path !== '/workspace') return [];
      return (async function* () {
        for (let index = 0; index < FILE_REFERENCE_MAX_VISITED * 4; index += 1) {
          yielded += 1;
          yield { name: `file-${index}.txt`, isFile: true };
        }
      })();
    },
    lstat: (path) => path === '/workspace' ? rootStat : { isFile: true, isSymlink: false },
  };
  const index = await buildWorkspacePathIndex('/workspace', filesystem);
  assertEquals(index.complete, false);
  assertEquals(index.candidates, []);
  assertEquals(yielded, FILE_REFERENCE_MAX_VISITED + 1);
});

Deno.test('nested directory identity or type replacement discards the whole index', async () => {
  for (
    const replacement of [
      { isDirectory: true, isSymlink: false, dev: 2, ino: 3 },
      { isDirectory: false, isFile: true, isSymlink: false, dev: 2, ino: 2 },
    ] satisfies readonly FileReferenceStat[]
  ) {
    let nestedCalls = 0;
    const filesystem: FileReferenceFs = {
      realPath: (path) => path,
      readDir: (path) =>
        path === '/workspace'
          ? [{ name: 'src', isDirectory: true }]
          : [{ name: 'main.ts', isFile: true }],
      lstat: (path) => {
        if (path === '/workspace') {
          return { isDirectory: true, isSymlink: false, dev: 1, ino: 1 };
        }
        if (path === '/workspace/src') {
          nestedCalls += 1;
          return nestedCalls === 1
            ? { isDirectory: true, isSymlink: false, dev: 2, ino: 2 }
            : replacement;
        }
        return { isFile: true, isSymlink: false };
      },
    };
    const index = await buildWorkspacePathIndex('/workspace', filesystem);
    assertEquals(index.complete, false);
    assertEquals(index.candidates, []);
  }
});
