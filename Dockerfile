# Single-service image for Uang: builds the React SPA and runs the Bun/Elysia API,
# which serves the built SPA under the same origin (API under /api). Lives at the
# repo root so Railway auto-detects it and always uses the Dockerfile builder.
FROM oven/bun:1
WORKDIR /app

# Install dependencies against the full workspace (lockfile + every package.json),
# so `@uang/shared` and the web build toolchain resolve.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile

# Build the web bundle. No VITE_API_URL is set, so the client targets its own
# origin (window.location.origin) — correct for the single-domain deployment.
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/api apps/api
RUN cd apps/web && bun run build

ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web/dist
ENV PORT=3000
EXPOSE 3000

# The API runs migrations on boot and serves both /api and the SPA.
CMD ["bun", "run", "apps/api/src/index.ts"]
