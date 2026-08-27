#!/bin/sh
set -eu

fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}' >&2
  exit 1
}

session_fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"session_io_failure","message":"session I/O failure"}}' >&2
  exit 1
}

if [ "$#" -eq 1 ] && [ "$1" = 'list' ]; then
  :
elif [ "$#" -eq 4 ] && [ "$1" = 'delete' ]; then
  [ "$2" = '--session' ] || fail
    [ "$4" = '--yes' ] || fail
    case "$3" in
      ????????-????-4???-[89ab]???-????????????) ;;
      *) fail ;;
    esac
    case "$3" in *[!0-9a-f-]*) fail ;; esac
else
  fail
fi

if [ "${XDG_STATE_HOME+x}" = x ]; then
  case "$XDG_STATE_HOME" in
    *[![:space:]]*) state_base=$XDG_STATE_HOME ;;
    *) [ "${HOME+x}" = x ] && [ "$HOME" != '' ] || session_fail; state_base=$HOME/.local/state ;;
  esac
else
  [ "${HOME+x}" = x ] && [ "$HOME" != '' ] || session_fail
  state_base=$HOME/.local/state
fi
case "$state_base" in /*) ;; *) session_fail ;; esac
newline='
'
carriage_return=$(printf '\r')
case "$state_base" in *,*|*"$newline"*|*"$carriage_return"*) session_fail ;; esac
state_root=$state_base/henji-harness
case "$state_root" in *,*|*"$newline"*|*"$carriage_return"*) session_fail ;; esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
deno=/home/masat.guest/src/abyssaeon/.tools/deno/2.9.4/deno
HENJI_SESSION_STATE_ROOT="$state_root" exec "$deno" run --no-prompt --no-remote \
  --allow-env=HENJI_SESSION_STATE_ROOT --allow-read="$repo_root" --allow-read="$state_root" \
  --allow-write="$state_root" "$script_dir/session_cli.ts" "$@"
