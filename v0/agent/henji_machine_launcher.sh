#!/bin/sh
# Canonical repository-owned launcher for the installed `henji` entry point.
# It resolves the fixed repository independently of its installed wrapper location and deliberately
# preserves caller cwd.
set -eu

startup_fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"startup_failure","message":"startup failure"}}' >&2
  exit 1
}

repo_root=/home/masat.guest/src/henji-harness
deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
config=$repo_root/deno.v0.json
session_launcher=$repo_root/v0/agent/session_launcher.sh
diagnostic_launcher=$repo_root/v0/agent/failure_diagnostic_cli_launcher.sh

# Keep these checks fixed and quiet: neither paths, versions, nor child diagnostics belong in a
# launcher failure. The session launcher performs the TTY and invocation checks after this gate.
[ -f "$deno" ] && [ ! -L "$deno" ] && [ -x "$deno" ] || startup_fail
[ -f "$config" ] && [ ! -L "$config" ] || startup_fail
version=$("$deno" --version 2>/dev/null) || startup_fail
case "$version" in
  "deno 2.9.4"|"deno 2.9.4 "*) ;;
  *) startup_fail ;;
esac

if [ "${1-}" = 'diagnostics' ]; then
  [ -f "$diagnostic_launcher" ] && [ ! -L "$diagnostic_launcher" ] &&
    [ -x "$diagnostic_launcher" ] || startup_fail
  shift
  exec "$diagnostic_launcher" "$@"
fi

[ -f "$session_launcher" ] && [ ! -L "$session_launcher" ] && [ -x "$session_launcher" ] || startup_fail

deno_dir=${deno%/*}
PATH=$deno_dir${PATH:+:$PATH}
export PATH
exec "$session_launcher" "$@"
