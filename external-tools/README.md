# Henji package and external tools

The package contains the `hjh` executable, seven editable tool folders, and an editable runtime
hook:

- `ls`: direct directory entries or a nested JSON tree.
- `find`: filename/path discovery using installed fd, or GNU find when fd is absent.
- `grep`: content search using installed rg, or GNU grep when rg is absent.
- `wc`: streamed line, word, and raw byte counts for explicit files.
- `git_inspect`: read-only workspace Git status, diff, log, and show.
- `web_search`: Exa search through the Henji credential-resolving request API.
- `web_fetch`: HTTP text retrieval and original-byte downloads.
- `runtime-start-time` hook: Worker start time, timezone, and UTC offset in shared Agent context.

Tool schemas, descriptions, factories, and executors are editable external TypeScript source,
importing `@henji/tool`; hooks import `@henji/hooks`. Deno need not be separately installed. Native
fd/rg are neither bundled nor downloaded: each Worker selects installed commands from the tool
settings PATH, then retains that backend and executable. Startup tool descriptions and result JSON
identify it. `git_inspect` requires git on its configured PATH.

| Tool | Example                                                      | Result and bounds                                                                                            |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| ls   | `{"path":"src","tree":true,"depth":3}`                       | `entries` with name/path/type/children; count limit defaults to 100 across the tree                          |
| find | `{"path":"src","pattern":"*.ts"}`                            | Native glob paths in `records`; stops after 100 allowed matches by default                                   |
| grep | `{"pattern":"TODO","glob":["*.ts","!vendor/**"],"limit":20}` | Matching lines with separately marked context; exact full-scope `total` even when return records are limited |
| wc   | `{"files":["README.md","src/main.ts"]}`                      | Per-file records plus complete `totals` and returned-page `pageTotals`                                       |

`ls` defaults to direct children. Tree mode defaults to depth 3 with the selected directory at
depth 0. Empty directories have `children:[]`; `childrenOmitted` and `omitted` distinguish
depth/count/byte omissions from an empty directory. Explicit directory aliases are allowed; child
symlink directories are listed without recursive traversal.

`find` uses native fd `--glob` or GNU find `-name`/`-path`, without a compatibility matcher.
Patterns without `/` match basenames at any depth. `type` defaults to any; file/directory selection
is available. `includeIgnored` defaults to false. fd honors native ignore rules, including
`.gitignore`; GNU find reports `ignoreApplied:false`. Native fd exclusion globs use `exclude`; GNU
find returns an error when that unsupported option is requested. Stopped searches have
`searchCompleted:false`, a `truncationReason`, and no exact `total`. Increase limit or narrow the
query if needed.

`grep` defaults to regex, case-sensitive, matching lines, context 0, and return limit 100. Set
`patternKind:"literal"`, `caseSensitive:false`, `output:"files"`, or `context` when appropriate. rg
`glob` is an ordered array of native `-g` patterns including `!` exclusions. Hidden files are
included, while ignore rules apply unless `includeIgnored:true`. GNU grep uses extended regex and
native positive filename selection; `!` exclusions are errors and `ignoreApplied` is false. Backend
syntax and result differences are accepted and identified; native syntax errors are tool errors and
zero matches are normal results. Return limits and the 1 MiB JSON budget never stop the full grep
scan: `total` counts matching lines or unique matching files, excluding context records.

`wc` requires `files` as an array, including for one file; it does not expand directories. Files are
streamed. Lines count LF bytes, words are runs separated by Unicode White_Space, and bytes count raw
bytes. `offset` defaults to 0 and `limit` to 100 for per-file records. `totals` always covers the
whole files array, even if pagination or the 1 MiB result budget omits records; `pageTotals` covers
returned records. All four tools retain the common file access policy (default allow `/`, common
deny). The new-execution `search` tool is removed; saved historical search previews remain readable.

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
the seven tools in `tools.json` and creates `hooks.json` with `runtime-start-time` as the shared
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
hjh tool activate --name find --folder /path/to/tools/find
hjh tool inspect --name find
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
