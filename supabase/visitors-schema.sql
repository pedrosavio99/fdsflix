-- fdsFlix: acessos por visitante (IP), com localização e o que cada um assistiu.
-- Cole TUDO no Supabase -> SQL Editor -> Run. Pode rodar de novo sem problema (idempotente).
--
-- Uma linha por DIA e por visitante. O servidor envia em lote (1 chamada a cada ~30 s com
-- novidade), então o custo é mínimo. `visitor` é o IP (ou um hash dele se VISITORS_HASH_IP=1).
-- IP é dado pessoal (LGPD): o servidor apaga linhas com mais de VISITORS_KEEP_DAYS dias (padrão 90).

create table if not exists public.visitor_daily (
  day         date        not null,                 -- dia em UTC
  visitor     text        not null,                 -- IP, ou "h_..." se VISITORS_HASH_IP=1
  country     text,                                  -- código de 2 letras (BR, US...)
  region      text,                                  -- estado
  city        text,                                  -- cidade (aproximada)
  isp         text,                                  -- provedor de internet
  device      text,                                  -- "Android · Chrome"
  requests    integer     not null default 0,        -- páginas e chamadas da API no dia
  watches     integer     not null default 0,        -- vezes que pediu um vídeo (/api/stream)
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  last_watch  text,                                  -- último título pedido
  updated_at  timestamptz not null default now(),
  primary key (day, visitor)
);

comment on table public.visitor_daily is
  'fdsFlix: visitantes por dia (IP, localização aproximada, dispositivo, o que assistiu).';

create index if not exists visitor_daily_country_idx on public.visitor_daily (day, country);

-- Só a secret key do servidor (service_role) acessa. Sem policies = ninguém mais lê nem escreve.
alter table public.visitor_daily enable row level security;
revoke all on table public.visitor_daily from anon, authenticated;

-- Soma atômica em lote: recebe um array JSON de linhas (uma por dia/visitante).
create or replace function public.fdsflix_add_visits(p_rows jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.visitor_daily as t
    (day, visitor, country, region, city, isp, device, requests, watches, first_at, last_at, last_watch)
  select r.day, r.visitor,
         nullif(r.country, ''), nullif(r.region, ''), nullif(r.city, ''), nullif(r.isp, ''), nullif(r.device, ''),
         coalesce(r.requests, 0), coalesce(r.watches, 0),
         coalesce(r.first_at, now()), coalesce(r.last_at, now()), nullif(r.last_watch, '')
  from jsonb_to_recordset(p_rows) as r(
    day date, visitor text, country text, region text, city text, isp text, device text,
    requests integer, watches integer, first_at timestamptz, last_at timestamptz, last_watch text
  )
  on conflict (day, visitor) do update set
    country    = coalesce(excluded.country, t.country),
    region     = coalesce(excluded.region, t.region),
    city       = coalesce(excluded.city, t.city),
    isp        = coalesce(excluded.isp, t.isp),
    device     = coalesce(excluded.device, t.device),
    requests   = t.requests + excluded.requests,
    watches    = t.watches + excluded.watches,
    first_at   = least(t.first_at, excluded.first_at),
    last_at    = greatest(t.last_at, excluded.last_at),
    last_watch = coalesce(excluded.last_watch, t.last_watch),
    updated_at = now();
$$;

revoke all on function public.fdsflix_add_visits(jsonb) from public, anon, authenticated;
grant execute on function public.fdsflix_add_visits(jsonb) to service_role;

-- Faz o PostgREST enxergar a tabela e a função na hora.
notify pgrst, 'reload schema';
