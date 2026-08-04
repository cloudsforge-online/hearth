# hearthd — reference node container
# Node 22 to match the repo-wide engines pin, digest-pinned so the base can't
# drift under the tag.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /app
# no third-party deps: just copy the source
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY test ./test

# data lives on a volume so the chain persists across restarts. It is created
# here owned by the unprivileged `node` user (uid 1000) the process runs as;
# Docker copies that ownership onto a fresh named volume on first mount. An
# already-populated root-owned /data volume needs a one-off chown to 1000:1000.
ENV HEARTH_DATA=/data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# REST/http + p2p, and the Ethereum JSON-RPC endpoint when HEARTH_EVM=1
# (docs/evm-spec.md §6). 8546 is reserved for the v2 eth_subscribe endpoint and
# is deliberately not exposed.
#
# 8648 is P2P OVER WEBSOCKET (HEARTH_P2P_WS, served at /p2p). It is the only
# gossip port that can be published through a Cloudflare Tunnel, which carries
# HTTP and WebSocket but not raw TCP — see src/params.js. Exposing it costs
# nothing when HEARTH_P2P_WS is unset: nothing binds it.
EXPOSE 8545 8645 8646 8648

USER node
ENTRYPOINT ["node", "bin/hearthd.js"]
