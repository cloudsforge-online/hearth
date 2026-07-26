# syntax=docker/dockerfile:1
# Multi-stage build. Context = repo root (so @cloudsforge/shared is available).
#   docker build -f apps/hearth-site/Dockerfile .
# VITE_ vars are baked in at build time (Vite inlines import.meta.env.*).
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
ARG VITE_NIMBUS_URL
ARG VITE_API_URL
ARG VITE_PAY_URL
ARG VITE_KEYVAULT_URL
ARG VITE_PLAY_URL
ARG VITE_STUDIO_URL
ENV VITE_NIMBUS_URL=$VITE_NIMBUS_URL VITE_API_URL=$VITE_API_URL VITE_PAY_URL=$VITE_PAY_URL VITE_KEYVAULT_URL=$VITE_KEYVAULT_URL VITE_PLAY_URL=$VITE_PLAY_URL VITE_STUDIO_URL=$VITE_STUDIO_URL
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store,sharing=locked pnpm install --frozen-lockfile --config.store-dir=/pnpm-store --filter @cloudsforge/hearth-site...
WORKDIR /repo/apps/hearth-site
RUN pnpm build

FROM nginx:alpine
COPY apps/hearth-site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/hearth-site/dist /usr/share/nginx/html
EXPOSE 80
