#!/bin/sh
# The pipeline's install (docs/CI.md): node_modules as the lockfile says, from
# an archive of the last install with this very lockfile when there is one —
# unpacked in seconds — or from npm ci, whose result is then archived for the
# next job. Kept in npm's cache volume (/root/.npm), named by the lockfile,
# Node and npm: a change to any of them installs afresh. Written under a
# name of its own and renamed when whole, so two jobs archiving at once
# never leave half an archive; the newest few are kept.
set -eu

KEEP=3
DIR=/root/.npm/node-modules
key=$( (cat package-lock.json; node --version; npm --version) | sha256sum | cut -c1-16)
archive="$DIR/$key.tar"

if [ -f "$archive" ]; then
  tar -xf "$archive"
  echo "node_modules from the archive of this lockfile ($key)"
  exit 0
fi

npm ci --prefer-offline --no-audit --no-fund

# Every node_modules npm made — the root's, and a workspace's own (the app's) — not those inside them.
mkdir -p "$DIR"
find . -name node_modules -type d -prune -not -path './node_modules/*' -print >"$DIR/$key.list.$$"
tar -cf "$archive.$$" -T "$DIR/$key.list.$$"
rm -f "$DIR/$key.list.$$"
mv "$archive.$$" "$archive"
echo "node_modules archived for the next job ($key)"

# The newest few, and nothing left half written by a job that stopped.
ls -t "$DIR"/*.tar 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
find "$DIR" -name '*.tar.*' -mmin +60 -delete 2>/dev/null || true
