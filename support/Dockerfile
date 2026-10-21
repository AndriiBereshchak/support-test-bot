# syntax=docker/dockerfile:1

# ─── prod-deps ─────────────────────────────────────────────
FROM ghcr.io/binodex/node-base:20-bookworm AS prod-deps
WORKDIR /workspace

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases

# Every workspace manifest, not just ours: yarn resolves the whole graph from
# the single root lockfile and errors out if one is missing.
COPY admin/package.json admin/
COPY auth/package.json auth/
COPY affiliate/package.json affiliate/
COPY coins/package.json coins/
COPY exchange/package.json exchange/
COPY mail/package.json mail/
COPY predict/package.json predict/
COPY support/package.json support/
COPY shared/package.json shared/
COPY trade-math/package.json trade-math/

RUN corepack enable
RUN --mount=type=cache,id=yarn-root,target=/root/.yarn \
    YARN_CACHE_FOLDER=/root/.yarn yarn workspaces focus --production @binodex/support @binodex/shared

# ─── builder ───────────────────────────────────────────────
FROM ghcr.io/binodex/node-base:20-bookworm AS builder
WORKDIR /workspace

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases

COPY admin/package.json admin/
COPY auth/package.json auth/
COPY affiliate/package.json affiliate/
COPY coins/package.json coins/
COPY exchange/package.json exchange/
COPY mail/package.json mail/
COPY predict/package.json predict/
COPY support/package.json support/
COPY shared/package.json shared/
COPY trade-math/package.json trade-math/

RUN corepack enable
RUN --mount=type=cache,id=yarn-root,target=/root/.yarn \
    YARN_CACHE_FOLDER=/root/.yarn yarn workspaces focus @binodex/support @binodex/shared

# Build @binodex/shared first — support imports its compiled JS+d.ts.
COPY shared /workspace/shared
RUN cd /workspace/shared && yarn build

COPY support /workspace/support
# Schema only — support reads the exchange database through a generated client
# but never compiles a line of exchange code.
COPY exchange/prisma /workspace/exchange/prisma
# Same deal for the affiliate schema: the operator bot reads the partner
# table (existence check + the partner line on a user card), nothing else.
COPY affiliate/prisma /workspace/affiliate/prisma

# Load-bearing symlink. The exchange client is generated into
# /workspace/exchange/prisma/generated, and both the generator and the emitted
# client `require('@prisma/client')` relative to THAT directory. Nothing
# installed deps under /workspace/exchange (we only copied a schema), so without
# this the generate step below fails and, at runtime, the import resolves to
# nothing.
RUN mkdir -p /workspace/exchange/node_modules/@prisma && \
    ln -s /workspace/support/node_modules/@prisma/client /workspace/exchange/node_modules/@prisma/client
RUN mkdir -p /workspace/affiliate/node_modules/@prisma && \
    ln -s /workspace/support/node_modules/@prisma/client /workspace/affiliate/node_modules/@prisma/client

# `prisma generate` reads env("DATABASE_*") to validate the datasource block; it
# never connects, so a placeholder is enough and keeps real credentials out of
# the build.
ARG DATABASE_SUPPORT=postgresql://build:build@localhost/build
ARG DATABASE_EXCHANGE=postgresql://build:build@localhost/build
ARG DATABASE_AFFILIATE=postgresql://build:build@localhost/build

WORKDIR /workspace/support
RUN npx prisma generate --schema=prisma/schema.prisma
RUN cd /workspace/exchange && PRISMA_GENERATE_SKIP_AUTOINSTALL=true /workspace/support/node_modules/.bin/prisma generate --schema=prisma/schema.prisma
RUN cd /workspace/affiliate && PRISMA_GENERATE_SKIP_AUTOINSTALL=true /workspace/support/node_modules/.bin/prisma generate --schema=prisma/schema.prisma

RUN yarn build

# ─── runtime ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases
COPY support/package.json support/
COPY shared/package.json shared/

COPY --from=prod-deps /workspace/support/node_modules                support/node_modules

# @binodex/shared carries no runtime deps, so dist + manifest is the whole
# package (the symlink into it lives in support/node_modules, copied above).
COPY --from=builder /workspace/shared/dist                           shared/dist

COPY --from=builder /workspace/support/dist                          support/dist
# Carries both the migrations and the generated support client.
COPY --from=builder /workspace/support/prisma                        support/prisma

# Cross-service generated prisma client consumed at runtime via the tsconfig
# path (@prisma-exchange → ../exchange/prisma/generated/prisma-exchange), which
# path-alias.ts resolves to a sibling of the service directory — hence the
# exchange/ folder has to exist inside the image too.
COPY --from=builder /workspace/exchange/prisma                       exchange/prisma
# Affiliate client, consumed via @prisma-affiliate the same way.
COPY --from=builder /workspace/affiliate/prisma                      affiliate/prisma
# gRPC proto the operator bot loads at runtime (process.cwd()/protos).
COPY --from=builder /workspace/support/protos                        support/protos

# Same symlink the builder needed, for the same reason: the generated exchange
# client requires @prisma/client relative to /workspace/exchange.
RUN mkdir -p /workspace/exchange/node_modules/@prisma && \
    ln -s /workspace/support/node_modules/@prisma/client /workspace/exchange/node_modules/@prisma/client
RUN mkdir -p /workspace/affiliate/node_modules/@prisma && \
    ln -s /workspace/support/node_modules/@prisma/client /workspace/affiliate/node_modules/@prisma/client

# Default SUPPORT_FILES_DIR. Normally a bind/volume mount shared with exchange
# (which serves the bytes); created here so the service still starts when the
# mount is absent, e.g. in a one-off container.
RUN mkdir -p /app/storage/support

WORKDIR /workspace/support
ENV NODE_ENV=production
CMD ["node", "./dist/server.js"]
