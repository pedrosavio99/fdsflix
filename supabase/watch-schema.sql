-- fdsFlix: o que o público assiste (filmes, séries e canais de TV), agregado por dia.
-- Cole TUDO no Supabase -> SQL Editor -> Run. Pode rodar de novo sem problema (idempotente).
--
-- Uma linha por DIA e por título/canal. NÃO guarda IP nem nada de pessoa: só contagens. O servidor envia em lote
-- (1 chamada a cada ~30 s com novidade), então o custo é mínimo.
--   watches = vezes que alguém começou a assistir (o mesmo aparelho no mesmo título conta 1x a cada 30 min)
--   viewers = aparelhos diferentes no dia (aproximado: se o Render reiniciar no meio do dia, pode contar a mais)

create table if not exists public.watch_daily (
  day        date        not null,                  -- dia em UTC
  kind       text        not null,                  -- 'movie' | 'series' | 'live'
  key        text        not null,                  -- 'm:<tmdb>' | 's:<tmdb>' | 'l:<canal>'
  title      text        not null default '',       -- nome mais recente do título/canal
  watches    integer     not null default 0,
  viewers    integer     not null default 0,
  last_at    timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (day, kind, key)
);

comment on table public.watch_daily is
  'fdsFlix: o que o público assiste, por dia (sem IP). Base para ver os mais assistidos.';

create index if not exists watch_daily_kind_idx on public.watch_daily (kind, day);

-- Só a secret key do servidor (service_role) acessa. Sem policies = ninguém mais lê nem escreve.
alter table public.watch_daily enable row level security;
revoke all on table public.watch_daily from anon, authenticated;

-- Soma atômica em lote: recebe um array JSON [{day,kind,key,title,watches,viewers,last_at}, ...].
create or replace function public.fdsflix_add_watches(p_rows jsonb)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.watch_daily as t (day, kind, key, title, watches, viewers, last_at)
  select (r.day)::date, r.kind, r.key, coalesce(r.title, ''), coalesce(r.watches, 0), coalesce(r.viewers, 0), coalesce(r.last_at, now())
  from jsonb_to_recordset(p_rows) as r(day text, kind text, key text, title text, watches integer, viewers integer, last_at timestamptz)
  on conflict (day, kind, key) do update set
    watches    = t.watches + excluded.watches,
    viewers    = t.viewers + excluded.viewers,
    title      = case when excluded.title <> '' then excluded.title else t.title end,
    last_at    = greatest(t.last_at, excluded.last_at),
    updated_at = now();
$$;

revoke all on function public.fdsflix_add_watches(jsonb) from public, anon, authenticated;
grant execute on function public.fdsflix_add_watches(jsonb) to service_role;

notify pgrst, 'reload schema';
