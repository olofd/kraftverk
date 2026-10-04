# The image kraftverk's pipeline checks run in (.forgejo/workflows/pipeline.yml):
# the Playwright the lockfile pins, with its browser and the browser's system
# libraries; git, which the architecture check asks for the files; and what
# the optional Bluetooth library (@stoprocent/noble) builds with — without it
# npm skips the library, and its types with it. Built once on the server,
# again only when this file changes. Bump with @playwright/test.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update \
  && apt-get install -y --no-install-recommends git build-essential python3 libudev-dev \
  && rm -rf /var/lib/apt/lists/*
