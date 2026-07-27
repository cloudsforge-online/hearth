# syntax=docker/dockerfile:1
# The explorer / wallet static bundle, baked into nginx.
#   docker build -f web/Dockerfile web
#
# This exists so the stack can be deployed from registry images alone. Compose
# used to bind-mount this directory instead, which meant the "no checkouts
# needed" deploy path silently served an empty directory (nginx 403) on any host
# that had not cloned this repository.
#
# No build step: these are hand-written multi-page static files, and the default
# nginx config serves them correctly.
FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
COPY . /usr/share/nginx/html
EXPOSE 80
