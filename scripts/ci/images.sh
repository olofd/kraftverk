#!/usr/bin/env bash
#
# Builds both images from the Dockerfile — for linux/amd64, what a NAS or a
# small server runs, whatever this machine is — and loads them into this
# machine's Docker under the two names given.
#
#   scripts/ci/images.sh <server-image> <web-image>
#
# An Apple Silicon Mac builds them emulated: slower, the same images.

set -euo pipefail
cd "$(dirname "$0")/../.."

[ $# -eq 2 ] || { echo "usage: scripts/ci/images.sh <server-image> <web-image>" >&2; exit 2; }

docker buildx build --platform linux/amd64 --target server --tag "$1" --load .
docker buildx build --platform linux/amd64 --target web --tag "$2" --load .
