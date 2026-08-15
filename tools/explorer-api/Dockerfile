# The Etherscan-compatible /api shim and the address index behind it.
#
#   docker build -f tools/explorer-api/Dockerfile -t hearth-explorer-api .
#
# Zero npm dependencies, so there is no install step and no lockfile to trust.
# It does require `node/src/crypto/keccak` — the tree's own vector-tested
# implementation — so the build context is the repository root, exactly as
# `tools/faucet/Dockerfile` explains.
FROM node:22-alpine

WORKDIR /app

# Only what is actually imported. Copying the whole tree would pull node_modules,
# chain data and, in the worst case, a .env someone forgot to clean up.
COPY node/src/crypto ./node/src/crypto
COPY tools/explorer-api/package.json ./tools/explorer-api/package.json
COPY tools/explorer-api/src ./tools/explorer-api/src

# /state MUST be created and chowned while this is still root. `VOLUME` alone
# makes a directory owned by root:root, and the service then dies on its first
# write with `EACCES: permission denied, mkdir '/state/explorer-index'` — a
# failure that reads like a bad mount rather than a bad image. A bind mount from
# the host still needs the host directory to be writable by uid 1000; only an
# anonymous or named volume inherits the ownership set here.
RUN mkdir -p /state && chown node:node /state

# Never root, and never with a writable application directory.
USER node

# HOST is 0.0.0.0 because the default 127.0.0.1 is correct for a laptop and
# useless in a container — it would bind an interface nothing outside the
# namespace can reach, and the failure looks like the service being down.
#
# There is NO default for HEARTH_RPC_URL or HEARTH_CHAIN_ID here. Their defaults
# in `src/env.js` are mainnet's, and an image that silently indexes 7411 when it
# was deployed to serve 7412 produces an explorer that is confidently wrong about
# every balance. Compose passes both, per network.
ENV HEARTH_EXPLORER_API_HOST=0.0.0.0 \
    HEARTH_EXPLORER_API_PORT=9647 \
    HEARTH_EXPLORER_API_DATA=/state/explorer-index \
    HEARTH_EXPLORER_API_LOG_FORMAT=json

EXPOSE 9647

# Mount /state, or every restart re-indexes the chain from `startBlock`.
VOLUME ["/state"]

# `/health` reports 200 only while the index is within `maxLagBlocks` of the tip,
# so this is a readiness check and not just a liveness one: a container that has
# fallen behind the chain stops being served rather than answering with stale
# balances.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.HEARTH_EXPLORER_API_PORT||9647)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "tools/explorer-api/src/index.js"]
