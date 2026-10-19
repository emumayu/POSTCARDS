-- Places shown on the site (plan building, FULL LIST, PDF). Edit them in the Supabase Table Editor.
-- Read only by the server (get-places function, service_role); RLS on with no policies, like every other table.
create table public.place_cities (
  city       text primary key,
  intro      text not null default '',
  sort       integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.places (
  id          bigint generated always as identity primary key,
  city        text not null references public.place_cities(city) on update cascade on delete cascade,
  sort        integer not null,                 -- order inside the city (low first)
  name        text not null,
  genre       text not null,                    -- hotel / cafe / restaurant / bakery / shop / museum / architecture / gallery / walk
  area        text not null default '',
  tags        text[] not null default '{}',
  note        text not null default '',
  lat         double precision,
  lng         double precision,
  price       text,                             -- e.g. ¥¥¥
  best        text,
  visit_when  text,                             -- "when" on the site
  visit_order text,                             -- "order" on the site
  pair        text,
  slot        text,                             -- 'half day' / 'full day'
  published   boolean not null default true,    -- false hides the place from the site
  updated_at  timestamptz not null default now()
);
create index places_city_sort_idx on public.places (city, sort);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger places_touch before update on public.places for each row execute function public.touch_updated_at();
create trigger place_cities_touch before update on public.place_cities for each row execute function public.touch_updated_at();

alter table public.places enable row level security;
alter table public.place_cities enable row level security;
revoke all on table public.places, public.place_cities from anon, authenticated;
grant select, insert, update, delete on table public.places, public.place_cities to service_role;
