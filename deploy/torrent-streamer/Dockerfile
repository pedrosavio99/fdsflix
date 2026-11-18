FROM node:20-alpine

# ffmpeg: remux de .mkv para MP4 fragmentado (sem re-encode), o Chrome não abre matroska.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
