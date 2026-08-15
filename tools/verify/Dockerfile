# Contract source verification: recompile, compare against deployed bytecode.
#
#   docker build -f tools/verify/Dockerfile -t hearth-verify .
#
# Zero npm dependencies, and the same build-context reasoning as
# `tools/faucet/Dockerfile`: it requires `node/src/crypto/keccak`, so the context
# is the repository root.
FROM node:22-alpine

WORKDIR /app

COPY node/src/crypto ./node/src/crypto
COPY tools/verify/package.json ./tools/verify/package.json
COPY tools/verify/src ./tools/verify/src

# /state MUST be created and chowned while this is still root. `VOLUME` alone
# makes a directory owned by root:root, and the service then dies on its first
# write with `EACCES: permission denied, mkdir '/state/verified'` — a failure
# that reads like a bad mount rather than a bad image. A bind mount from the host
# still needs the host directory to be writable by uid 1000; only an anonymous or
# named volume inherits the ownership set here.
RUN mkdir -p /state && chown node:node /state

USER node

# ── THE SOLC CACHE IS A VOLUME, AND THAT IS NOT AN OPTIMISATION ──────────────
#
# This service compiles with soljson builds fetched from the Solidity team's
# binary server and hash-checked against their signed list (`src/solc.js`). Each
# is ~9 MB. Without a persistent cache every restart re-downloads every compiler
# version anyone has ever asked for, which turns a container restart into minutes
# of egress and makes the service depend on that server being up to answer a
# request it already knows how to answer.
#
# `HEARTH_VERIFY_SOLC_OFFLINE=1` refuses every fetch, for an air-gapped host that
# has had the cache populated by hand.
ENV HEARTH_VERIFY_HOST=0.0.0.0 \
    HEARTH_VERIFY_PORT=9648 \
    HEARTH_VERIFY_DATA=/state/verified \
    HEARTH_VERIFY_SOLC_DIR=/state/solc-cache \
    HEARTH_VERIFY_LOG_FORMAT=json

EXPOSE 9648

# /state holds both the cache and the verified-source store. Losing the latter
# loses every verification anyone has ever submitted.
VOLUME ["/state"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.HEARTH_VERIFY_PORT||9648)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "tools/verify/src/index.js"]
