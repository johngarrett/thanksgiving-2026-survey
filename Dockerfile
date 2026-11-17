FROM oven/bun:1.3.8 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run check && bun run build:admin && bun build server/index.ts --target=bun --outdir=dist/server --external express

FROM oven/bun:1.3.8
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATABASE_PATH=/data/thanksgiving.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir /data && chown bun:bun /data
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 3000
CMD ["bun", "dist/server/index.js"]
