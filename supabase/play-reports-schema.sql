-- fdsFlix: falhas de reprodução (quais títulos deram erro, por quê) e uso de cada fonte de vídeo.
-- Cole TUDO no Supabase -> SQL Editor -> Run. Pode rodar de novo sem problema (idempotente).
--
-- `visitor` é o mesmo da tabela visitor_daily (IP, ou hash se VISITORS_HASH_IP=1). O servidor apaga sozinho:
-- falhas com mais de 30 dias e uso de fontes com mais de 90 dias.

create table if not exists public.play_errors (
  id          text        primary key,               -- gerado no servidor
  at          timestamptz not null default now(),
  visitor     text        not null default '',
  device      text        not null default '',       -- "Android · Chrome"
  kind        text        not null default 'movie',  -- 'movie' | 'series'
  title_key   text        not null default '',       -- 'movie:<tmdb>' | 'tv:<tmdb>:<t>x<e>'
  tmdb_id     text        not null default '',
  title       text        not null default '',
  season      integer     not null default 0,
  episode     integer     not null default 0,
  stage       text        not null default '',       -- busca | player | espera | troca | rede | torrent
  source      text        not null default '',       -- fonte em uso quando falhou (vazio se nenhuma entregou)
  status      integer     not null default 0,        -- HTTP da busca (404, 503...)
  reason      text        not null default '',
  detail      text        not null default '',
  trace       jsonb       not null default '[]',     -- cada fonte tentada: {p, o, ms, n}
  admin       boolean     not null default false,    -- foi você testando
  resolved_by text        not null default '',       -- fonte que tocou logo depois (vazio = não tocou)
  resolved_at timestamptz
);

create index if not exists play_errors_at_idx on public.play_errors (at desc);

create table if not exists public.play_source_daily (
  day        date        not null,                   -- dia em UTC
  visitor    text        not null,
  source     text        not null,
  delivered  integer     not null default 0,         -- o servidor entregou o link desta fonte
  plays      integer     not null default 0,         -- o vídeo começou a tocar de verdade
  fails      integer     not null default 0,         -- deu problema com esta fonte
  last_at    timestamptz not null default now(),
  primary key (day, visitor, source)
);

-- Só a secret key do servidor (service_role) acessa. Sem policies = ninguém mais lê nem escreve.
alter table public.play_errors enable row level security;
alter table public.play_source_daily enable row level security;
revoke all on table public.play_errors from anon, authenticated;
revoke all on table public.play_source_daily from anon, authenticated;

-- Soma atômica em lote: recebe um array JSON [{day,visitor,source,delivered,plays,fails,last_at}, ...].
create or replace function public.fdsflix_add_source_use(p_rows jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.play_source_daily as t (day, visitor, source, delivered, plays, fails, last_at)
  select (r.day)::date, r.visitor, r.source, coalesce(r.delivered, 0), coalesce(r.plays, 0), coalesce(r.fails, 0), coalesce(r.last_at, now())
  from jsonb_to_recordset(p_rows) as r(day text, visitor text, source text, delivered integer, plays integer, fails integer, last_at timestamptz)
  on conflict (day, visitor, source) do update set
    delivered = t.delivered + excluded.delivered,
    plays     = t.plays + excluded.plays,
    fails     = t.fails + excluded.fails,
    last_at   = greatest(t.last_at, excluded.last_at);
$$;

revoke all on function public.fdsflix_add_source_use(jsonb) from public, anon, authenticated;
grant execute on function public.fdsflix_add_source_use(jsonb) to service_role;

-- Faz o PostgREST enxergar as tabelas e a função na hora.
notify pgrst, 'reload schema';
