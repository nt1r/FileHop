FROM node:24.21.0-bookworm-slim AS build
RUN corepack enable pnpm
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=node:node web/ ./
RUN pnpm run build

# 只交付静态文件；由操作者提取给 Caddy，不启动 Node 或前端服务。
FROM scratch
COPY --from=build /app/dist /web
