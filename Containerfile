# Stage 1: build
FROM docker.io/oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# The tj binaries the app hands out at /api/v1/cli, stamped with the same
# identity as the image (see below). After the app build, so Next's file
# tracing never sees them.
ARG TJ_RELEASE=
ARG TJ_COMMIT=
RUN TJ_COMMIT="$TJ_COMMIT" TJ_RELEASE="$TJ_RELEASE" bin/build-cli.sh >/dev/null

# Stage 2: run
FROM docker.io/oven/bun:1-slim AS runner
WORKDIR /app

# Release identity stamped by bin/docker-build.sh: the commit built, and the
# release tag when (and only when) this is a clean build of a tagged revision.
# lib/version/app-version.ts reads these where the image has no git checkout.
ARG TJ_RELEASE=
ARG TJ_COMMIT=
ENV TJ_RELEASE=$TJ_RELEASE
ENV TJ_COMMIT=$TJ_COMMIT

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# Mount your config.yaml here, or override CONFIG_PATH at runtime
ENV CONFIG_PATH=/config/config.yaml

# HuggingFace downloads shell out to the `hf` CLI, Xet-accelerated via
# HF_XET_HIGH_PERFORMANCE (hf-transfer and its HF_HUB_ENABLE_HF_TRANSFER
# knob are deprecated; the modern CLI ignores them and warns).
RUN apt-get update && apt-get install -y curl python3 python3-venv && \
    curl -LsSf https://hf.co/cli/install.sh | bash - && \
    rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:$PATH"
ENV HF_XET_HIGH_PERFORMANCE=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/build/cli ./build/cli

EXPOSE 3000
CMD ["bun", "server.js"]
