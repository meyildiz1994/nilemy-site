FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
USER node
ENV DATA_DIR=/data PORT=8080
CMD ["node", "server.mjs"]
