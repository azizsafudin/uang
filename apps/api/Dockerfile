FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/api apps/api
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
