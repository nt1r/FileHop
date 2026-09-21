FROM node:24.21.0-bookworm-slim
RUN corepack enable pnpm
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=node:node web/ ./
EXPOSE 5173
CMD ["pnpm", "run", "dev"]
