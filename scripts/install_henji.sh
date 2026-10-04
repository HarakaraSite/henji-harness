#!/bin/bash
set -euo pipefail

package_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
binary_dir=${HOME}/.local/bin
config_root=${XDG_CONFIG_HOME:-${HOME}/.config}/henji-harness
replace_tools=false
while (($#)); do
  case "$1" in
    --bin-dir) binary_dir=$2; shift 2 ;;
    --config-root) config_root=$2; shift 2 ;;
    --replace-tools) replace_tools=true; shift ;;
    --help)
      printf '%s\n' 'Usage: install.sh [--bin-dir DIR] [--config-root DIR] [--replace-tools]' \
        'Installs the binary and registers search, web_search and web_fetch.' \
        'Existing tool folders are retained; --replace-tools copies the packaged files over them.'
      exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
mkdir -p -- "$binary_dir" "$config_root/tools"
binary_dir=$(cd -- "$binary_dir" && pwd)
config_root=$(cd -- "$config_root" && pwd)
# Runtime path resolution expects the base of the config directory.
config_base=$(dirname -- "$config_root")
if [[ $(basename -- "$config_root") != henji-harness ]]; then
  printf '%s\n' '--config-root must name a henji-harness directory' >&2
  exit 2
fi
installed_binary=$binary_dir/henji
staged_binary=$(mktemp "$binary_dir/.henji-install-XXXXXXXX")
cp -- "$package_root/henji" "$staged_binary"
chmod 755 -- "$staged_binary"
mv -f -- "$staged_binary" "$installed_binary"
for name in search web_search web_fetch; do
  target=$config_root/tools/$name
  if [[ ! -d $target ]] || $replace_tools; then
    mkdir -p -- "$target"
    cp -R -- "$package_root/tools/$name/." "$target/"
  fi
  XDG_CONFIG_HOME=$config_base "$installed_binary" tool activate --name "$name" --folder "$target"
done
printf 'Installed %s; external tools: %s\n' "$installed_binary" "$config_root/tools"
printf '%s\n' 'Start a new Core to use the installed binary and tool configuration.'
