# syntax=docker/dockerfile:1
# Build context = THIS directory, not the repo root:
#   docker build -f site/Dockerfile site
# The rest of this repo has no install step and should not acquire one, so the
# site is a self-contained pnpm project. @cloudsforge/ui comes from npm.
#
# No build-time host configuration: nothing here reads import.meta.env.VITE_*.
# Hosts are resolved in the browser at runtime by cloudsforgeHosts(), so the
# same image serves every environment.
FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked pnpm install --frozen-lockfile --config.store-dir=/pnpm-store
RUN pnpm build

FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
