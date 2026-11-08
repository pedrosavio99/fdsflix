# Componentes de terceiros

## CinePro Core

- Projeto: <https://github.com/cinepro-org/core>
- Licença: **PolyForm Noncommercial License 1.0.0** (<https://polyformproject.org/licenses/noncommercial/1.0.0>)
- Como é usado: o `Dockerfile` baixa um commit **fixo** (`CINEPRO_REF`) e o compila em
  `/opt/cinepro`; o `lib/cineproRunner.js` o executa como processo separado, escutando só em
  `127.0.0.1`. **O código dele não é copiado para este repositório.**
- Restrição importante: a licença permite uso **sem fins comerciais**. Não use este deploy para
  vender acesso, cobrar assinatura ou monetizar. Se isso mudar, desligue com `CINEPRO_EMBEDDED=0`.
- O próprio projeto avisa que é para uso pessoal/doméstico e que instâncias expostas ao público
  são inseguras por padrão. Por isso o fdsFlix **não expõe** o `/v1/proxy` dele: todo vídeo,
  playlist e legenda sai por rotas com token próprio (`/api/proxy`, `/api/hls-proxy`, `/api/subtitle`).
- Responsabilidade: o usuário responde pelo cumprimento das leis aplicáveis e dos termos de uso
  dos serviços de onde o conteúdo vem.

## Consumet

O repositório `consumet/api.consumet.org` retorna HTTP 403 no GitHub (indisponível). Não há
código dele neste projeto; o adaptador em `lib/fallbackCascade.js` só funciona se você apontar
`CONSUMET_API_BASE` para uma instância que você mesmo opere.
