# fdsFlix · torrent kit (teste)

Motor de busca de torrents que alimenta a aba **Torrents**, dentro de **Outras fontes** no admin.
Só admin; nada disto aparece para o visitante.

## Uso

```bash
node torrent.js "Matrix" --year=1999
node torrent.js "Dragon Ball Z"
```

Saída: por resultado, `[áudio/qualidade] seeds título` e o `magnet:` (ou o `.torrent`).

## Fontes (medidas em 2026-11-18)

- **apibay** (The Pirate Bay, JSON) — 200 (a query precisa ser minúscula)
- **YTS** (API JSON) — 200
- **Rede Torrent / ComandoFilmes / Pirateiro / TorrentDosFilmes** (PT-BR, HTML) — 200
- **1337x** — 403 Cloudflare do datacenter (o motor pula e anota)

## Regras

- **Dublado PT-BR primeiro**, depois dual e original.
- Rejeita CAM/TS/screener/sample/trailer.
- Título + ano, com o mesmo rigor do `/api/stream` (não casa upload de outro filme).
- Ordena por (PT-BR, ano, seeds, qualidade).

## Legal

A responsabilidade por verificar a legitimidade dos arquivos e a legalidade do download é do usuário.
Use um bloqueador de anúncios e, se fizer sentido para você, uma VPN.
