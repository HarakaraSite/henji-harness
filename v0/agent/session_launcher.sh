#!/bin/sh
# The launcher performs the side-effect-free argv/state-root preflight required by the TUI.
set -eu

fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"invalid_invocation","message":"invalid invocation"}}' >&2
  exit 1
}

startup_fail() {
  printf '%s\n' '{"ok":false,"error":{"code":"startup_failure","message":"startup failure"}}' >&2
  exit 1
}

agent=''
mode='new'
session_id=''
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --agent)
        [ "$agent" = '' ] || fail
        [ "$#" -ge 2 ] || fail
        agent=$2
        [ "$agent" = 'default' ] || [ "$agent" = 'planner' ] || fail
        shift 2
        ;;
      --continue)
        [ "$mode" = 'new' ] || fail
        mode='continue'
        shift
        ;;
      --no-session)
        [ "$mode" = 'new' ] || fail
        mode='none'
        shift
        ;;
      --session)
        [ "$mode" = 'new' ] || fail
        [ "$#" -ge 2 ] || fail
        session_id=$2
        case "$session_id" in
          ????????-????-4???-[89ab]???-????????????) ;;
          *) fail ;;
        esac
        case "$session_id" in *[!0-9a-f-]*) fail ;; esac
        mode='session'
        shift 2
        ;;
      *) fail ;;
    esac
  done
}
parse_args "$@"

# The caller's physical directory is the workspace authority. Never change it while launching the
# child: work tools, session records, and their permission root must describe this directory.
workspace=$(pwd -P 2>/dev/null) || startup_fail
[ -d "$workspace" ] || startup_fail
case "$workspace" in
  /*) ;;
  *) startup_fail ;;
esac
newline='
'
carriage_return=$(printf '\r')
case "$workspace" in
  *,*|*"$newline"*|*"$carriage_return"*) startup_fail ;;
esac

if [ "$mode" = 'none' ]; then
  state_root=''
else
  if [ "${XDG_STATE_HOME+x}" = x ]; then
    case "$XDG_STATE_HOME" in
      *[![:space:]]*) state_base=$XDG_STATE_HOME ;;
      *) [ "${HOME+x}" = x ] && [ "$HOME" != '' ] || startup_fail; state_base=$HOME/.local/state ;;
    esac
  else
    [ "${HOME+x}" = x ] && [ "$HOME" != '' ] || startup_fail
    state_base=$HOME/.local/state
  fi
  case "$state_base" in
    /*) ;;
    *) startup_fail ;;
  esac
  newline='
'
  carriage_return=$(printf '\r')
  case "$state_base" in
    *,*|*"$newline"*|*"$carriage_return"*) startup_fail ;;
  esac
  state_root=$state_base/henji-harness
  # Comma is rejected because Deno's comma-separated permission path list cannot represent it.
  case "$state_root" in
    *,*|*"$newline"*|*"$carriage_return"*) startup_fail ;;
  esac
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
deno=$(command -v deno 2>/dev/null || true)
case "$deno" in
  /*) [ -f "$deno" ] && [ -x "$deno" ] || startup_fail ;;
  *) startup_fail ;;
esac
newline='
'
version=$("$deno" --version 2>/dev/null) || startup_fail
case "$version" in
  "deno 2.9.4"|"deno 2.9.4 "*) ;;
  *) startup_fail ;;
esac
if [ "$mode" = 'none' ]; then
  exec "$deno" run --no-prompt --no-remote \
    --allow-net=openrouter.ai --allow-sys=uid \
    --allow-read="$repo_root" --allow-read="$workspace" \
    --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key \
    --allow-write="$workspace" --allow-run=/bin/bash \
    "$script_dir/tui_cli.ts" "$@"
else
  HENJI_SESSION_STATE_ROOT="$state_root" exec "$deno" run --no-prompt --no-remote \
    --allow-env=HENJI_SESSION_STATE_ROOT --allow-net=openrouter.ai --allow-sys=uid \
    --allow-read="$repo_root" --allow-read="$workspace" \
    --allow-read=/home/masat.guest/.config/henji-harness/openrouter-api-key \
    --allow-read="$state_root" --allow-write="$workspace" --allow-write="$state_root" \
    --allow-run=/bin/bash "$script_dir/tui_cli.ts" "$@"
fi
