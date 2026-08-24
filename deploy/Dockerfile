# memory-mcp server + memoryctl image (arm64-native on the GX10).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/server/package.json packages/server/
COPY packages/evals/package.json packages/evals/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm -r build

FROM node:22-bookworm-slim
# gitleaks arm64 release binary baked in — scrubbing is fail-closed and
# refuses to ingest without it.
ARG GITLEAKS_VERSION=8.21.2
ADD https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz /tmp/gitleaks.tgz
RUN tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks && rm /tmp/gitleaks.tgz && chmod +x /usr/local/bin/gitleaks
WORKDIR /app
COPY --from=build /app /app
ENV GITLEAKS_PATH=/usr/local/bin/gitleaks
RUN ln -s /app/packages/cli/build/index.js /usr/local/bin/memoryctl
EXPOSE 7105
CMD ["node", "packages/server/build/index.js"]
