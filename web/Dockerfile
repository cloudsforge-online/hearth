# syntax=docker/dockerfile:1
# The explorer / wallet static bundle, baked into nginx.
#   docker build -f web/Dockerfile web
#
# This exists so the stack can be deployed from registry images alone. Compose
# used to bind-mount this directory instead, which meant the "no checkouts
# needed" deploy path silently served an empty directory (nginx 403) on any host
# that had not cloned this repository.
#
# No build step: these are hand-written multi-page static files. The bundled
# nginx.conf is only here for the log format and a real 404 — see that file.
FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
COPY . /usr/share/nginx/html

# nginx.conf goes in as a TEMPLATE so the node upstream is deployment config
# rather than a baked-in hostname. The base image runs envsubst over
# /etc/nginx/templates/*.template at boot; NGINX_ENVSUBST_FILTER keeps it to our
# own variables, because without it envsubst would also eat $host, $uri and
# every other nginx runtime variable in the file.
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV NGINX_ENVSUBST_FILTER=HEARTH_
# TWO UPSTREAMS, BECAUSE THE NODE RUNS TWO SERVERS.
#   8645 — REST + SSE: /info, /events, /mining/* (mine.html, assets/api.js)
#   8545 — Ethereum JSON-RPC: every eth_* call the explorer and wallet make
# They are not interchangeable: the REST server answers an eth_* POST with HTTP
# 404 and `{"err":"this is the REST API — the Ethereum JSON-RPC endpoint is a
# different port"}`, which the client reports as MalformedResponse. Both point
# at the same container by default because one node serves both ports.
ENV HEARTH_RPC_UPSTREAM=hearth-testnet-seed:8645
ENV HEARTH_ETH_RPC_UPSTREAM=hearth-testnet-seed:8545
# The chain id this deployment serves, templated into a <meta name="hearth-chain-id">
# by nginx.conf's sub_filter and read by web/assets/chain.js. 7412 is
# hearth-testnet (node/src/params.js CHAIN_IDS); set 7411 for mainnet. It is
# configuration rather than a constant in the bundle because the same image is
# deployed against both, and it is NOT read from the node because a wallet that
# adopts whatever chain id its RPC claims lets a hostile `?rpc=` choose what the
# user signs for.
ENV HEARTH_CHAIN_ID=7412
# The CSP connect-src allowlist. Same-origin covers the proxied node at /rpc
# and /eth-rpc; the Lantern host is where assets/obs.js reports client errors,
# and loopback keeps the documented `?rpc=http://localhost:8545` override
# usable — 8545 is the JSON-RPC port the wallet and explorer speak. Override
# this when deploying under a different apex, or obs.js reports go nowhere.
# Do not simply unset it: envsubst leaves an unset variable in the config
# verbatim, so nginx reads it as one of its own and refuses to start.
ENV HEARTH_CSP_CONNECT="'self' https://lantern.cloudsforge.online http://localhost:* http://127.0.0.1:*"
EXPOSE 80
