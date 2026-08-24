#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly DENO_VERSION='2.9.4'
readonly DENO_ARCHIVE='deno-aarch64-unknown-linux-gnu.zip'
readonly DENO_URL="https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/${DENO_ARCHIVE}"
readonly DENO_ARCHIVE_SHA256='111da5c05c240cfdc4340f234a0e3539d39dbcb6755221f19dcd60bacc8be5aa'
readonly DENO_EXECUTABLE_SHA256='7d87b8a5225485ddea1786024f875b2b3422c31100ba11cb2e36b6125959e218'
readonly MAX_ARCHIVE_BYTES=104857600
readonly MAX_EXECUTABLE_BYTES=209715200

die() {
  printf 'bootstrap-deno-spike2: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

mode_of() {
  stat -c '%a' -- "$1"
}

owner_of() {
  stat -c '%u' -- "$1"
}

validate_directory() {
  local path=$1
  local expected_mode=$2
  local resolved

  [[ -d "$path" && ! -L "$path" ]] || die "unsafe directory: $path"
  [[ $(owner_of "$path") == "$CURRENT_UID" ]] || die "directory owner mismatch: $path"
  [[ $(mode_of "$path") == "$expected_mode" ]] || die "directory mode mismatch: $path"
  resolved=$(realpath -- "$path")
  case "$resolved/" in
    "$PHYSICAL_REPO_ROOT/.tools/"*) ;;
    *) die "directory escapes repository tool root: $path" ;;
  esac
}

ensure_tool_directory() {
  local path=$1
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    if ! mkdir -m 0700 -- "$path" 2>/dev/null; then
      [[ -d "$path" && ! -L "$path" ]] || die "directory creation failed: $path"
    fi
  fi
  validate_directory "$path" 700
}

validate_regular_file() {
  local path=$1
  local expected_mode=$2
  [[ -f "$path" && ! -L "$path" ]] || die "unsafe regular file: $path"
  [[ $(owner_of "$path") == "$CURRENT_UID" ]] || die "file owner mismatch: $path"
  [[ $(mode_of "$path") == "$expected_mode" ]] || die "file mode mismatch: $path"
  case "$(realpath -- "$path")" in
    "$PHYSICAL_REPO_ROOT/.tools/"*) ;;
    *) die "file escapes repository tool root: $path" ;;
  esac
}

cleanup_file() {
  local path=${1:-}
  [[ -n "$path" && ( -e "$path" || -L "$path" ) ]] || return 0
  validate_regular_file "$path" "$(mode_of "$path")"
  unlink -- "$path"
}

cleanup_directory() {
  local path=${1:-}
  [[ -n "$path" && -d "$path" && ! -L "$path" ]] || return 0
  validate_directory "$path" 700
  rmdir -- "$path"
}

ARCHIVE_TEMP=''
EXTRACTED_TEMP=''
INSTALL_TEMP=''
TEMP_DIRECTORY=''
cleanup() {
  local status=$1
  trap - EXIT INT TERM
  cleanup_file "$INSTALL_TEMP" || status=1
  cleanup_file "$EXTRACTED_TEMP" || status=1
  cleanup_file "$ARCHIVE_TEMP" || status=1
  cleanup_directory "$TEMP_DIRECTORY" || status=1
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_command curl
require_command realpath
require_command sha256sum
require_command stat
require_command unzip

[[ $(uname -s) == 'Linux' ]] || die 'unsupported operating system'
[[ $(uname -m) == 'aarch64' ]] || die 'unsupported architecture'

SCRIPT_DIRECTORY=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PHYSICAL_REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIRECTORY/.." && pwd -P)
CURRENT_UID=$(id -u)

[[ -d "$PHYSICAL_REPO_ROOT" && ! -L "$PHYSICAL_REPO_ROOT" ]] || die 'repository root is not a physical directory'
[[ $(owner_of "$PHYSICAL_REPO_ROOT") == "$CURRENT_UID" ]] || die 'repository root owner mismatch'
[[ -f "$PHYSICAL_REPO_ROOT/AGENTS.md" && ! -L "$PHYSICAL_REPO_ROOT/AGENTS.md" ]] || die 'repository marker is missing or unsafe'

TOOLS_DIRECTORY="$PHYSICAL_REPO_ROOT/.tools"
DENO_DIRECTORY="$TOOLS_DIRECTORY/deno"
VERSION_DIRECTORY="$DENO_DIRECTORY/$DENO_VERSION"
CACHE_DIRECTORY="$TOOLS_DIRECTORY/deno-cache"
SPIKE2_CACHE_DIRECTORY="$CACHE_DIRECTORY/spike2"
FINAL_EXECUTABLE="$VERSION_DIRECTORY/deno"

ensure_tool_directory "$TOOLS_DIRECTORY"
ensure_tool_directory "$DENO_DIRECTORY"
ensure_tool_directory "$VERSION_DIRECTORY"
ensure_tool_directory "$CACHE_DIRECTORY"
ensure_tool_directory "$SPIKE2_CACHE_DIRECTORY"

verify_executable() {
  local executable=$1
  local actual_hash version_output
  validate_regular_file "$executable" 700
  actual_hash=$(sha256sum -- "$executable")
  [[ ${actual_hash%% *} == "$DENO_EXECUTABLE_SHA256" ]] || die "Deno executable checksum mismatch: $executable"
  version_output=$($executable --version)
  grep -Fxq 'deno 2.9.4 (stable, release, aarch64-unknown-linux-gnu)' <<<"$version_output" || die 'unexpected Deno version'
  grep -Fxq 'v8 15.0.245.2-rusty' <<<"$version_output" || die 'unexpected V8 version'
  grep -Fxq 'typescript 6.0.3' <<<"$version_output" || die 'unexpected embedded TypeScript version'
}

if [[ -e "$FINAL_EXECUTABLE" || -L "$FINAL_EXECUTABLE" ]]; then
  verify_executable "$FINAL_EXECUTABLE"
  printf '%s\n' "$FINAL_EXECUTABLE"
  exit 0
fi

TEMP_DIRECTORY=$(mktemp -d "$VERSION_DIRECTORY/.bootstrap.XXXXXXXX")
validate_directory "$TEMP_DIRECTORY" 700
ARCHIVE_TEMP="$TEMP_DIRECTORY/$DENO_ARCHIVE"
EXTRACTED_TEMP="$TEMP_DIRECTORY/deno"
INSTALL_TEMP="$VERSION_DIRECTORY/.deno.XXXXXXXX"

header_file="$TEMP_DIRECTORY/headers"
curl --fail --silent --show-error --head --proto '=https' --max-redirs 0 --dump-header "$header_file" --output /dev/null "$DENO_URL" || true
redirect_url=$(sed -n 's/^[Ll]ocation:[[:space:]]*//p' "$header_file" | tr -d '\r' | tail -n 1)
cleanup_file "$header_file"
case "$redirect_url" in
  https://release-assets.githubusercontent.com/*) ;;
  *) die 'release redirect host is not allowlisted' ;;
esac

http_code=$(curl --silent --show-error --proto '=https' --max-redirs 0 --max-filesize "$MAX_ARCHIVE_BYTES" --output "$ARCHIVE_TEMP" --write-out '%{http_code}' "$redirect_url")
[[ "$http_code" == 200 ]] || die "archive download returned HTTP $http_code"
chmod 600 "$ARCHIVE_TEMP"
validate_regular_file "$ARCHIVE_TEMP" 600
[[ $(stat -c '%s' -- "$ARCHIVE_TEMP") -le $MAX_ARCHIVE_BYTES ]] || die 'archive exceeds compressed size limit'
actual_archive_hash=$(sha256sum -- "$ARCHIVE_TEMP")
[[ ${actual_archive_hash%% *} == "$DENO_ARCHIVE_SHA256" ]] || die 'archive checksum mismatch'

mapfile -t members < <(unzip -Z1 "$ARCHIVE_TEMP")
[[ ${#members[@]} -eq 1 && ${members[0]} == deno ]] || die 'archive must contain exactly one deno member'
zip_details=$(unzip -Z -v "$ARCHIVE_TEMP")
grep -Fq 'Unix file attributes (100755 octal):            -rwxr-xr-x' <<<"$zip_details" || die 'archive member is not a regular executable'
uncompressed_size=$(sed -n 's/^  uncompressed size:[[:space:]]*\([0-9][0-9]*\) bytes$/\1/p' <<<"$zip_details")
[[ "$uncompressed_size" =~ ^[0-9]+$ && "$uncompressed_size" -le $MAX_EXECUTABLE_BYTES ]] || die 'executable exceeds uncompressed size limit'

unzip -p "$ARCHIVE_TEMP" deno > "$EXTRACTED_TEMP"
chmod 700 "$EXTRACTED_TEMP"
validate_regular_file "$EXTRACTED_TEMP" 700
[[ $(stat -c '%s' -- "$EXTRACTED_TEMP") == "$uncompressed_size" ]] || die 'extracted executable size mismatch'
verify_executable "$EXTRACTED_TEMP"

INSTALL_TEMP=$(mktemp "$VERSION_DIRECTORY/.deno.XXXXXXXX")
chmod 700 "$INSTALL_TEMP"
cp -- "$EXTRACTED_TEMP" "$INSTALL_TEMP"
chmod 700 "$INSTALL_TEMP"
verify_executable "$INSTALL_TEMP"
if ln -- "$INSTALL_TEMP" "$FINAL_EXECUTABLE" 2>/dev/null; then
  verify_executable "$FINAL_EXECUTABLE"
elif [[ -e "$FINAL_EXECUTABLE" || -L "$FINAL_EXECUTABLE" ]]; then
  verify_executable "$FINAL_EXECUTABLE"
else
  die 'atomic Deno installation failed'
fi

printf '%s\n' "$FINAL_EXECUTABLE"
