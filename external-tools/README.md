# Henji package and external tools

The package contains the `hjh` executable, four editable tool folders, and an editable runtime hook:

- `search`: workspace directory listings (`ls`), recursive file lists (`find`, `rg --files`), text
  search (`grep`, `rg`), occurrence counts, and per-file line/word/byte counts (`wc`), using rg or
  grep for text search where needed.
- `git_inspect`: read-only git inspection of the workspace repository (`status`, `diff`, `log`,
  `show`) with fixed flags and paged output; it never writes to the repository, index, or worktree.
- `web_search`: Exa search, using the Henji credential-resolving request API.
- `web_fetch`: HTTP text retrieval and original-byte downloads.
- `runtime-start-time`: adds the Worker start time, timezone, and UTC offset to shared Agent
  context.

These implementations are external TypeScript source, not embedded in the executable. Tools import
the executable's `@henji/tool` API and hooks import its `@henji/hooks` API. Deno does not need to be
installed separately on the target machine. Local content search needs rg or grep on PATH; it
prefers rg. `git_inspect` needs git on its configured PATH and reports a distinct error when git or
the repository is unavailable.

Choose `search` mode by operation:

| Operation                                                       | Mode / result         |
| --------------------------------------------------------------- | --------------------- |
| Direct directory children, type, size, modification time (`ls`) | `entries`             |
| Recursive file paths (`find`, `rg --files`) and file count      | `paths`, `total`      |
| Files containing a pattern (`rg -l`) and matching file count    | `files`, `total`      |
| Matching lines (`grep`, `rg`)                                   | `content`             |
| Pattern occurrences                                             | `count`, `matchCount` |
| Per-file line, word, and byte counts (`wc`)                     | `stats`               |

Use `search` with `mode: "stats"` and a file path, or a directory path plus optional `glob`. It
returns paged `records` containing `path`, `lines`, `words`, and `bytes`; `total` is the number of
selected files. No pattern is required. For example:

```json
{ "mode": "stats", "path": "README.md" }
```

```json
{ "mode": "stats", "path": "src", "glob": "*.ts", "limit": 20 }
```

Files are streamed without a shell process. Lines count LF newline bytes, so a trailing partial line
is not counted, matching `wc -l`. Words are nonempty UTF-8 sequences separated by Unicode
`White_Space`, independent of locale; malformed UTF-8 uses replacement characters. This defines word
counts explicitly rather than reproducing every locale-specific GNU `wc` rule. Bytes count all bytes
read. Unlike content search, stats also includes database and binary files. The existing file
traversal, glob, and paging rules apply.

Use `search` with `mode: "count"` for the total number of occurrences as `matchCount`. It uses the
same path, glob, pattern, literal/regex and case options, and covers the full selected scope.
`content` returns matching lines: its `total` is a line count, not an occurrence count. Offset and
limit apply to record modes; they do not affect count. Regex syntax follows the selected backend; rg
counts zero-width regex matches, while grep counts non-empty matches.

Use `search` with `mode: "entries"` for a directory listing that includes directories as well as
files: each record has `path`, `type` (`file`, `directory`, `symlink`, or `other`), `bytes` for
files, and `modifiedAt`. `depth` (default 1) selects how many directory levels below `path` are
listed, and `glob` filters the listed paths; symlinked directories are reported but not followed.

Use `git_inspect` with `op: "status" | "diff" | "log" | "show"`. `paths` limits the operation to
workspace-relative paths, `rev` accepts `HEAD`, `HEAD~N`, or a commit hash, and `staged`/`stat`/
`context` shape the diff. Output is paged with `offset`/`limit`: for `log` they select commits,
otherwise output lines. Unknown fields and unsupported operations are rejected, so the tool cannot
run arbitrary git commands or change repository state.

Use `{"op":"diff"}` for `git diff`, `{"op":"diff","staged":true}` for `git diff --cached`, or
`{"op":"diff","stat":true}` for `git diff --stat`. Scope an operation with `paths` and page long
output with `offset`/`limit` instead of shell filters.

After extracting the archive, run:

```sh
./install.sh
```

By default this installs the executable under `$HOME/.local/bin`, tool folders under
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/tools`, and the hook under
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/hooks/runtime-start-time`. The installer registers
the four tools in `tools.json` and creates `hooks.json` with `runtime-start-time` as the shared
default. The default and generic Agent configurations declare the tools. For a named Agent with an
explicit `tools` array, add the tool names you want to use.

To choose installation directories:

```sh
./install.sh --bin-dir /path/to/bin --config-root /path/to/config/henji-harness
```

The installer retains existing tool and hook folders, and keeps an existing `hooks.json`, so edits
and custom selections remain usable. Run `./install.sh --replace-tools` or
`./install.sh --replace-hooks` to copy the corresponding packaged source files over the installed
folders. Replacing hook files does not change `hooks.json`. Existing Agent settings, credentials,
Sessions and history are not replaced by installation. Running Workers keep their loaded runtime;
start a new Worker to load edited hook source, and a new Core to use the new binary. There is no
file watcher or `/reload`.

## Runtime hooks

`hooks.json` at the config root defines hook path mappings and the default ordered selection:

```json
{
  "schemaVersion": 1,
  "default": ["runtime-start-time"],
  "hooks": {
    "runtime-start-time": "hooks/runtime-start-time/index.ts"
  }
}
```

The installed hook records a Worker start time with its local timezone and UTC offset in common
context. This describes when that Worker began; later turns on the same Worker use the same value.

An Agent JSON can omit `hooks` to use `hooks.json` defaults, set an ordered list to replace the
defaults, or set `"hooks": []` to disable external hooks for that Agent. For example:

```json
{ "name": "reviewer", "hooks": ["runtime-start-time"] }
```

To add a custom hook, copy its TypeScript source beneath the config root, import the `HookHandlers`
type from `@henji/hooks`, add its entry path to `hooks.json`, and list its name in the common
defaults or an Agent's `hooks` array. The repository source for the default hook is under
`external-hooks/runtime-start-time/`; the package ships it under `hooks/runtime-start-time/`.

Exa uses the existing `exa-api-key` credential registration and `/login` flow. Key values and
Authorization headers remain in Henji's request dispatcher and are not passed to the tool factory.

To register a tool manually, select its folder and declare it in the Agent's `tools` array:

```sh
hjh tool activate --name search --folder /path/to/tools/search
hjh tool inspect --name search
```

The repository source lives under `external-tools/`. Build the executable with the official build
script, then create a distribution package:

```sh
deno task --config deno.v0.json hjh:compile
deno task --config deno.v0.json hjh:package
```

Packaging creates a directory and a `.tar.gz` archive under `dist/`, with a manifest identifying the
executable build and the shipped tool and hook files. It does not install, publish or activate them.

## Shared file access policy

Every `Tool` declares `fileAccess`: `none`, `read`, `read-write`, or `unmanaged`. This runtime
metadata is not sent to the model as a tool schema. web_search is `none`; bash is `unmanaged`.
write/edit include the reads required to perform their writes. Host authentication, history, and
tool-code loading are outside the scope of target-file operations.

The Worker loader reads `tool-paths.json` once and provides `ToolFactoryInput.pathPolicy` for the
selected tool name. Its `allowedPaths` and `deniedPaths` are immutable. Call
`await input.pathPolicy.resolve(path)` before accessing a target; it expands workspace-relative
paths and `~`, checks allow and deny, and resolves existing symlinks. An absent suffix is retained
for file creation. `allows(path)` supports skipping excluded paths during recursive enumeration. Use
`{ followSymlinks: false }` when the implementation rejects symlinks itself, as the bundled
read/write/edit tools do. A tool that follows links must check the actual destination as well.

Declare file access in the same returned Tool for both bundled and external implementations:

```ts
import type { ToolFactory } from '@henji/tool';

const factory: ToolFactory = (input) => ({
  name: 'note_reader',
  fileAccess: 'read',
  description: 'Read a note.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  async execute(args) {
    const path = await input.pathPolicy.resolve((args as { path: string }).path);
    return await Deno.readTextFile(path);
  },
});
export default factory;
```

File-access tools with no configured allow list default to the current workspace. Their API must be
used at each target-file operation; fileAccess is a declaration, not an OS sandbox around arbitrary
external TypeScript or subprocess code. The existing run_typescript deny audit continues to inspect
code text, while its allow roots are enforced by Deno permissions.
