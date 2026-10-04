# Henji package and external tools

The package contains the `henji` executable and three editable tool folders:

- `search`: local file-name and content search, plus occurrence counts, using rg or grep.
- `web_search`: Exa search, using the Henji credential-resolving request API.
- `web_fetch`: HTTP text retrieval and original-byte downloads.

These implementations are external TypeScript source, not embedded in the executable. They import
the executable's `@henji/tool` API and their own local modules. Deno does not need to be installed
separately on the target machine. Local content search needs rg or grep on PATH; it prefers rg.

Use `search` with `mode: "count"` for the total number of occurrences as `matchCount`. It uses the
same path, glob, pattern, literal/regex and case options, and covers the full selected scope.
`content` returns matching lines: its `total` is a line count, not an occurrence count. Offset and
limit apply to record modes; they do not affect count. Regex syntax follows the selected backend; rg
counts zero-width regex matches, while grep counts non-empty matches.

After extracting the archive, run:

```sh
./install.sh
```

By default this installs the executable under `$HOME/.local/bin` and tool folders under
`${XDG_CONFIG_HOME:-$HOME/.config}/henji-harness/tools`. The installer registers the three folders
in `tools.json`. The default and generic Agent configurations declare these tools. For a named Agent
with an explicit `tools` array, add the tool names you want to use.

To choose installation directories:

```sh
./install.sh --bin-dir /path/to/bin --config-root /path/to/config/henji-harness
```

The installer retains existing tool folders so edits remain usable. To replace their files with the
package's versions, run `./install.sh --replace-tools`. Other tool mappings are retained. Existing
Agent settings, credentials, Sessions and history are not replaced by installation. Running Cores
keep their loaded runtime and tool functions; start a new Core for the new binary. After editing
tool source, newly started Workers load it. There is no file watcher or `/reload`.

Exa uses the existing `exa-api-key` credential registration and `/login` flow. Key values and
Authorization headers remain in Henji's request dispatcher and are not passed to the tool factory.

To register a tool manually, select its folder and declare it in the Agent's `tools` array:

```sh
henji tool activate --name search --folder /path/to/tools/search
henji tool inspect --name search
```

The repository source lives under `external-tools/`. Build the executable with the official build
script, then create a distribution package:

```sh
deno task --config deno.v0.json henji:compile
deno task --config deno.v0.json henji:package
```

Packaging creates a directory and a `.tar.gz` archive under `dist/`, with a manifest identifying the
executable build and the shipped tool files. It does not install, publish or activate them.
