-- The starting point of the POSTCARDS database (what the first project had before the v7 migration):
-- three tables, RLS on, no policies. A brand-new project needs this first; the later migrations extend it.
create table if not exists public.purchases (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  stripe_session_id text not null unique,
  plan_type         text not null,
  status            text not null default 'pending',
  created_at        timestamptz not null default now()
);
alter table public.purchases enable row level security;

create table if not exists public.trips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  purchase_id uuid references public.purchases(id) on delete set null,
  title       text,
  itinerary   jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.trips enable row level security;

create table if not exists public.stripe_events (
  id           text primary key,
  event_type   text not null,
  processed_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;
