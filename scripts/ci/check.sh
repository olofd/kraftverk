#!/usr/bin/env bash
#
# The checks, as CI runs them: the dependency rule, types, the tests, the web
# app built the way its container builds it, and the app end to end in a
# browser. The same commands as .github/workflows/ci.yml's validate and e2e.
#
# Run from a clean checkout with Node and npm — the image in ci/Dockerfile has
# them, and Chromium's libraries. scripts/ship.sh runs it there.

set -euo pipefail
cd "$(dirname "$0")/../.."

step() { printf '\n== %s\n' "$1"; }

step 'Dependencies'
npm ci
step 'The architecture'
npm run check:architecture
step 'Types'
npm run typecheck
step 'Tests'
npm test
step 'The app, built for the web'
EXPO_PUBLIC_API_URL=same-origin npm run build:web
step 'The app end to end, in a browser'
# Already in ci/Dockerfile's image; elsewhere, fetched.
npx playwright install chromium
# The build above is the one test:e2e would make.
E2E_SKIP_BUILD=1 npm run test:e2e
