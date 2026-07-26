# hearthd — reference node container
FROM node:20-alpine

WORKDIR /app
# no third-party deps: just copy the source
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY test ./test

# data lives on a volume so the chain persists across restarts
ENV HEARTH_DATA=/data
RUN mkdir -p /data
VOLUME ["/data"]

# rpc/http + p2p
EXPOSE 8645 8646

ENTRYPOINT ["node", "bin/hearthd.js"]
