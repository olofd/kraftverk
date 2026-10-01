#!/usr/bin/env bash
#
# The image the checks run in (ci/Dockerfile), built on this machine's Docker
# if it is not there yet, and its name printed. Named for what it is made of —
# ci/Dockerfile and the lockfile's Playwright — so it is built only when that
# changes, and an unchanged one needs nothing from a registry.

set -euo pipefail
cd "$(dirname "$0")/../.."

playwright=$(sed -n '/"node_modules\/@playwright\/test": {/{n;s/.*"version": "\([^"]*\)".*/\1/p;q;}' package-lock.json)
[ -n "$playwright" ] || { echo "No @playwright/test in package-lock.json." >&2; exit 1; }
image=kraftverk-ci:$(git hash-object ci/Dockerfile | cut -c1-12)-$playwright

if ! docker image inspect "$image" > /dev/null 2>&1; then
  docker build --quiet --tag "$image" --build-arg "PLAYWRIGHT_VERSION=$playwright" - < ci/Dockerfile > /dev/null
fi
echo "$image"
