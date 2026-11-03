#!/bin/sh
set -eu
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf '%s\n' 'ReviewSlate: this package supports macOS arm64 only.' >&2
  exit 1
fi
# The bundled Mach-O binary enforces arm64. `uname -m` can report x86_64 when
# the caller runs through Rosetta, even on a compatible Apple Silicon Mac.
if [ ! -x "$plugin_dir/runtime/darwin-arm64/node" ] || [ ! -f "$plugin_dir/server/index.cjs" ]; then
  printf '%s\n' 'ReviewSlate: package is incomplete. Reinstall the package.' >&2
  exit 1
fi
if [ ! -x /usr/bin/git ] || ! /usr/bin/git --version >/dev/null 2>&1; then
  printf '%s\n' 'ReviewSlate: system Git is unavailable. Install Git before opening a repository.' >&2
  exit 1
fi
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_INSPECT_RESUME_ON_START LD_PRELOAD DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
exec "$plugin_dir/runtime/darwin-arm64/node" "$plugin_dir/server/index.cjs"
