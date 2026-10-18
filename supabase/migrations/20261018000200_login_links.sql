-- E-mail login links (no passwords): a buyer asks for a link on MY TRIPS, we mail it (Resend), and opening it
-- gives the browser a device key for every paid purchase of that customer (customers.email).
-- Only the SHA-256 of the link token is stored. Tokens are single use and expire after 15 minutes.

create table if not exists public.login_tokens (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  token_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  used_at     timestamptz
);
alter table public.login_tokens enable row level security;
create index if not exists login_tokens_customer_idx on public.login_tokens(customer_id, created_at desc);
revoke all on table public.login_tokens from anon, authenticated;
grant select, insert, update, delete on table public.login_tokens to service_role;

-- create_login_token: store a token for the customer with this e-mail.
--   returns { "email": ... }  when stored (the caller mails the link),
--   NULL when there is nothing to send (unknown e-mail, no paid purchase) or too many links were asked
--   for recently (3 per 15 minutes per customer). The caller answers the same way in every case.
create or replace function public.create_login_token(p_email text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.customers; n int;
begin
  select * into c from public.customers where email = lower(btrim(p_email));
  if not found then return null; end if;
  if not exists (select 1 from public.purchases where customer_id = c.id and status = 'paid') then return null; end if;
  select count(*) into n from public.login_tokens where customer_id = c.id and created_at > now() - interval '15 minutes';
  if n >= 3 then return null; end if;
  insert into public.login_tokens(customer_id, token_hash) values (c.id, p_token_hash);
  return jsonb_build_object('email', c.email);
end $$;

-- redeem_login_token: consume a valid token and list the customer's paid purchases (newest first, max 30).
-- NULL when the token is unknown, already used or expired.
create or replace function public.redeem_login_token(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  update public.login_tokens set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now()
  returning customer_id into cid;
  if cid is null then return null; end if;
  return jsonb_build_object('customer_id', cid, 'purchases', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.paid_at desc nulls last) from (
      select id, plan_type, days, city, region, currency, amount_total, paid_at, created_at
      from public.purchases where customer_id = cid and status = 'paid'
      order by paid_at desc nulls last limit 30) x), '[]'::jsonb));
end $$;

-- issue_login_keys: p_keys = [{ "purchase_id": uuid, "key_hash": text }]. Only purchases that belong to the
-- customer and are paid get a key. Each purchase keeps its 5 newest active keys. Returns the purchase ids served.
create or replace function public.issue_login_keys(p_customer_id uuid, p_keys jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k jsonb; served uuid[] := '{}';
begin
  for k in select * from jsonb_array_elements(coalesce(p_keys, '[]'::jsonb)) loop
    if exists (select 1 from public.purchases
               where id = (k->>'purchase_id')::uuid and customer_id = p_customer_id and status = 'paid') then
      insert into public.access_keys(purchase_id, key_hash) values ((k->>'purchase_id')::uuid, k->>'key_hash');
      update public.access_keys set revoked_at = now()
       where purchase_id = (k->>'purchase_id')::uuid and revoked_at is null
         and id not in (select id from public.access_keys
                        where purchase_id = (k->>'purchase_id')::uuid and revoked_at is null
                        order by created_at desc limit 5);
      served := served || (k->>'purchase_id')::uuid;
    end if;
  end loop;
  return to_jsonb(served);
end $$;

revoke all on function public.create_login_token(text, text)  from public, anon, authenticated;
revoke all on function public.redeem_login_token(text)        from public, anon, authenticated;
revoke all on function public.issue_login_keys(uuid, jsonb)   from public, anon, authenticated;
grant execute on function public.create_login_token(text, text) to service_role;
grant execute on function public.redeem_login_token(text)       to service_role;
grant execute on function public.issue_login_keys(uuid, jsonb)  to service_role;
