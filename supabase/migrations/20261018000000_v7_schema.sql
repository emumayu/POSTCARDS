-- POSTCARDS v7 schema: customers, purchases, trips, access_keys, stripe_events + DB functions.
-- Everything is reached by Netlify Functions with the secret (service_role) key only.
-- RLS is enabled on every table with NO policies, and the functions below are not executable
-- by anon / authenticated, so the public API (anon key) cannot read or change anything.
-- Safe to run on the current database: all tables are empty.

-- ---------------------------------------------------------------- helpers
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------- customers
-- One row per buyer, keyed by lower-cased e-mail (guest checkout, no login).
-- user_id is filled in later, when My Page / Supabase Auth is added (match by e-mail).
create table if not exists public.customers (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null unique check (email = lower(email)),
  stripe_customer_ids text[] not null default '{}',
  user_id             uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table public.customers enable row level security;
drop trigger if exists customers_updated_at on public.customers;
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- purchases
alter table public.purchases
  add column if not exists customer_id            uuid references public.customers(id),
  add column if not exists stripe_customer_id     text,
  add column if not exists email                  text,
  add column if not exists city                   text,
  add column if not exists region                 text,
  add column if not exists days                   integer,
  add column if not exists price_id               text,
  add column if not exists amount_subtotal        integer,
  add column if not exists amount_total           integer,
  add column if not exists amount_refunded        integer not null default 0,
  add column if not exists currency               text,
  add column if not exists livemode               boolean,
  add column if not exists stripe_payment_intent  text,
  add column if not exists payment_method_type    text,
  add column if not exists paid_at                timestamptz,
  add column if not exists refunded_at            timestamptz,
  add column if not exists status_checked_at      timestamptz,
  add column if not exists receipt_sent_at        timestamptz;   -- for the Resend e-mail (later)

alter table public.purchases
  drop constraint if exists purchases_plan_type_check,
  add  constraint purchases_plan_type_check check (plan_type in ('day','full','list')),
  drop constraint if exists purchases_status_check,
  add  constraint purchases_status_check
    check (status in ('pending','paid','failed','partially_refunded','refunded')),
  drop constraint if exists purchases_region_check,
  add  constraint purchases_region_check check (region is null or region in ('jp','intl'));

create index if not exists purchases_customer_idx on public.purchases(customer_id);
create index if not exists purchases_email_idx    on public.purchases(email);
create index if not exists purchases_pi_idx       on public.purchases(stripe_payment_intent);

-- purchases_guard: the status only moves forward (pending < failed/paid < partially_refunded < refunded),
-- so a late "paid" event can never undo a refund; paid_at keeps the first value;
-- e-mail / customer links are never erased by a later write that doesn't have them.
create or replace function public.purchases_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  rank_old int; rank_new int;
begin
  rank_old := case old.status when 'pending' then 1 when 'failed' then 2 when 'paid' then 2
              when 'partially_refunded' then 3 when 'refunded' then 4 else 0 end;
  rank_new := case new.status when 'pending' then 1 when 'failed' then 2 when 'paid' then 2
              when 'partially_refunded' then 3 when 'refunded' then 4 else 0 end;
  if rank_new < rank_old then
    new.status          := old.status;
    new.amount_refunded := greatest(coalesce(old.amount_refunded,0), coalesce(new.amount_refunded,0));
    new.refunded_at     := coalesce(old.refunded_at, new.refunded_at);
  end if;
  new.paid_at            := coalesce(old.paid_at, new.paid_at);
  new.email              := coalesce(new.email, old.email);
  new.customer_id        := coalesce(new.customer_id, old.customer_id);
  new.stripe_customer_id := coalesce(new.stripe_customer_id, old.stripe_customer_id);
  new.receipt_sent_at    := coalesce(old.receipt_sent_at, new.receipt_sent_at);
  return new;
end $$;
drop trigger if exists purchases_guard on public.purchases;
create trigger purchases_guard before update on public.purchases
  for each row execute function public.purchases_guard();

-- ---------------------------------------------------------------- trips
alter table public.trips
  alter column user_id drop not null,
  add column if not exists city      text,
  add column if not exists plan_type text,
  add column if not exists days      integer,
  add column if not exists traveler  text,
  add column if not exists tags      text[] not null default '{}',
  add column if not exists version   integer not null default 1;
create unique index if not exists trips_purchase_uidx on public.trips(purchase_id);
drop trigger if exists trips_updated_at on public.trips;
create trigger trips_updated_at before update on public.trips
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- access_keys
-- Device keys. Only the SHA-256 of the key is stored; the raw key lives in the buyer's browser.
create table if not exists public.access_keys (
  id           uuid primary key default gen_random_uuid(),
  purchase_id  uuid not null references public.purchases(id) on delete cascade,
  key_hash     text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '1 year',
  last_used_at timestamptz,
  revoked_at   timestamptz
);
alter table public.access_keys enable row level security;
create index if not exists access_keys_purchase_idx on public.access_keys(purchase_id);

-- ---------------------------------------------------------------- stripe_events
alter table public.stripe_events
  add column if not exists status         text not null default 'processing',
  add column if not exists error          text,
  add column if not exists session_id     text,
  add column if not exists payment_intent text,
  add column if not exists claimed_at     timestamptz not null default now();
alter table public.stripe_events alter column processed_at drop not null;
alter table public.stripe_events alter column processed_at drop default;
alter table public.stripe_events
  drop constraint if exists stripe_events_status_check,
  add  constraint stripe_events_status_check check (status in ('processing','done','failed'));

-- ---------------------------------------------------------------- functions
-- upsert_customer: find-or-create the customer by e-mail and remember the Stripe customer id.
create or replace function public.upsert_customer(p_email text, p_stripe_customer_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  if p_email is null or btrim(p_email) = '' then return null; end if;
  insert into public.customers(email, stripe_customer_ids)
  values (lower(btrim(p_email)), case when p_stripe_customer_id is null then '{}' else array[p_stripe_customer_id] end)
  on conflict (email) do update
    set stripe_customer_ids = case
      when p_stripe_customer_id is null or p_stripe_customer_id = any(public.customers.stripe_customer_ids)
        then public.customers.stripe_customer_ids
      else array_append(public.customers.stripe_customer_ids, p_stripe_customer_id) end
  returning id into cid;
  return cid;
end $$;

-- check_device_key: purchase id for a valid, unexpired, unrevoked key whose purchase is 'paid'.
create or replace function public.check_device_key(p_key_hash text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare pid uuid; kid uuid;
begin
  select k.id, k.purchase_id into kid, pid
  from public.access_keys k join public.purchases p on p.id = k.purchase_id
  where k.key_hash = p_key_hash and k.revoked_at is null and k.expires_at > now() and p.status = 'paid';
  if kid is null then return null; end if;
  update public.access_keys set last_used_at = now() where id = kid;
  return pid;
end $$;

-- issue_checkout_key: store a new key for a paid purchase. Returns the key id, or NULL when not allowed:
--   * the purchase is not paid, or
--   * it already has a key and the payment is more than 2 hours old (re-issue needs the e-mail link), or
--   * it already has 5 keys.
create or replace function public.issue_checkout_key(p_purchase_id uuid, p_key_hash text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.purchases; n int; kid uuid;
begin
  select * into p from public.purchases where id = p_purchase_id for update;
  if not found or p.status <> 'paid' then return null; end if;
  select count(*) into n from public.access_keys where purchase_id = p_purchase_id;
  if n > 0 and (p.paid_at is null or p.paid_at < now() - interval '2 hours' or n >= 5) then return null; end if;
  insert into public.access_keys(purchase_id, key_hash) values (p_purchase_id, p_key_hash) returning id into kid;
  return kid;
end $$;

-- claim_stripe_event: true = this delivery should be processed; false = already done / in progress.
-- A failed event, or one stuck in 'processing' for more than 5 minutes, can be claimed again.
create or replace function public.claim_stripe_event(p_id text, p_type text, p_session text, p_payment_intent text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare got text;
begin
  insert into public.stripe_events(id, event_type, session_id, payment_intent, status, claimed_at)
  values (p_id, p_type, p_session, p_payment_intent, 'processing', now())
  on conflict (id) do update
    set status = 'processing', claimed_at = now(), error = null
    where public.stripe_events.status = 'failed'
       or (public.stripe_events.status = 'processing' and public.stripe_events.claimed_at < now() - interval '5 minutes')
  returning id into got;
  return got is not null;
end $$;

-- Only the server (service_role) may call these.
revoke all on function public.upsert_customer(text, text)               from public, anon, authenticated;
revoke all on function public.check_device_key(text)                    from public, anon, authenticated;
revoke all on function public.issue_checkout_key(uuid, text)            from public, anon, authenticated;
revoke all on function public.claim_stripe_event(text, text, text, text) from public, anon, authenticated;
revoke all on function public.purchases_guard()                         from public, anon, authenticated;
revoke all on function public.set_updated_at()                          from public, anon, authenticated;
grant execute on function public.upsert_customer(text, text)               to service_role;
grant execute on function public.check_device_key(text)                    to service_role;
grant execute on function public.issue_checkout_key(uuid, text)            to service_role;
grant execute on function public.claim_stripe_event(text, text, text, text) to service_role;
