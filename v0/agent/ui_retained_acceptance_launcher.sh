#!/bin/sh
# Launch the provider-free retained UI acceptance from any working directory.
set -eu

fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}' >&2
  exit 1
}

startup_fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"startup_failure","message":"startup failure"}}' >&2
  exit 1
}

[ "$#" -eq 0 ] || fail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || startup_fail
repo_root=$(CDPATH= cd -- "$script_dir/../.." 2>/dev/null && pwd) || startup_fail
deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno

if [ ! -f "$deno" ] || [ ! -x "$deno" ]; then
  startup_fail
fi
version=$("$deno" --version 2>/dev/null) || startup_fail
case "$version" in
  "deno 2.9.4"|"deno 2.9.4 "*) ;;
  *) startup_fail ;;
esac

cd "$repo_root" || startup_fail
exec "$deno" run --no-prompt --no-remote \
  "$repo_root/tests/v0/fixtures/detached_ui_interactive_acceptance.ts"
