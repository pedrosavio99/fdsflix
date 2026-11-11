-- fdsFlix: histórico de consumo das Vercels (pool do Vidsrc).
-- Cole TUDO no Supabase -> SQL Editor -> Run. Pode rodar de novo sem problema (idempotente).
--
-- Uma linha por DIA e por Vercel (~30 linhas por Vercel por mês): a tabela é minúscula.
-- O ciclo de cota (USAGE_RESET_DAY) é calculado somando os dias; não há "zerar" nada,
-- então o histórico dos meses anteriores fica para as médias e previsões.

create table if not exists public.vercel_usage_daily (
  day            date    not null,                 -- dia em UTC
  base           text    not null,                 -- URL da Vercel (sem barra no fim)
  measured_bytes bigint  not null default 0,       -- bytes medidos pelos navegadores (hls.js)
  adjust_bytes   bigint  not null default 0,       -- acertos de calibração com o painel da Vercel (pode ser negativo)
  seconds        bigint  not null default 0,       -- segundos de vídeo entregues (para GB por hora)
  reports        integer not null default 0,       -- quantos envios entraram
  updated_at     timestamptz not null default now(),
  primary key (day, base)
);

comment on table public.vercel_usage_daily is
  'fdsFlix: consumo diário por Vercel. usado = measured_bytes + adjust_bytes; médias usam só measured_bytes.';

-- Só a secret key do servidor (service_role) acessa. Sem policies = ninguém mais lê nem escreve.
alter table public.vercel_usage_daily enable row level security;
revoke all on table public.vercel_usage_daily from anon, authenticated;

-- Soma atômica (vários envios ao mesmo tempo não se atropelam).
create or replace function public.fdsflix_add_usage(
  p_day date, p_base text, p_measured bigint, p_adjust bigint, p_seconds bigint, p_reports integer
) returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.vercel_usage_daily as t (day, base, measured_bytes, adjust_bytes, seconds, reports)
  values (p_day, p_base, p_measured, p_adjust, p_seconds, p_reports)
  on conflict (day, base) do update set
    measured_bytes = t.measured_bytes + excluded.measured_bytes,
    adjust_bytes   = t.adjust_bytes   + excluded.adjust_bytes,
    seconds        = t.seconds        + excluded.seconds,
    reports        = t.reports        + excluded.reports,
    updated_at     = now();
$$;

revoke all on function public.fdsflix_add_usage(date, text, bigint, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.fdsflix_add_usage(date, text, bigint, bigint, bigint, integer) to service_role;

-- Faz o PostgREST enxergar a tabela e a função na hora.
notify pgrst, 'reload schema';
