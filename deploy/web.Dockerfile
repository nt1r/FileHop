FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY --chown=node:node web/package.json web/package-lock.json ./
RUN npm ci
COPY --chown=node:node web/ ./
USER node
EXPOSE 5173
CMD ["npm", "run", "dev"]
