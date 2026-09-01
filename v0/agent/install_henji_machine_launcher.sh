#!/bin/sh
# Fixed repository-owned check/install/rollback entry point for the machine launcher.
set -eu

failure() {
  printf '%s\n' '{"ok":false,"error":{"code":"startup_failure","message":"startup failure"}}' >&2
  exit 1
}

[ "$#" -eq 1 ] || failure
case "$1" in
  check|install|rollback) ;;
  *) failure ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || failure
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd) || failure
source=$repo_root/v0/agent/henji_machine_launcher.sh
target=/home/masat.guest/.local/bin/henji
backup=/home/masat.guest/.local/bin/henji.pre-step83-continuation
target_dir=/home/masat.guest/.local/bin
uid=$(id -u 2>/dev/null) || failure

entry_ok() {
  entry=$1
  [ -f "$entry" ] && [ ! -L "$entry" ] || return 1
  owner_mode=$(stat -c '%u:%a' -- "$entry" 2>/dev/null) || return 1
  [ "$owner_mode" = "$uid:755" ]
}

[ -d "$target_dir" ] && [ ! -L "$target_dir" ] || failure
entry_ok "$source" || failure

if [ "$1" = 'check' ]; then
  entry_ok "$target" || failure
  cmp -s -- "$source" "$target" || failure
  exit 0
fi

if [ "$1" = 'rollback' ]; then
  entry_ok "$backup" || failure
  entry_ok "$target" || failure

  # Preserve the currently installed candidate before the final atomic target replacement. A
  # failed copy/readback leaves the old target in place and never removes the fixed backup.
  umask 077
  recovery=$(mktemp "$target_dir/.henji.rollback-recovery.XXXXXX" 2>/dev/null) || failure
  remove_recovery=1
  if ! cp -- "$target" "$recovery" >/dev/null 2>&1 || ! chmod 0755 -- "$recovery" >/dev/null 2>&1 ||
    ! entry_ok "$recovery" || ! cmp -s -- "$target" "$recovery"; then
    rm -f -- "$recovery" >/dev/null 2>&1 || :
    failure
  fi
  recovery_name=$target_dir/henji.rollback-recovery
  [ ! -e "$recovery_name" ] && [ ! -L "$recovery_name" ] || {
    rm -f -- "$recovery" >/dev/null 2>&1 || :
    failure
  }
  mv -- "$recovery" "$recovery_name" >/dev/null 2>&1 || {
    rm -f -- "$recovery" >/dev/null 2>&1 || :
    failure
  }
  remove_recovery=0

  candidate=$(mktemp "$target_dir/.henji.rollback-candidate.XXXXXX" 2>/dev/null) || failure
  if ! cp -- "$backup" "$candidate" >/dev/null 2>&1 || ! chmod 0755 -- "$candidate" >/dev/null 2>&1 ||
    ! entry_ok "$candidate" || ! cmp -s -- "$backup" "$candidate"; then
    rm -f -- "$candidate" >/dev/null 2>&1 || :
    failure
  fi
  mv -- "$candidate" "$target" >/dev/null 2>&1 || {
    rm -f -- "$candidate" >/dev/null 2>&1 || :
    failure
  }
  entry_ok "$target" || failure
  cmp -s -- "$backup" "$target" || failure
  exit 0
fi

# Install is deliberately a two-phase operation. The old target is backed up completely before a
# candidate made from the canonical source is renamed over it. Existing backup bytes are sacred.
entry_ok "$target" || failure
[ ! -e "$backup" ] && [ ! -L "$backup" ] || failure
umask 077
backup_temp=$(mktemp "$target_dir/.henji.backup.XXXXXX" 2>/dev/null) || failure
if ! cp -- "$target" "$backup_temp" >/dev/null 2>&1 || ! chmod 0755 -- "$backup_temp" >/dev/null 2>&1 ||
  ! entry_ok "$backup_temp" || ! cmp -s -- "$target" "$backup_temp"; then
  rm -f -- "$backup_temp" >/dev/null 2>&1 || :
  failure
fi
mv -- "$backup_temp" "$backup" >/dev/null 2>&1 || {
  rm -f -- "$backup_temp" >/dev/null 2>&1 || :
  failure
}
entry_ok "$backup" || failure
cmp -s -- "$target" "$backup" || failure

candidate=$(mktemp "$target_dir/.henji.candidate.XXXXXX" 2>/dev/null) || failure
if ! cp -- "$source" "$candidate" >/dev/null 2>&1 || ! chmod 0755 -- "$candidate" >/dev/null 2>&1 ||
  ! entry_ok "$candidate" || ! cmp -s -- "$source" "$candidate"; then
  rm -f -- "$candidate" >/dev/null 2>&1 || :
  failure
fi
mv -- "$candidate" "$target" >/dev/null 2>&1 || {
  rm -f -- "$candidate" >/dev/null 2>&1 || :
  failure
}
entry_ok "$target" || failure
cmp -s -- "$source" "$target" || failure
exit 0
