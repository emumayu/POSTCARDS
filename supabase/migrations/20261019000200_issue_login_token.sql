-- A login link that the SYSTEM sends after an authenticated action (purchase receipt, "itinerary saved" e-mail).
-- Unlike create_login_token (the public "send me a link" form: 3 per 15 minutes per customer, 15 minutes valid),
-- there is no rate limit here — the caller already proved access — and the validity is chosen by the caller
-- (24 hours by default). Same rules otherwise: the customer must exist and have a paid purchase; only the hash is stored.
create or replace function public.issue_login_token(p_email text, p_token_hash text, p_minutes int default 1440)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.customers;
begin
  select * into c from public.customers where email = lower(btrim(p_email));
  if not found then return null; end if;
  if not exists (select 1 from public.purchases where customer_id = c.id and status = 'paid') then return null; end if;
  insert into public.login_tokens(customer_id, token_hash, expires_at)
  values (c.id, p_token_hash, now() + make_interval(mins => greatest(1, least(coalesce(p_minutes, 1440), 10080))));
  return jsonb_build_object('email', c.email);
end $$;
revoke all on function public.issue_login_token(text, text, int) from public, anon, authenticated;
grant execute on function public.issue_login_token(text, text, int) to service_role;
