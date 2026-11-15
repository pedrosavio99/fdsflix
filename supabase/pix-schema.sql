-- fdsFlix: teste de permissão via Pix (tela do administrador).
-- Cole TUDO no Supabase -> SQL Editor -> Run. Pode rodar de novo sem problema (idempotente).
--
-- pix_charges  uma linha por cobrança gerada, com o APARELHO que pediu (device_id), o nome do aparelho, o visitante (IP/hash),
--              o valor, o estado (pending | paid | expired) e, quando pago, o Message-ID do e-mail do Nubank que confirmou
--              (único: o mesmo e-mail nunca libera duas cobranças).
-- pix_settings configuração salva pela tela (URL do nó do Wasmer e dados do código Pix).

create table if not exists public.pix_charges (
  id            text        primary key,
  device_id     text        not null,
  device        text        not null default '',
  visitor       text        not null default '',
  amount_cents  integer     not null,
  status        text        not null default 'pending',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  paid_at       timestamptz,
  event_at      timestamptz,
  mail_id       text        unique,
  granted_until timestamptz,
  updated_at    timestamptz not null default now()
);

comment on table public.pix_charges is
  'fdsFlix: cobranças Pix de teste por aparelho; paid = o e-mail do Nubank (DKIM ok) chegou com o mesmo valor.';

create index if not exists pix_charges_device_idx on public.pix_charges (device_id, created_at desc);
create index if not exists pix_charges_created_idx on public.pix_charges (created_at desc);

create table if not exists public.pix_settings (
  k          text        primary key,
  v          jsonb       not null,
  updated_at timestamptz not null default now()
);

-- Só a secret key do servidor (service_role) acessa. Sem policies = ninguém mais lê nem escreve.
alter table public.pix_charges enable row level security;
alter table public.pix_settings enable row level security;
revoke all on table public.pix_charges from anon, authenticated;
revoke all on table public.pix_settings from anon, authenticated;

-- Para ver os pagamentos por aparelho:
--   select created_at, device, visitor, amount_cents, status, paid_at, granted_until
--   from public.pix_charges order by created_at desc limit 50;
