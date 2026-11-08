# Backend (Node + ffmpeg) para Railway / Render / Fly.io / VPS.
# A Vercel NÃO deve usar este Dockerfile: lá o frontend é estático.

# --- Estágio 1: baixa e compila o CinePro Core (commit FIXO, não vai para o repositório) ---
# Licença PolyForm Noncommercial: veja THIRD_PARTY.md. Para desligar, defina
# CINEPRO_EMBEDDED=0 (o estágio continua, mas o servidor não sobe o CinePro).
FROM node:22-bookworm-slim AS cinepro
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG CINEPRO_REF=98ba005f75d2675877774f5a676b3bc1c4150c27
WORKDIR /opt/cinepro
RUN git init -q . \
 && git remote add origin https://github.com/cinepro-org/core.git \
 && git fetch -q --depth 1 origin "$CINEPRO_REF" \
 && git checkout -q FETCH_HEAD \
 && npm ci --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && rm -rf .git src

# --- Estágio 2: o fdsFlix ---
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=cinepro /opt/cinepro /opt/cinepro

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
