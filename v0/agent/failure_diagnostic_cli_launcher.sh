#!/bin/sh
# Read-only diagnostic readback and separately-authorized exact-record deletion launcher.
set -eu

fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}' >&2
  exit 1
}

startup_fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"startup_failure","message":"startup failure"}}' >&2
  exit 1
}

diagnostic_fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"diagnostic_io_failure","message":"diagnostic I/O failure"}}' >&2
  exit 1
}

mode=read
case "${1-}" in
  list|latest)
    [ "$#" -eq 1 ] || fail
    ;;
  executions)
    case "${2-}" in
      list) [ "$#" -eq 2 ] || fail ;;
      show)
        [ "$#" -eq 4 ] || fail
        [ "$3" = '--id' ] || fail
        case "$4" in
          ????????-????-4???-[89ab]???-????????????) ;;
          *) fail ;;
        esac
        case "$4" in *[!0-9a-f-]*) fail ;; esac
        ;;
      *) fail ;;
    esac
    ;;
  show)
    [ "$#" -eq 3 ] || fail
    [ "$2" = '--id' ] || fail
    case "$3" in
      ????????-????-4???-[89ab]???-????????????) ;;
      *) fail ;;
    esac
    case "$3" in *[!0-9a-f-]*) fail ;; esac
    ;;
  evidence)
    case "${2-}" in
      list) [ "$#" -eq 2 ] || fail ;;
      show)
        [ "$#" -eq 4 ] || fail
        [ "$3" = '--id' ] || fail
        case "$4" in
          ????????-????-4???-[89ab]???-????????????) ;;
          *) fail ;;
        esac
        case "$4" in *[!0-9a-f-]*) fail ;; esac
        ;;
      *) fail ;;
    esac
    ;;
  delete)
    mode=delete
    [ "$#" -eq 4 ] || fail
    [ "$2" = '--id' ] || fail
    [ "$4" = '--yes' ] || fail
    case "$3" in
      ????????-????-4???-[89ab]???-????????????) ;;
      *) fail ;;
    esac
    case "$3" in *[!0-9a-f-]*) fail ;; esac
    ;;
  *) fail ;;
esac

workspace=$(pwd -P 2>/dev/null) || diagnostic_fail
[ -d "$workspace" ] || diagnostic_fail
case "$workspace" in
  /*) ;;
  *) diagnostic_fail ;;
esac
newline='
'
carriage_return=$(printf '\r')
case "$workspace" in
  *,*|*"$newline"*|*"$carriage_return"*) diagnostic_fail ;;
esac

if [ "${HENJI_SESSION_STATE_ROOT+x}" = x ]; then
  state_root=$HENJI_SESSION_STATE_ROOT
else
  if [ "${XDG_STATE_HOME+x}" = x ] && [ "$XDG_STATE_HOME" != '' ]; then
    state_root=$XDG_STATE_HOME/henji-harness
  elif [ "${HOME+x}" = x ] && [ "$HOME" != '' ]; then
    state_root=$HOME/.local/state/henji-harness
  else
    diagnostic_fail
  fi
fi
case "$state_root" in
  /*) ;;
  *) diagnostic_fail ;;
esac
case "$state_root" in
  *,*|*"$newline"*|*"$carriage_return"*) diagnostic_fail ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || startup_fail
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd) || startup_fail
deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
[ -f "$deno" ] && [ ! -L "$deno" ] && [ -x "$deno" ] || startup_fail
version=$("$deno" --version 2>/dev/null) || startup_fail
case "$version" in
  "deno 2.9.4"|"deno 2.9.4 "*) ;;
  *) startup_fail ;;
esac

if [ "$mode" = 'delete' ]; then
  digest=$(printf '%s' "$workspace" | sha256sum | awk '{print $1}') || diagnostic_fail
  case "$digest" in
    ????????????????????????????????????????????????????????????????) ;;
    *) diagnostic_fail ;;
  esac
  case "$digest" in *[!0-9a-f]*) diagnostic_fail ;; esac
  diagnostics_dir=$state_root/$digest/diagnostics
  locks_dir=$state_root/$digest/locks
  lock_path=$state_root/$digest/locks/.diagnostics.lock
  selected_path=$diagnostics_dir/$3.json
  [ -d "$diagnostics_dir" ] || diagnostic_fail
  [ -f "$lock_path" ] || diagnostic_fail
  [ -f "$selected_path" ] || diagnostic_fail
  HENJI_SESSION_STATE_ROOT="$state_root" exec "$deno" run --no-prompt --no-remote \
    --allow-env=HENJI_SESSION_STATE_ROOT --allow-sys=uid \
    --allow-read="$repo_root" --allow-read="$workspace" \
    --allow-read="$diagnostics_dir" --allow-read="$locks_dir" --allow-read="$lock_path" \
    --allow-write="$selected_path" --allow-write="$lock_path" \
    "$script_dir/failure_diagnostic_cli.ts" "$@"
fi

# Readback has no write, network, run, credential, or workspace-write capability.
HENJI_SESSION_STATE_ROOT="$state_root" exec "$deno" run --no-prompt --no-remote \
  --allow-env=HENJI_SESSION_STATE_ROOT --allow-sys=uid \
  --allow-read="$repo_root" --allow-read="$workspace" --allow-read="$state_root" \
  "$script_dir/failure_diagnostic_cli.ts" "$@"
