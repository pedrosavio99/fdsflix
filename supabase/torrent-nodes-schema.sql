-- fdsFlix: consumo dos nós do streamer de torrent (um nó = uma conta SnapDeploy = um container).
-- Cole TUDO no Supabase -> SQL Editor -> Run. Pode rodar de novo sem problema (idempotente).
--
-- Uma linha por DIA e por nó (~30 linhas por nó por mês): a tabela é minúscula.
-- Quem mede é o PRÓPRIO nó (ele vê todos os bytes que saem), e avisa o servidor do fdsFlix a cada ~2 min.
-- O servidor soma aqui. O ciclo mensal é calculado somando os dias; nada é zerado, o histórico fica.

create table if not exists public.torrent_node_usage_daily (
  day            date    not null,                 -- dia em UTC
  node           text    not null,                 -- URL pública do nó (sem barra no fim)
  egress_bytes   bigint  not null default 0,       -- bytes que SAÍRAM do nó (vídeo para o navegador + upload para peers)
  ingress_bytes  bigint  not null default 0,       -- bytes que ENTRARAM (baixados dos peers do torrent)
  awake_seconds  bigint  not null default 0,       -- segundos com o container ligado (conta nas 100 container-horas/mês)
  streams        integer not null default 0,       -- quantos vídeos foram abertos
  reports        integer not null default 0,       -- quantos envios entraram
  name           text    not null default '',      -- apelido do nó (opcional)
  updated_at     timestamptz not null default now(),
  primary key (day, node)
);

comment on table public.torrent_node_usage_daily is
  'fdsFlix: consumo diário por nó de torrent. egress = banda de saída; awake_seconds = tempo ligado (container-horas).';

-- Só a secret key do servidor (service_role) acessa. Sem policies = ninguém mais lê nem escreve.
alter table public.torrent_node_usage_daily enable row level security;
revoke all on table public.torrent_node_usage_daily from anon, authenticated;

-- Soma atômica (vários envios ao mesmo tempo não se atropelam).
create or replace function public.fdsflix_add_node_usage(
  p_day date, p_node text, p_egress bigint, p_ingress bigint, p_awake bigint, p_streams integer, p_reports integer, p_name text
) returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.torrent_node_usage_daily as t (day, node, egress_bytes, ingress_bytes, awake_seconds, streams, reports, name)
  values (p_day, p_node, p_egress, p_ingress, p_awake, p_streams, p_reports, coalesce(p_name, ''))
  on conflict (day, node) do update set
    egress_bytes  = t.egress_bytes  + excluded.egress_bytes,
    ingress_bytes = t.ingress_bytes + excluded.ingress_bytes,
    awake_seconds = t.awake_seconds + excluded.awake_seconds,
    streams       = t.streams       + excluded.streams,
    reports       = t.reports       + excluded.reports,
    name          = case when excluded.name <> '' then excluded.name else t.name end,
    updated_at    = now();
$$;

revoke all on function public.fdsflix_add_node_usage(date, text, bigint, bigint, bigint, integer, integer, text) from public, anon, authenticated;
grant execute on function public.fdsflix_add_node_usage(date, text, bigint, bigint, bigint, integer, integer, text) to service_role;

-- Faz o PostgREST enxergar a tabela e a função na hora.
notify pgrst, 'reload schema';
