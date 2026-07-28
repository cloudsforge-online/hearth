# The faucet has zero npm dependencies, so there is no install step and no
# lockfile to trust. It does require node/src/{crypto,chain} — the tree's own
# vector-tested transaction codec — so the build context is the repository root.
#
#   docker build -f tools/faucet/Dockerfile -t hearth-faucet .
FROM node:22-alpine

WORKDIR /app

# Only what is actually imported. Copying the whole tree would pull node_modules,
# chain data and, in the worst case, a .env someone forgot to clean up.
COPY node/src/crypto ./node/src/crypto
COPY node/src/chain ./node/src/chain
# gas.js pulls in opcodes.js; the set below is exactly the require graph of
# node/src/chain/transaction.js and nothing else.
COPY node/src/evm/gas.js node/src/evm/opcodes.js ./node/src/evm/
COPY node/src/params.js ./node/src/params.js
COPY tools/faucet/package.json ./tools/faucet/package.json
COPY tools/faucet/src ./tools/faucet/src

# Never root, and never with a writable application directory.
USER node

ENV HEARTH_FAUCET_HOST=0.0.0.0 \
    HEARTH_FAUCET_PORT=9646 \
    HEARTH_FAUCET_STATE=/state/faucet-state.json \
    HEARTH_FAUCET_LOG_FORMAT=json

EXPOSE 9646

# There is no key in this image and there must never be one. Mount it:
#   -v /run/secrets/faucet.key:/run/secrets/faucet.key:ro
#   -e HEARTH_FAUCET_KEY_FILE=/run/secrets/faucet.key
#
# And mount /state, or every restart resets every rate limit.
VOLUME ["/state"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.HEARTH_FAUCET_PORT||9646)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "tools/faucet/src/index.js"]
