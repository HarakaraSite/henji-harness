#!/bin/bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
binary_dir=${HOME}/.local/bin
config_root=${XDG_CONFIG_HOME:-${HOME}/.config}/henji-harness
replace_tools=false
replace_hooks=false
while (($#)); do
  case "$1" in
    --bin-dir) binary_dir=$2; shift 2 ;;
    --config-root) config_root=$2; shift 2 ;;
    --replace-tools) replace_tools=true; shift ;;
    --replace-hooks) replace_hooks=true; shift ;;
    --help)
      printf '%s\n' 'Usage: install.sh [--bin-dir DIR] [--config-root DIR] [--replace-tools] [--replace-hooks]' \
        'Installs the binary, registers search, git_inspect, web_search and web_fetch, and installs runtime-start-time.' \
        'Existing external folders are retained; the corresponding --replace option copies packaged files over them.'
      exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
mkdir -p -- "$binary_dir" "$config_root/tools" "$config_root/hooks"
binary_dir=$(cd -- "$binary_dir" && pwd)
config_root=$(cd -- "$config_root" && pwd)
# Runtime path resolution expects the base of the config directory.
config_base=$(dirname -- "$config_root")
if [[ $(basename -- "$config_root") != henji-harness ]]; then
  printf '%s\n' '--config-root must name a henji-harness directory' >&2
  exit 2
fi
installed_binary=$binary_dir/hjh
staged_binary=$(mktemp "$binary_dir/.hjh-install-XXXXXXXX")
cp -- "$package_root/hjh" "$staged_binary"
chmod 755 -- "$staged_binary"
mv -f -- "$staged_binary" "$installed_binary"
for name in search git_inspect web_search web_fetch; do
  target=$config_root/tools/$name
  if [[ ! -d $target ]] || $replace_tools; then
    mkdir -p -- "$target"
    cp -R -- "$package_root/tools/$name/." "$target/"
  fi
  XDG_CONFIG_HOME=$config_base "$installed_binary" tool activate --name "$name" --folder "$target"
done
hook_target=$config_root/hooks/runtime-start-time
if [[ ! -d $hook_target ]] || $replace_hooks; then
  mkdir -p -- "$hook_target"
  cp -R -- "$package_root/hooks/runtime-start-time/." "$hook_target/"
fi
if [[ ! -e $config_root/hooks.json ]]; then
  cat >"$config_root/hooks.json" <<'JSON'
{
  "schemaVersion": 1,
  "default": ["runtime-start-time"],
  "hooks": {
    "runtime-start-time": "hooks/runtime-start-time/index.ts"
  }
}
JSON
fi
printf 'Installed %s; external tools: %s; hooks: %s\n' \
  "$installed_binary" "$config_root/tools" "$config_root/hooks"
printf '%s\n' 'Start a new Core to use the installed binary and tool configuration.'
