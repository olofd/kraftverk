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

# Every node_modules npm made — the root's, and a workspace's own (the app's) —
# not those inside them. Under a name no other job has (each job is its own
# container, its process ids alike: $$ was the same in all of them), and
# never failing the job: the install is done; the archive only spares the next.
mkdir -p "$DIR"
if part=$(mktemp "$DIR/$key.tar.XXXXXX") &&
  find . -name node_modules -type d -prune -not -path './node_modules/*' -print | tar -cf "$part" -T - &&
  mv "$part" "$archive"; then
  echo "node_modules archived for the next job ($key)"
else
  rm -f "${part:-}"
  echo "node_modules could not be archived; the next job installs afresh"
fi

# The newest few, and nothing left half written by a job that stopped.
ls -t "$DIR"/*.tar 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
find "$DIR" -name '*.tar.*' -mmin +60 -delete 2>/dev/null || true
