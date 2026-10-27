# syntax=docker/dockerfile:1.7
# Paira Express API. Build from the repo root:  docker build -f apps/api/Dockerfile .

FROM node:20.19-bookworm-slim AS deps
WORKDIR /repo
ENV CI=true PRISMA_HIDE_UPDATE_MESSAGE=1
# Prisma's migration engine links against OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
RUN --mount=type=cache,target=/root/.npm npm ci -w @delivery-fast/shared -w @delivery-fast/api --include-workspace-root

# Build stage; also used to run migrations (it has the Prisma CLI).
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @delivery-fast/shared \
 && npm run db:generate -w @delivery-fast/api \
 && npm run build -w @delivery-fast/api

FROM node:20.19-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production PORT=4000
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,target=/root/.npm npm ci -w @delivery-fast/shared -w @delivery-fast/api --omit=dev --ignore-scripts
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
# Fonts embedded in generated PDFs (Noto Sans + Noto Sans Bengali, OFL).
COPY apps/api/assets apps/api/assets
RUN mkdir -p apps/api/.data/files && chown -R node:node apps/api/.data
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
