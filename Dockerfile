FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/ packages/
RUN bun install --frozen-lockfile
RUN bun build --target=bun packages/forgejo-mcp/src/main.ts --outfile /app/server.js

FROM oven/bun:1.4.2
WORKDIR /app
RUN mkdir /app/data && chown bun:bun /app/data
COPY --from=build /app/server.js ./server.js
USER bun
ENV MCP_LISTEN_HOST=0.0.0.0 MCP_PORT=3000 MCP_DATABASE_PATH=/app/data/oauth.sqlite
EXPOSE 3000
CMD ["bun", "server.js"]
