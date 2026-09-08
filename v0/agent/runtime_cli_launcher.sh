#!/bin/sh
# Resolve the physical workspace and durable diagnostic root before starting the headless Host.
set -eu
umask 077

startup_fail() {
  printf '%s\n' '{"ok":false,"outcome":"contract_failure","stopReason":"contract_failure","steps":0,"toolCallCount":0,"toolResultCount":0,"requestCount":0,"error":{"code":"agent_failure","message":"agent run failed"}}' >&2
  exit 1
}

workspace=$(pwd -P 2>/dev/null) || startup_fail
[ -d "$workspace" ] || startup_fail
case "$workspace" in /*) ;; *) startup_fail ;; esac
newline='
'
carriage_return=$(printf '\r')
case "$workspace" in *,*|*"$newline"*|*"$carriage_return"*) startup_fail ;; esac

if [ "${XDG_STATE_HOME+x}" = x ]; then
  case "$XDG_STATE_HOME" in
    *[![:space:]]*) state_base=$XDG_STATE_HOME ;;
    *) [ "${HOME+x}" = x ] && [ "$HOME" != '' ] || startup_fail; state_base=$HOME/.local/state ;;
  esac
else
  [ "${HOME+x}" = x ] && [ "$HOME" != '' ] || startup_fail
  state_base=$HOME/.local/state
fi
case "$state_base" in /*) ;; *) startup_fail ;; esac
case "$state_base" in *,*|*"$newline"*|*"$carriage_return"*) startup_fail ;; esac
state_root=$state_base/henji-harness

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
case "$deno" in /*) [ -f "$deno" ] && [ -x "$deno" ] || startup_fail ;; *) startup_fail ;; esac
version=$("$deno" --version 2>/dev/null) || startup_fail
case "$version" in "deno 2.9.4"|"deno 2.9.4 "*) ;; *) startup_fail ;; esac

HENJI_SESSION_STATE_ROOT="$state_root" exec "$deno" run --no-prompt --no-remote \
  --allow-env=HENJI_SESSION_STATE_ROOT --allow-net=openrouter.ai --allow-sys=uid \
  --allow-read="$repo_root" --allow-read="$workspace" \
  --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key \
  --allow-read="$state_root" --allow-read=/tmp \
  --allow-write="$workspace" --allow-write="$state_root" --allow-write=/tmp \
  --allow-run=/bin/bash --config "$repo_root/deno.v0.json" \
  "$script_dir/cli/runtime_cli.ts" "$@"
