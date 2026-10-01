#!/bin/sh
set -eu

fail() { printf 'Cube: %s\n' "$*" >&2; exit 1; }
base_url=https://pub-3313f2900e0948b5849dc47c989406ab.r2.dev
install_dir=${HOME:?}/.local/share/cube
bin_dir=$HOME/.local/bin
archive=
sha256=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail "Missing value for $1"
  case "$1" in
    --base-url) base_url=$2 ;;
    --archive) archive=$2 ;;
    --sha256) sha256=$2 ;;
    --install-dir) install_dir=$2 ;;
    --bin-dir) bin_dir=$2 ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift 2
done
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=linux-x64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  Darwin-x86_64) target=darwin-x64 ;;
  *) fail 'Supported: Linux/WSL x64 and macOS arm64/x64.' ;;
esac
case "$install_dir" in /*) ;; *) fail 'Use an absolute --install-dir.' ;; esac
case "$bin_dir" in /*) ;; *) fail 'Use an absolute --bin-dir.' ;; esac
mkdir -p "$install_dir" "$bin_dir"
install_dir=$(CDPATH= cd -P -- "$install_dir" && pwd)
bin_dir=$(CDPATH= cd -P -- "$bin_dir" && pwd)
[ "$install_dir" != / ] && [ "$install_dir" != "$(CDPATH= cd -P -- "$HOME" && pwd)" ] || fail 'Choose a dedicated Cube installation directory.'
if [ -e "$bin_dir/cube" ] && [ ! -L "$bin_dir/cube" ]; then
  fail "$bin_dir/cube already exists and is not a Cube symlink; it was not overwritten."
fi
if [ -L "$bin_dir/cube" ]; then
  case "$(readlink "$bin_dir/cube")" in
    "$install_dir"/versions/*/cube) ;;
    *) fail "$bin_dir/cube belongs to another installation; it was not overwritten." ;;
  esac
fi
staging=$(mktemp -d "$install_dir/.install-XXXXXXXX")
cleanup() {
  case "$staging" in "$install_dir"/.install-*) rm -rf -- "$staging" ;; esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -z "$archive" ]; then
  case "$base_url" in https://*) ;; *) fail 'Use an HTTPS --base-url.' ;; esac
  base_url=${base_url%/}
  curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 "$base_url/latest-$target.txt" -o "$staging/latest.txt"
  # Validate the exact immutable path before using anything from the manifest.
  read -r sha256 remote_file extra < "$staging/latest.txt" || fail 'Invalid package manifest.'
  [ -z "$extra" ] || fail 'Invalid package manifest.'
  release_version=${remote_file#releases/}
  release_version=${release_version%%/*}
  printf '%s\n' "$release_version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$' || fail 'Invalid release version.'
  expected_file="releases/$release_version/cube-$target.tar.gz"
  [ "$remote_file" = "$expected_file" ] || fail 'Invalid package path.'
  archive=$staging/cube.tar.gz
else
  remote_file=
fi
case "$sha256" in ''|*[!0-9a-f]*) fail 'A lowercase SHA-256 is required.' ;; esac
[ "${#sha256}" -eq 64 ] || fail 'A valid SHA-256 is required.'
if [ -n "$remote_file" ]; then
  curl -fL --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 1800 "$base_url/$remote_file" -o "$archive"
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive")
else
  actual=$(shasum -a 256 "$archive")
fi
[ "${actual%% *}" = "$sha256" ] || fail 'Package checksum mismatch. Existing installation is unchanged.'
mkdir "$staging/package"
tar -xzf "$archive" -C "$staging/package"
package=$staging/package
for required in runtime/node cube app/dist/main.js app/package.json; do
  [ -f "$package/$required" ] || fail "Incomplete package: $required"
done
[ -x "$package/runtime/node" ] && [ -x "$package/cube" ] || fail 'Package executable permissions are missing.'
[ "$("$package/runtime/node" -p 'process.platform + "-" + process.arch')" = "$target" ] || fail 'Package platform does not match this machine.'
version=$(printf '%.16s' "$sha256")
mkdir -p "$install_dir/versions"
destination=$install_dir/versions/$version
if [ ! -e "$destination" ]; then
  mv "$package" "$destination"
else
  [ -x "$destination/cube" ] && [ -f "$destination/app/dist/main.js" ] || fail "Incomplete existing installation: $destination"
fi
ln -s "$destination/cube" "$staging/cube"
# Rename within the bin filesystem so an upgrade never exposes a partial launcher.
link_dir=$(mktemp -d "$bin_dir/.cube-link-XXXXXXXX")
mv "$staging/cube" "$link_dir/cube"
mv -f "$link_dir/cube" "$bin_dir/cube"
rmdir "$link_dir"
printf 'Cube installed: %s/cube\nExisting ~/.cube data was not changed.\n' "$bin_dir"
case ":$PATH:" in
  *":$bin_dir:"*) printf 'Run cube from your project directory.\n' ;;
  *) printf 'Add %s to PATH, then run cube from your project directory.\n' "$bin_dir" ;;
esac
