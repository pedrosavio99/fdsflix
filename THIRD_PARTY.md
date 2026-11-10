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

## GoAnime (referência para o provedor de anime)

- Projeto: <https://github.com/alvarorichard/GoAnime> — licença **MIT**, © 2023 Krone.
- Uso: apenas como **documentação do contrato** da API do AnimeFire (rotas, campos, ordem de faixas,
  numeração por temporada). `lib/animeFire.js` é uma implementação própria em Node; nenhum código Go foi copiado.
- O AnimeFire é um serviço de terceiros sem relação com este projeto; a API pode mudar a qualquer momento
  e vale o mesmo aviso de responsabilidade do CinePro (cumprir leis e termos de uso aplicáveis).

## @hevcjs/core (decodificador HEVC em WebAssembly, no navegador)

- Projeto: <https://github.com/lid-labs/hevc.js> (pacote npm `@hevcjs/core`, versão 1.7.0) — licença **MIT**
  (conforme o `package.json` do pacote), © 2025 Thibaut Lion. Licença copiada em `public/vendor/hevc/LICENSE-hevcjs`.
- Como é usado: só o **decodificador** já compilado fica copiado em `public/vendor/hevc/`
  (`decoder.js` = o wrapper `HEVCDecoder`, e `wasm/hevc-decode.{js,wasm}`). O restante do pacote
  (o transcodificador HEVC→H.264) **não** é usado. Todo o player (`public/cv/*`: demux, relógio de áudio,
  Worker, desenho em WebGL, controles e legendas) é código próprio deste projeto.
- Por que existe: o decodificador roda no **navegador de quem assiste** (`public/cv/`), então a CPU e os
  bytes da conversão não passam pelo servidor. Funciona em qualquer navegador com WebAssembly, Worker e MediaSource.
- Avisos: (1) o README do pacote não informa a origem do código C do decodificador compilado em `hevc-decode.wasm`;
  confira antes de redistribuir o projeto. (2) O HEVC/H.265 é coberto por pools de patentes, e uma licença MIT
  de código não concede licença dessas patentes (esta nota é nossa). Quem opera o deploy responde por isso.
- Para desligar: remova `public/vendor/hevc/`. O player então cai no caminho antigo (conversão no servidor).

## mp4box.js

- Projeto: <https://github.com/gpac/mp4box.js> (versão 2.5.0) — licença **BSD-3-Clause**, com o aviso em
  `public/vendor/mp4box/LICENSE-mp4box`.
- Como é usado: copiado em `public/vendor/mp4box/` e mapeado por importmap (`mp4box`) em `public/index.html`.
  Lê o índice do MP4, extrai as amostras de vídeo (para o decodificador) e corta o áudio em fragmentos para o MediaSource.
