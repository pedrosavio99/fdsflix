FROM node:20-alpine

# ffmpeg: remux de .mkv para MP4 fragmentado (sem re-encode), o Chrome não abre matroska.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# node.config.json é opcional (vem no zip do painel): endereço do fdsFlix + chave para reportar o consumo.
# O glob [n] deixa o arquivo ser opcional; index.js sempre casa, então o COPY nunca fica sem origem.
COPY index.js node.config.jso[n] ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
