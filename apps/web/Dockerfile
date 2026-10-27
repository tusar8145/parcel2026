# syntax=docker/dockerfile:1.7
# Paira Express web. Build from the repo root:  docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=http://api:4000 .
# API_ORIGIN is baked into the /api proxy at build time.

FROM node:20.19-bookworm-slim AS build
WORKDIR /repo
ENV CI=true NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.npm npm ci -w @delivery-fast/web -w @delivery-fast/shared --include-workspace-root --ignore-scripts
# The website's forms use the same validation rules as the API.
COPY packages/shared packages/shared
RUN npm run build -w @delivery-fast/shared
COPY apps/web apps/web
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=${API_ORIGIN}
RUN npm run vendor -w @delivery-fast/web && npm run build -w @delivery-fast/web

FROM node:20.19-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
