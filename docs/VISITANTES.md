# Acessos por IP: quem entra, de onde, em que aparelho, o que assiste

Painel: **`https://SEU-RENDER.onrender.com/visitors.html`** (pede a chave). Mostra online agora, visitantes
únicos por dia, quem voltou, países, cidades, aparelhos, provedores e a lista de IPs com o último título pedido.

## Ligar (3 passos)

1. **Criar a tabela no Supabase do fdsFlix** (o mesmo projeto do `SUPABASE_URL` do Render): SQL Editor → cole
   `supabase/visitors-schema.sql` → Run. O servidor também entrega o texto em `/api/visitors/schema`.
2. **Definir a chave de leitura** no Render, em *Environment*: `STATS_KEY=uma-senha-sua`.
   Sem `STATS_KEY` (nem `API_KEY`) a rota `/api/visitors` fica **desligada (403)**: IP nunca fica aberto.
3. Salvar (redeploy) e abrir `/visitors.html`, digitar a chave.

`SUPABASE_URL` e `SUPABASE_SECRET_KEY` já existem por causa do consumo das Vercels; os acessos usam os mesmos.
Sem Supabase o painel funciona, mas só em memória (zera quando o Render reinicia).

## O que conta

Abrir a página (`/`), buscar/listar (`/api/search`, `/api/popular`...) e pedir vídeo (`/api/stream`).
**Não conta:** bots, health check, rotas internas, IP local/privado (o servidor falando com ele mesmo).
O envio do player (`POST /api/usage`) só marca "online agora" (últimos 5 min), sem somar acesso.

## Variáveis (todas opcionais)

| Variável | Para quê |
|---|---|
| `STATS_KEY` | chave para ler o painel (obrigatória para ver) |
| `GEO_API_URL` | modelo da URL de localização com `{ip}`. Padrão `ipwho.is`. **`off` desliga** |
| `VISITORS_HASH_IP=1` | guarda um hash do IP em vez do IP (a contagem de pessoas continua valendo) |
| `VISITORS_KEEP_DAYS` | dias de histórico no Supabase (padrão 90, mínimo 7) |
| `VISITORS_OFF=1` | desliga a coleta |

## Localização: o que esperar

- Cada **IP novo** é consultado **uma vez** e fica em cache por 7 dias; depois de um reinício, o que já está no
  Supabase não é consultado de novo. A fila faz no máximo ~55 consultas por minuto.
- **Privacidade:** esse IP novo é enviado ao serviço de localização (`ipwho.is`). Para não enviar nada a
  terceiros: `GEO_API_URL=off` (ficam IP, aparelho e contagens, sem lugar).
- É **aproximada**. Em internet móvel a cidade costuma ser a da operadora, não a da pessoa.
- Por que não é offline: a base GeoIP embutida ocupa ~150 MB de disco e leva o processo de 37 para ~185 MB de
  RAM, demais para o Render Free (512 MB, com ffmpeg).

## LGPD

IP é dado pessoal. O painel só abre com chave, linhas com mais de `VISITORS_KEEP_DAYS` dias são apagadas e
`VISITORS_HASH_IP=1` evita guardar o IP. Se o site é público, vale avisar na página que os acessos são medidos.

## Limites

- Só vê quem chega ao servidor do fdsFlix (Render). O vídeo em si sai da Vercel/Wasmer/Worker e não entra aqui.
- `online agora` e a memória valem para esta instância do Render (uma só, no plano grátis).
- O IP vem de `cf-connecting-ip` / `true-client-ip` / `X-Forwarded-For`. Conferir no painel se aparecem IPs
  públicos de verdade; se só aparecer IP interno, o Render não está repassando o cabeçalho.
