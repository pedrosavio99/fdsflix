# Imagem standalone do AdShield Proxy.
# Build: docker build -t adshield adproxy
# Run:   docker run --rm -p 3000:3000 --env-file adproxy/.env adshield
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

USER node

CMD ["node", "server.js"]
