FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep rsync clang lld libssl-dev pkg-config sqlite3 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/mcp
COPY vendor/package.json vendor/package-lock.json ./
RUN npm ci --include=dev
COPY vendor/tsconfig.json vendor/vitest.config.ts ./
COPY vendor/src ./src
COPY vendor/test ./test
RUN npm run build && npm test
COPY guard.mjs checkpoint.mjs entrypoint.mjs tunnel-runtime.mjs optimized-guard.mjs snapshot-targets.mjs jobs.mjs .
COPY tests ./tests
RUN node --test tests/*.test.mjs
RUN mkdir -p /workspace/code /workspace/wiki /state /backups \
    && REMOTE_DEV_DISPOSABLE_GUARD_TEST=1 node --test tests/optimized-guard.integration.mjs \
    && REMOTE_DEV_RUNTIME_SMOKE=1 node tests/runtime-smoke.mjs \
    && rm -rf /state/jobs /backups/* /workspace/code/* /workspace/wiki/* \
    && chown -R node:node /workspace /state /backups
ENV MCP_HOST=0.0.0.0 MCP_PORT=3000 MCP_DEFAULT_CWD=/workspace MCP_DEFAULT_SHELL=/bin/bash MCP_OAUTH_STATE_FILE=/state/oauth-state.json CARGO_BUILD_JOBS=1
USER node
WORKDIR /workspace
EXPOSE 3000
CMD ["node", "/opt/mcp/entrypoint.mjs"]
